import { and, asc, eq, gte, inArray, isNull, lte, ne } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, checkArbZG, computeTimeBalance, dailyTargetMinutes, holidayName, minimalCompliantBreak, weekdayIndex, type Region } from '@openpers/shared';
import type { Exec } from '../../db';
import { absencePeriods, absenceTypes, attendancePeriods, company, projects } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, emit, type AppContext, type OpenPersModule } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { breakdownFor, customHolidaysFor } from '../absence/service';
import { currentEmployment, isoDateSchema, regionOf, schedulesOf } from '../people/service';

type Attendance = typeof attendancePeriods.$inferSelect;

const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'Expected local date-time YYYY-MM-DDTHH:mm[:ss]');

export interface TimeSettings {
  approvalRequired: boolean;
  /** Employees cannot change entries older than this many days (null = never locked). */
  lockAfterDays: number | null;
  /** Raise recorded breaks to the statutory minimum (ArbZG §4) when saving a day. */
  autoDeductBreaks: boolean;
}
const DEFAULT_SETTINGS: TimeSettings = { approvalRequired: false, lockAfterDays: null, autoDeductBreaks: false };

const LOCATIONS = ['office', 'remote', 'on_site'] as const;
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm');

/** Normalizes DB timestamps (`2026-01-01 08:00:00`) to `2026-01-01T08:00:00`. */
const norm = (v: string | null) => (v ? v.replace(' ', 'T').slice(0, 19) : null);
const withSeconds = (v: string) => (v.length === 16 ? `${v}:00` : v);
const minutesBetween = (a: string, b: string) => (Date.parse(`${b}Z`) - Date.parse(`${a}Z`)) / 60_000;

/** Current local date-time in the given IANA timezone. */
export function nowLocal(timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Worked and break minutes of one day's periods (break = gaps between work + recorded breaks). */
export function summarizeDay(periods: { type: string; startAt: string | null; endAt: string | null; status: string; breakMinutes: number }[]) {
  const work = periods.filter((r) => r.type === 'WORK' && r.endAt && r.status !== 'rejected').sort((a, b) => a.startAt!.localeCompare(b.startAt!));
  const recorded = work.reduce((t, r) => t + r.breakMinutes, 0);
  const workedMinutes = work.reduce((t, r) => t + minutesBetween(r.startAt!, r.endAt!), 0) - recorded;
  let gaps = 0;
  for (let i = 1; i < work.length; i++) gaps += Math.max(0, minutesBetween(work[i - 1].endAt!, work[i].startAt!));
  return { workedMinutes, breakMinutes: gaps + recorded };
}

export const timeModule: OpenPersModule = {
  name: 'time',
  register(app, ctx: AppContext) {
    const { db, authz } = ctx;
    const route = makeRoute(app, ctx.registry);

    ctx.exporters.attendance = async (x: Exec, personId: string) => x.select().from(attendancePeriods).where(eq(attendancePeriods.personId, personId));

    async function settings(): Promise<TimeSettings & { timezone: string }> {
      const [c] = await db.select().from(company).limit(1);
      return { ...DEFAULT_SETTINGS, ...((c?.settings as any)?.time ?? {}), timezone: c?.timezone ?? 'Europe/Berlin' };
    }

    const view = (a: Attendance) => ({ ...a, startAt: norm(a.startAt), endAt: norm(a.endAt) });

    async function load(id: string) {
      const [a] = await db.select().from(attendancePeriods).where(eq(attendancePeriods.id, id));
      if (!a) throw notFound('Attendance period not found');
      return a;
    }

    async function assertWrite(user: Principal, personId: string, existing?: Attendance) {
      if (await authz.can(user, 'time.manage', personId)) return;
      if (personId !== user.personId || !authz.has(user, 'time.track')) throw forbidden('Not allowed to track time for this person');
      if (existing) {
        const s = await settings();
        if (existing.status === 'approved' && s.approvalRequired) throw forbidden('Approved entries can only be changed by HR');
        if (s.lockAfterDays !== null && existing.date < addDays(new Date().toISOString().slice(0, 10), -s.lockAfterDays)) throw forbidden('This entry is locked');
      }
    }

    async function dayPeriods(personId: string, date: string, excludeId?: string) {
      const rows = await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), gte(attendancePeriods.date, addDays(date, -1)), lte(attendancePeriods.date, addDays(date, 1)), ne(attendancePeriods.status, 'rejected')));
      return rows.filter((r) => r.id !== excludeId).map(view);
    }

    function overlaps(a: { startAt: string; endAt: string | null }, b: { startAt: string | null; endAt: string | null }) {
      const aEnd = a.endAt ?? '9999-12-31T00:00:00';
      const bEnd = b.endAt ?? '9999-12-31T00:00:00';
      return a.startAt < bEnd && b.startAt! < aEnd;
    }

    async function validate(personId: string, data: { type: string; startAt: string; endAt: string | null; projectId?: string | null }, excludeId?: string) {
      if (data.endAt && data.endAt <= data.startAt) throw unprocessable('Invalid range', [{ path: 'endAt', message: 'End must be after start' }]);
      if (data.endAt && minutesBetween(data.startAt, data.endAt) > 24 * 60) throw unprocessable('Too long', [{ path: 'endAt', message: 'A period cannot exceed 24 hours' }]);
      if (data.type === 'BREAK' && data.projectId) throw unprocessable('Breaks cannot have a project', [{ path: 'projectId', message: 'Breaks cannot be booked on projects' }]);
      if (data.projectId) {
        const [p] = await db.select().from(projects).where(eq(projects.id, data.projectId));
        if (!p || p.status !== 'ACTIVE') throw unprocessable('Invalid project', [{ path: 'projectId', message: 'Project must exist and be active' }]);
      }
      const clash = (await dayPeriods(personId, data.startAt.slice(0, 10), excludeId)).find((o) => overlaps(data, o));
      if (clash) throw conflict('Overlaps with an existing period', { conflictingId: clash.id });
    }

    async function warningsFor(personId: string, date: string) {
      const periods = await dayPeriods(personId, date);
      const work = periods.filter((p) => p.type === 'WORK' && p.date === date && p.endAt).map((p) => ({ start: p.startAt!, end: p.endAt!, breakMinutes: p.breakMinutes }));
      const prev = periods.filter((p) => p.type === 'WORK' && p.date === addDays(date, -1) && p.endAt).map((p) => p.endAt!).sort().pop();
      return checkArbZG(work, prev);
    }

    // ---------- Settings ----------
    route({ method: 'GET', url: '/api/v1/time-settings', tag: 'time', summary: 'Time tracking settings' }, async () => {
      const { timezone: _, ...s } = await settings();
      return s;
    });
    route(
      { method: 'PATCH', url: '/api/v1/time-settings', perm: 'time.manage', tag: 'time', summary: 'Update time tracking settings', body: z.object({ approvalRequired: z.boolean().optional(), lockAfterDays: z.number().int().min(1).max(365).nullable().optional(), autoDeductBreaks: z.boolean().optional() }) },
      async ({ user, body }) => {
        const [c] = await db.select().from(company).limit(1);
        const current = ((c.settings as any)?.time ?? {}) as Partial<TimeSettings>;
        const next = { ...DEFAULT_SETTINGS, ...current, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) };
        await db.update(company).set({ settings: { ...c.settings, time: next } }).where(eq(company.id, c.id));
        await audit(db, user.userId, 'company', c.id, 'time_settings', body);
        return next;
      },
    );

    // ---------- Projects ----------
    const projectBody = z.object({ name: z.string().min(1).max(200), code: z.string().max(50).nullish(), status: z.enum(['ACTIVE', 'ARCHIVED']).default('ACTIVE') });
    route({ method: 'GET', url: '/api/v1/projects', tag: 'time', summary: 'List projects' }, async () => ({ items: await db.select().from(projects).orderBy(asc(projects.name)) }));
    route({ method: 'POST', url: '/api/v1/projects', perm: 'time.manage', tag: 'time', summary: 'Create project', body: projectBody }, async ({ user, body }, reply) => {
      const [p] = await db.insert(projects).values(body).returning();
      await audit(db, user.userId, 'project', p.id, 'create', body);
      reply.code(201);
      return p;
    });
    route({ method: 'PATCH', url: '/api/v1/projects/:id', perm: 'time.manage', tag: 'time', summary: 'Update project', body: projectBody.partial() }, async ({ user, body, params }) => {
      const [p] = await db.update(projects).set(body).where(eq(projects.id, params.id)).returning();
      if (!p) throw notFound();
      await audit(db, user.userId, 'project', p.id, 'update', body);
      return p;
    });

    // ---------- Attendance ----------
    route(
      { method: 'GET', url: '/api/v1/attendance', tag: 'time', summary: 'Attendance periods with daily summaries', query: z.object({ personId: z.string().uuid().optional(), from: isoDateSchema, to: isoDateSchema }) },
      async ({ user, query }) => {
        const personId = query.personId ?? user.personId;
        if (!personId) throw unprocessable('personId required', [{ path: 'personId', message: 'Required' }]);
        await authz.assert(user, 'time.read', personId);
        const rows = (await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), gte(attendancePeriods.date, query.from), lte(attendancePeriods.date, query.to))).orderBy(asc(attendancePeriods.startAt))).map(view);
        const dates = [...new Set(rows.map((r) => r.date))].sort();
        const days = await Promise.all(
          dates.map(async (date) => {
            const { workedMinutes, breakMinutes } = summarizeDay(rows.filter((r) => r.date === date));
            return { date, workedMinutes, breakMinutes, warnings: await warningsFor(personId, date) };
          }),
        );
        return { items: rows, days };
      },
    );

    // ---------- Monthly list (one row per day, inline editing) ----------

    /** Approved absences of a person per day: fraction of the scheduled day and type. */
    async function absencesByDay(personId: string, from: string, to: string) {
      const rows = await db
        .select({ p: absencePeriods, t: absenceTypes })
        .from(absencePeriods)
        .innerJoin(absenceTypes, eq(absenceTypes.id, absencePeriods.typeId))
        .where(and(eq(absencePeriods.personId, personId), eq(absencePeriods.status, 'approved'), lte(absencePeriods.startDate, to)));
      const out = new Map<string, { fraction: number; typeName: string; color: string }>();
      for (const { p, t } of rows) {
        if (p.endDate && p.endDate < from) continue;
        for (const d of await breakdownFor(db, p, t)) {
          if (d.date < from || d.date > to) continue;
          const half = (p.startHalf && d.date === p.startDate) || (p.endHalf && d.date === p.endDate);
          const fraction = t.unit === 'DAY' ? (half ? 0.5 : 1) : d.scheduledHours ? Math.min(1, d.amount / d.scheduledHours) : 1;
          const prev = out.get(d.date);
          out.set(d.date, { fraction: Math.min(1, (prev?.fraction ?? 0) + fraction), typeName: t.name, color: t.color });
        }
      }
      return out;
    }

    route(
      { method: 'GET', url: '/api/v1/attendance/month', tag: 'time', summary: 'Month view: one row per day with target, actual and difference', query: z.object({ personId: z.string().uuid().optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) },
      async ({ user, query }) => {
        const personId = query.personId ?? user.personId;
        if (!personId) throw unprocessable('personId required', [{ path: 'personId', message: 'Required' }]);
        await authz.assert(user, 'time.read', personId);
        const from = `${query.month}-01`;
        const to = addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1);
        const region = (await regionOf(db, personId, from)) as Region;
        const [schedules, customHolidays, absences, periods] = await Promise.all([
          schedulesOf(db, personId),
          customHolidaysFor(db, region, from, to),
          absencesByDay(personId, from, to),
          db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), gte(attendancePeriods.date, addDays(from, -1)), lte(attendancePeriods.date, to))).orderBy(asc(attendancePeriods.startAt)),
        ]);
        const rows = periods.map(view);
        const absenceList = [...absences].map(([date, a]) => ({ date, fraction: a.fraction }));
        const days = [];
        for (let date = from; date <= to; date = addDays(date, 1)) {
          const own = rows.filter((r) => r.date === date && r.status !== 'rejected');
          const work = own.filter((r) => r.type === 'WORK').sort((a, b) => a.startAt!.localeCompare(b.startAt!));
          const { workedMinutes, breakMinutes } = summarizeDay(own);
          const holiday = customHolidays.find((h) => h.date === date)?.name ?? holidayName(date, region) ?? null;
          const targetMinutes = dailyTargetMinutes(date, { schedules, region, absences: absenceList, customHolidays });
          const wd = weekdayIndex(date);
          const prev = rows.filter((r) => r.type === 'WORK' && r.date === addDays(date, -1) && r.endAt).map((r) => r.endAt!).sort().pop();
          const closed = work.filter((r) => r.endAt);
          days.push({
            date,
            weekend: wd >= 5,
            holiday,
            absence: absences.get(date) ?? null,
            targetMinutes,
            start: work[0] ? work[0].startAt!.slice(11, 16) : null,
            end: work.length && work[work.length - 1].endAt ? work[work.length - 1].endAt!.slice(11, 16) : null,
            breakMinutes,
            workedMinutes,
            diffMinutes: workedMinutes - targetMinutes,
            location: work.find((r) => r.location)?.location ?? null,
            projectId: work.find((r) => r.projectId)?.projectId ?? null,
            comment: work.find((r) => r.comment)?.comment ?? null,
            status: work.some((r) => r.status === 'pending') ? 'pending' : work.length ? 'approved' : null,
            running: work.some((r) => !r.endAt),
            periodCount: work.length,
            warnings: closed.length ? checkArbZG(closed.map((r) => ({ start: r.startAt!, end: r.endAt!, breakMinutes: r.breakMinutes })), prev) : [],
          });
        }
        // Future days (and today, until something is recorded) are not "missing" hours yet.
        const today = new Date().toISOString().slice(0, 10);
        const totals = days.reduce(
          (t, d) => ({ targetMinutes: t.targetMinutes + d.targetMinutes, workedMinutes: t.workedMinutes + d.workedMinutes, diffMinutes: t.diffMinutes + (d.date < today || d.workedMinutes > 0 ? d.diffMinutes : 0) }),
          { targetMinutes: 0, workedMinutes: 0, diffMinutes: 0 },
        );
        return { month: query.month, days, totals };
      },
    );

    const dayBody = z.object({
      personId: z.string().uuid().optional(),
      date: isoDateSchema,
      start: hhmm,
      end: hhmm,
      breakMinutes: z.number().int().min(0).max(720).default(0),
      location: z.enum(LOCATIONS).nullish(),
      projectId: z.string().uuid().nullish(),
      comment: z.string().max(500).nullish(),
    });

    route({ method: 'PUT', url: '/api/v1/attendance/day', tag: 'time', summary: 'Set a whole day (replaces its entries with one work period)', body: dayBody }, async ({ user, body }) => {
      const personId = body.personId ?? user.personId;
      if (!personId) throw unprocessable('personId required', [{ path: 'personId', message: 'Required' }]);
      const existing = (await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), eq(attendancePeriods.date, body.date))));
      await assertWrite(user, personId);
      for (const e of existing) await assertWrite(user, personId, e);
      // An end before the start means the shift runs past midnight.
      const startAt = `${body.date}T${body.start}:00`;
      const endAt = `${body.end <= body.start ? addDays(body.date, 1) : body.date}T${body.end}:00`;
      const span = minutesBetween(startAt, endAt);
      if (body.breakMinutes >= span) throw unprocessable('Break too long', [{ path: 'breakMinutes', message: 'Break must be shorter than the working span' }]);
      const s = await settings();
      let breakMinutes = body.breakMinutes;
      let breakAdjusted = false;
      if (s.autoDeductBreaks) {
        breakMinutes = minimalCompliantBreak(span, body.breakMinutes);
        breakAdjusted = breakMinutes !== body.breakMinutes;
      }
      if (body.projectId) {
        const [p] = await db.select().from(projects).where(eq(projects.id, body.projectId));
        if (!p || p.status !== 'ACTIVE') throw unprocessable('Invalid project', [{ path: 'projectId', message: 'Project must exist and be active' }]);
      }
      const others = (await dayPeriods(personId, body.date)).filter((o) => o.date !== body.date);
      const clash = others.find((o) => overlaps({ startAt, endAt }, o));
      if (clash) throw conflict('Overlaps with an entry of a neighbouring day', { conflictingId: clash.id });
      const status = s.approvalRequired && !(await authz.can(user, 'time.manage', personId)) ? 'pending' : 'approved';
      const [row] = await db.transaction(async (tx) => {
        await tx.delete(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), eq(attendancePeriods.date, body.date)));
        const r = await tx
          .insert(attendancePeriods)
          .values({ personId, date: body.date, type: 'WORK', startAt, endAt, breakMinutes, location: body.location ?? null, projectId: body.projectId ?? null, comment: body.comment ?? null, status, createdByUserId: user.userId })
          .returning();
        await audit(tx, user.userId, 'attendance', r[0].id, 'set_day', { date: body.date, start: body.start, end: body.end, breakMinutes, replaced: existing.length });
        await emit(tx, 'attendance.updated', { attendanceId: r[0].id, personId, date: body.date });
        return r;
      });
      return { ...view(row), workedMinutes: span - breakMinutes, breakAdjusted, warnings: await warningsFor(personId, body.date) };
    });

    route({ method: 'DELETE', url: '/api/v1/attendance/day', tag: 'time', summary: 'Clear all entries of a day', query: z.object({ personId: z.string().uuid().optional(), date: isoDateSchema }) }, async ({ user, query }) => {
      const personId = query.personId ?? user.personId;
      if (!personId) throw unprocessable('personId required', [{ path: 'personId', message: 'Required' }]);
      await assertWrite(user, personId);
      const existing = await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), eq(attendancePeriods.date, query.date)));
      for (const e of existing) await assertWrite(user, personId, e);
      await db.transaction(async (tx) => {
        await tx.delete(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), eq(attendancePeriods.date, query.date)));
        await audit(tx, user.userId, 'attendance', personId, 'clear_day', { date: query.date, removed: existing.length });
      });
    });

    const attendanceBody = z.object({
      personId: z.string().uuid().optional(),
      type: z.enum(['WORK', 'BREAK']).default('WORK'),
      startAt: localDateTime,
      endAt: localDateTime.nullable(),
      projectId: z.string().uuid().nullish(),
      comment: z.string().max(500).nullish(),
    });

    async function create(user: Principal, personId: string, data: { type: string; startAt: string; endAt: string | null; projectId?: string | null; comment?: string | null }) {
      const s = await settings();
      await validate(personId, data);
      const status = s.approvalRequired && !(await authz.can(user, 'time.manage', personId)) ? 'pending' : 'approved';
      const [row] = await db.transaction(async (tx) => {
        const r = await tx
          .insert(attendancePeriods)
          .values({ personId, date: data.startAt.slice(0, 10), type: data.type, startAt: data.startAt, endAt: data.endAt, projectId: data.projectId ?? null, comment: data.comment ?? null, status, createdByUserId: user.userId })
          .returning();
        await emit(tx, 'attendance.created', { attendanceId: r[0].id, personId, date: r[0].date });
        return r;
      });
      return { ...view(row), warnings: await warningsFor(personId, row.date) };
    }

    route({ method: 'POST', url: '/api/v1/attendance', tag: 'time', summary: 'Record a work or break period', body: attendanceBody }, async ({ user, body }, reply) => {
      const personId = body.personId ?? user.personId;
      if (!personId) throw unprocessable('personId required', [{ path: 'personId', message: 'Required' }]);
      await assertWrite(user, personId);
      const res = await create(user, personId, { ...body, startAt: withSeconds(body.startAt), endAt: body.endAt ? withSeconds(body.endAt) : null });
      reply.code(201);
      return res;
    });

    route({ method: 'PATCH', url: '/api/v1/attendance/:id', tag: 'time', summary: 'Change a period', body: attendanceBody.omit({ personId: true }).partial() }, async ({ user, params, body }) => {
      const a = await load(params.id);
      await assertWrite(user, a.personId, a);
      const next = {
        type: body.type ?? a.type,
        startAt: body.startAt ? withSeconds(body.startAt) : norm(a.startAt)!,
        endAt: body.endAt !== undefined ? (body.endAt ? withSeconds(body.endAt) : null) : norm(a.endAt),
        projectId: body.projectId !== undefined ? body.projectId : a.projectId,
        comment: body.comment !== undefined ? body.comment : a.comment,
      };
      await validate(a.personId, next, a.id);
      const s = await settings();
      const status = s.approvalRequired && !(await authz.can(user, 'time.manage', a.personId)) ? 'pending' : a.status;
      const [row] = await db.transaction(async (tx) => {
        const r = await tx.update(attendancePeriods).set({ ...next, date: next.startAt.slice(0, 10), status }).where(eq(attendancePeriods.id, a.id)).returning();
        await audit(tx, user.userId, 'attendance', a.id, 'update', { before: { startAt: norm(a.startAt), endAt: norm(a.endAt) }, after: { startAt: next.startAt, endAt: next.endAt } });
        await emit(tx, 'attendance.updated', { attendanceId: a.id, personId: a.personId });
        return r;
      });
      return { ...view(row), warnings: await warningsFor(a.personId, row.date) };
    });

    route({ method: 'DELETE', url: '/api/v1/attendance/:id', tag: 'time', summary: 'Delete a period' }, async ({ user, params }) => {
      const a = await load(params.id);
      await assertWrite(user, a.personId, a);
      await db.transaction(async (tx) => {
        await tx.delete(attendancePeriods).where(eq(attendancePeriods.id, a.id));
        await audit(tx, user.userId, 'attendance', a.id, 'delete', { date: a.date, startAt: norm(a.startAt), endAt: norm(a.endAt) });
      });
    });

    async function openPeriod(personId: string) {
      const [open] = await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, personId), isNull(attendancePeriods.endAt)));
      return open ? view(open) : null;
    }

    route({ method: 'GET', url: '/api/v1/attendance/status', tag: 'time', summary: 'Currently running clock of the caller' }, async ({ user }) => ({ open: user.personId ? await openPeriod(user.personId) : null }));

    route({ method: 'POST', url: '/api/v1/attendance/clock-in', tag: 'time', summary: 'Start the clock', body: z.object({ projectId: z.string().uuid().nullish(), comment: z.string().max(500).nullish() }) }, async ({ user, body }, reply) => {
      if (!user.personId) throw forbidden('No person linked to this user');
      await assertWrite(user, user.personId);
      if (await openPeriod(user.personId)) throw conflict('Clock is already running');
      const s = await settings();
      const res = await create(user, user.personId, { type: 'WORK', startAt: nowLocal(s.timezone), endAt: null, projectId: body.projectId, comment: body.comment });
      reply.code(201);
      return res;
    });

    route({ method: 'POST', url: '/api/v1/attendance/clock-out', tag: 'time', summary: 'Stop the clock' }, async ({ user }) => {
      if (!user.personId) throw forbidden('No person linked to this user');
      const open = await openPeriod(user.personId);
      if (!open) throw conflict('Clock is not running');
      const s = await settings();
      let end = nowLocal(s.timezone);
      if (end <= open.startAt!) end = new Date(Date.parse(`${open.startAt}Z`) + 60_000).toISOString().slice(0, 19);
      const [row] = await db.update(attendancePeriods).set({ endAt: end }).where(eq(attendancePeriods.id, open.id)).returning();
      await emit(db, 'attendance.updated', { attendanceId: row.id, personId: row.personId });
      return { ...view(row), warnings: await warningsFor(row.personId, row.date) };
    });

    async function decide(user: Principal, id: string, status: 'approved' | 'rejected') {
      const a = await load(id);
      if (!(await authz.can(user, 'time.approve', a.personId))) throw forbidden();
      if (a.personId === user.personId && !(user.permissions['time.approve'] ?? []).includes('all')) throw forbidden('You cannot approve your own time');
      const [row] = await db.update(attendancePeriods).set({ status, decidedByUserId: user.userId }).where(eq(attendancePeriods.id, id)).returning();
      await audit(db, user.userId, 'attendance', id, status === 'approved' ? 'approve' : 'reject');
      return view(row);
    }
    route({ method: 'POST', url: '/api/v1/attendance/:id/approve', tag: 'time', summary: 'Approve a period' }, ({ user, params }) => decide(user, params.id, 'approved'));
    route({ method: 'POST', url: '/api/v1/attendance/:id/reject', tag: 'time', summary: 'Reject a period' }, ({ user, params }) => decide(user, params.id, 'rejected'));

    route({ method: 'GET', url: '/api/v1/attendance-approvals', tag: 'time', summary: 'Pending periods the caller can approve' }, async ({ user }) => {
      if (!authz.has(user, 'time.approve')) return { items: [] };
      const visible = await authz.visiblePersonIds(user, 'time.approve');
      const ids = visible === 'all' ? null : [...visible].filter((id) => id !== user.personId);
      if (ids && !ids.length) return { items: [] };
      const rows = await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.status, 'pending'), ids ? inArray(attendancePeriods.personId, ids) : undefined)).orderBy(asc(attendancePeriods.startAt));
      return { items: rows.map(view) };
    });

    // ---------- Balance ----------
    route(
      { method: 'GET', url: '/api/v1/persons/:id/time-balance', tag: 'time', summary: 'Target vs. worked time (overtime balance)', query: z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() }) },
      async ({ user, params, query }) => {
        await authz.assert(user, 'time.read', params.id);
        // By default the balance runs until yesterday: the current day is not finished yet.
        const to = query.to ?? addDays(new Date().toISOString().slice(0, 10), -1);
        const emp = await currentEmployment(db, params.id, to);
        const from = query.from ?? emp?.startDate ?? to;
        if (query.from && query.to && from > to) throw unprocessable('Invalid range', [{ path: 'from', message: 'from must not be after to' }]);
        if (from > to) return { from, to, targetMinutes: 0, workedMinutes: 0, balanceMinutes: 0 };
        const region = (await regionOf(db, params.id, to)) as Region;
        const schedules = await schedulesOf(db, params.id);
        const absenceRows = await db
          .select({ p: absencePeriods, t: absenceTypes })
          .from(absencePeriods)
          .innerJoin(absenceTypes, eq(absenceTypes.id, absencePeriods.typeId))
          .where(and(eq(absencePeriods.personId, params.id), eq(absencePeriods.status, 'approved'), lte(absencePeriods.startDate, to)));
        const absences: { date: string; fraction: number }[] = [];
        for (const { p, t } of absenceRows) {
          for (const d of await breakdownFor(db, p, t)) {
            if (d.date < from || d.date > to || d.scheduledHours === 0) continue;
            const fraction = t.unit === 'DAY' ? (p.startHalf && d.date === p.startDate) || (p.endHalf && d.date === p.endDate) ? 0.5 : 1 : Math.min(1, d.amount / d.scheduledHours);
            absences.push({ date: d.date, fraction });
          }
        }
        const rows = await db.select().from(attendancePeriods).where(and(eq(attendancePeriods.personId, params.id), eq(attendancePeriods.type, 'WORK'), gte(attendancePeriods.date, from), lte(attendancePeriods.date, to), ne(attendancePeriods.status, 'rejected')));
        const worked = rows.filter((r) => r.endAt).map((r) => ({ date: r.date, minutes: minutesBetween(norm(r.startAt)!, norm(r.endAt)!) - r.breakMinutes }));
        const customHolidays = await customHolidaysFor(db, region, from, to);
        return { from, to, ...computeTimeBalance({ from, to, schedules, region, absences, worked, customHolidays }) };
      },
    );
  },
};
