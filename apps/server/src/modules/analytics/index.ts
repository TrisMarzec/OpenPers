import { and, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import {
  computeBreakdown,
  headcountAt,
  monthEnd,
  monthRange,
  movementsInMonth,
  scheduleFor,
  tenureBucket,
  turnoverRate,
  type EmploymentSpan,
  type Region,
} from '@openpers/shared';
import { absencePeriods, absenceTypes, employmentOrgUnits, employments, orgUnits, persons, workplaces, workSchedules } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { AppContext, OpenPersModule } from '../../lib/context';
import { unprocessable } from '../../lib/errors';
import { breakdownFor, customHolidaysFor } from '../absence/service';
import { regionOf, schedulesOf } from '../people/service';

const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
/** Absence reasons are only broken down for populations of at least this size (privacy). */
const MIN_GROUP = 3;
const OVERTIME_THRESHOLD_MINUTES = 20 * 60;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const analyticsModule: OpenPersModule = {
  name: 'analytics',
  register(app, ctx: AppContext) {
    const { db } = ctx;
    const route = makeRoute(app, ctx.registry);

    route(
      {
        method: 'GET',
        url: '/api/v1/analytics/overview',
        perm: 'analytics.read',
        tag: 'analytics',
        summary: 'Headcount, FTE, hires/exits, turnover, absence rates, overtime and workforce distribution',
        query: z.object({ from: monthParam, to: monthParam, orgUnitId: z.string().uuid().optional(), workplaceId: z.string().uuid().optional() }),
      },
      async ({ query }) => {
        if (query.from > query.to) throw unprocessable('Invalid range', [{ path: 'from', message: 'from must not be after to' }]);
        const months = monthRange(query.from, query.to);
        if (months.length > 36) throw unprocessable('Range too long', [{ path: 'to', message: 'At most 36 months' }]);
        const rangeStart = `${query.from}-01`;
        const rangeEnd = monthEnd(query.to);
        const today = new Date().toISOString().slice(0, 10);

        // ---- population (employments matching the filters) ----
        let emps = await db.select().from(employments).where(lte(employments.startDate, rangeEnd));
        const anonymized = new Set((await db.select({ id: persons.id, a: persons.anonymizedAt }).from(persons)).filter((p) => p.a).map((p) => p.id));
        const unitLinks = await db.select().from(employmentOrgUnits);
        if (query.orgUnitId) emps = emps.filter((e) => unitLinks.some((l) => l.employmentId === e.id && l.orgUnitId === query.orgUnitId));
        if (query.workplaceId) emps = emps.filter((e) => e.workplaceId === query.workplaceId);
        const spans: EmploymentSpan[] = emps.map((e) => ({ personId: e.personId, startDate: e.startDate, endDate: e.endDate }));
        const schedules = emps.length ? await db.select().from(workSchedules).where(inArray(workSchedules.employmentId, emps.map((e) => e.id))) : [];

        const fteAt = (date: string) => {
          let fte = 0;
          for (const e of emps) {
            if (e.startDate > date || (e.endDate && e.endDate < date)) continue;
            const versions = schedules.filter((s) => s.employmentId === e.id);
            const v = scheduleFor(date, versions.map((s) => ({ validFrom: s.validFrom, hours: s.hours })));
            const full = versions.find((s) => s.validFrom === v?.validFrom)?.fullTimeWeeklyHours ?? 40;
            fte += v ? v.hours.reduce((a, b) => a + b, 0) / full : 0;
          }
          return round1(fte);
        };

        const monthRows = months.map((m) => {
          const end = monthEnd(m);
          return { month: m, headcount: headcountAt(spans, end), fte: fteAt(end), ...movementsInMonth(spans, m) };
        });
        const hires = monthRows.reduce((s, r) => s + r.hires, 0);
        const exits = monthRows.reduce((s, r) => s + r.exits, 0);
        const avgHeadcount = monthRows.reduce((s, r) => s + r.headcount, 0) / Math.max(1, monthRows.length);

        // ---- absence: days per category vs. scheduled working days in the range ----
        const absenceEnd = rangeEnd < today ? rangeEnd : today;
        const personIds = [...new Set(emps.map((e) => e.personId))].filter((id) => !anonymized.has(id));
        let targetDays = 0;
        const byCategory = new Map<string, { days: number; persons: Set<string> }>();
        if (absenceEnd >= rangeStart) {
          for (const pid of personIds) {
            const region = (await regionOf(db, pid, absenceEnd)) as Region;
            const personSchedules = await schedulesOf(db, pid);
            const custom = await customHolidaysFor(db, region, rangeStart, absenceEnd);
            for (const e of emps.filter((x) => x.personId === pid)) {
              const from = e.startDate > rangeStart ? e.startDate : rangeStart;
              const to = e.endDate && e.endDate < absenceEnd ? e.endDate : absenceEnd;
              if (from > to) continue;
              targetDays += computeBreakdown({ start: from, end: to, schedules: personSchedules, region, unit: 'DAY', customHolidays: custom }).reduce((s, d) => s + d.amount, 0);
            }
          }
          if (personIds.length) {
            const rows = await db
              .select({ p: absencePeriods, t: absenceTypes })
              .from(absencePeriods)
              .innerJoin(absenceTypes, eq(absenceTypes.id, absencePeriods.typeId))
              .where(and(eq(absencePeriods.status, 'approved'), inArray(absencePeriods.personId, personIds), lte(absencePeriods.startDate, absenceEnd)));
            for (const { p, t } of rows) {
              if (p.endDate && p.endDate < rangeStart) continue;
              for (const d of await breakdownFor(db, p, t)) {
                if (d.date < rangeStart || d.date > absenceEnd || d.scheduledHours === 0) continue;
                const days = t.unit === 'DAY' ? d.amount : d.amount / d.scheduledHours;
                const entry = byCategory.get(t.category) ?? { days: 0, persons: new Set<string>() };
                entry.days += days;
                entry.persons.add(p.personId);
                byCategory.set(t.category, entry);
              }
            }
          }
        }
        const totalAbsenceDays = [...byCategory.values()].reduce((s, c) => s + c.days, 0);
        const detailed = personIds.length >= MIN_GROUP;
        const absence = {
          targetDays: round1(targetDays),
          totalDays: round1(totalAbsenceDays),
          totalRate: targetDays ? round1((totalAbsenceDays / targetDays) * 100) : 0,
          suppressed: !detailed,
          byCategory: detailed ? [...byCategory].map(([category, v]) => ({ category, days: round1(v.days), persons: v.persons.size })) : [],
          rates: detailed ? Object.fromEntries([...byCategory].map(([category, v]) => [category, targetDays ? round1((v.days / targetDays) * 100) : 0])) : {},
        };

        // ---- current workforce: distribution and overtime ----
        const asOf = rangeEnd < today ? rangeEnd : today;
        const current = emps.filter((e) => e.startDate <= asOf && (!e.endDate || e.endDate >= asOf) && !anonymized.has(e.personId));
        const units = await db.select().from(orgUnits);
        const wps = await db.select().from(workplaces);
        const count = (keys: string[]) => {
          const m = new Map<string, number>();
          for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
          return [...m].map(([key, n]) => ({ key, count: n })).sort((a, b) => b.count - a.count);
        };
        const distribution = {
          byUnit: count(current.flatMap((e) => {
            const names = unitLinks.filter((l) => l.employmentId === e.id).map((l) => units.find((u) => u.id === l.orgUnitId)?.name ?? '?');
            return names.length ? names : ['none'];
          })),
          byWorkplace: count(current.map((e) => wps.find((w) => w.id === e.workplaceId)?.name ?? 'none')),
          byContractType: count(current.map((e) => e.contractType)),
          byTenure: count(current.map((e) => tenureBucket(spans.filter((s) => s.personId === e.personId).reduce((m, s) => (s.startDate < m ? s.startDate : m), e.startDate), asOf))),
        };

        let overtimeTotal = 0;
        let over = 0;
        let under = 0;
        const balanceOf = ctx.services.timeBalanceOf;
        if (balanceOf) {
          for (const pid of new Set(current.map((e) => e.personId))) {
            const b = await balanceOf(pid);
            overtimeTotal += b.balanceMinutes;
            if (b.balanceMinutes > OVERTIME_THRESHOLD_MINUTES) over++;
            if (b.balanceMinutes < -OVERTIME_THRESHOLD_MINUTES) under++;
          }
        }

        return {
          from: query.from,
          to: query.to,
          months: monthRows,
          totals: { hires, exits, averageHeadcount: round1(avgHeadcount), turnoverRate: turnoverRate(exits, avgHeadcount), headcount: monthRows[monthRows.length - 1]?.headcount ?? 0, fte: monthRows[monthRows.length - 1]?.fte ?? 0 },
          absence,
          overtime: { totalMinutes: overtimeTotal, overThreshold: over, underThreshold: under, thresholdMinutes: OVERTIME_THRESHOLD_MINUTES },
          distribution,
        };
      },
    );
  },
};
