import { and, asc, desc, eq, gte, inArray, isNull, lte, or } from 'drizzle-orm';
import { z } from 'zod';
import { REGIONS, sumAmounts, yearOf, type Region } from '@openpers/shared';
import type { Exec } from '../../db';
import { absencePeriods, absencePolicies, absencePolicyAssignments, absenceTypes, balanceAdjustments, customHolidays, persons } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, diff, emit, type AppContext, type OpenPersModule } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { isoDateSchema, regionOf } from '../people/service';
import { ACTIVE_STATUSES, balanceFor, breakdownFor, holidaysFor, periodsOverlap, type AbsencePeriod, type AbsenceType } from './service';

const typeBody = z.object({
  name: z.string().min(1).max(100),
  category: z.enum(['vacation', 'sick', 'parental', 'special', 'unpaid', 'overtime', 'other']),
  unit: z.enum(['DAY', 'HOUR']).default('DAY'),
  requiresApproval: z.boolean().default(true),
  countsAgainstBalance: z.boolean().default(false),
  allowsSubstitute: z.boolean().default(false),
  allowsHalfDays: z.boolean().default(true),
  certificateRequiredAfterDays: z.number().int().min(1).nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#3b82f6'),
  active: z.boolean().default(true),
  position: z.number().int().default(0),
});

const policyBody = z.object({
  absenceTypeId: z.string().uuid(),
  name: z.string().min(1).max(100),
  annualEntitlement: z.number().min(0).max(366),
  carryoverMax: z.number().min(0).max(366).default(0),
  carryoverExpiry: z.string().regex(/^\d{2}-\d{2}$/).default('03-31'),
  isDefault: z.boolean().default(false),
  allowNegative: z.boolean().default(false),
});

const periodInput = z
  .object({
    personId: z.string().uuid().optional(),
    typeId: z.string().uuid(),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable(),
    startHalf: z.boolean().default(false),
    endHalf: z.boolean().default(false),
    comment: z.string().max(1000).nullish(),
    substitutePersonId: z.string().uuid().nullish(),
    skipApproval: z.boolean().default(false),
  })
  .refine((v) => !v.endDate || v.endDate >= v.startDate, { path: ['endDate'], message: 'End date must not be before start date' });

const DEFAULT_TYPES: z.input<typeof typeBody>[] = [
  { name: 'Urlaub', category: 'vacation', requiresApproval: true, countsAgainstBalance: true, allowsSubstitute: true, color: '#22c55e', position: 0 },
  { name: 'Krankheit', category: 'sick', requiresApproval: false, countsAgainstBalance: false, certificateRequiredAfterDays: 3, color: '#ef4444', position: 1 },
  { name: 'Kind krank', category: 'sick', requiresApproval: false, countsAgainstBalance: false, color: '#f97316', position: 2 },
  { name: 'Sonderurlaub', category: 'special', requiresApproval: true, countsAgainstBalance: false, color: '#a855f7', position: 3 },
  { name: 'Elternzeit', category: 'parental', requiresApproval: true, countsAgainstBalance: false, allowsHalfDays: false, color: '#06b6d4', position: 4 },
  { name: 'Unbezahlter Urlaub', category: 'unpaid', requiresApproval: true, countsAgainstBalance: false, color: '#64748b', position: 5 },
  { name: 'Überstundenabbau', category: 'overtime', requiresApproval: true, countsAgainstBalance: false, color: '#eab308', position: 6 },
];

export const absenceModule: OpenPersModule = {
  name: 'absence',

  async seed(tx) {
    for (const t of DEFAULT_TYPES) {
      const [row] = await tx.insert(absenceTypes).values(typeBody.parse(t)).returning();
      if (row.category === 'vacation') {
        await tx.insert(absencePolicies).values({ absenceTypeId: row.id, name: 'Standard (30 Tage)', annualEntitlement: 30, carryoverMax: 30, carryoverExpiry: '03-31', isDefault: true });
      }
    }
  },

  register(app, ctx: AppContext) {
    const { db, authz } = ctx;
    const route = makeRoute(app, ctx.registry);

    ctx.exporters.absences = async (x: Exec, personId: string) => ({
      periods: await x.select().from(absencePeriods).where(eq(absencePeriods.personId, personId)),
      adjustments: await x.select().from(balanceAdjustments).where(eq(balanceAdjustments.personId, personId)),
    });
    ctx.anonymizers.push(async (tx, personId) => {
      await tx.update(absencePeriods).set({ comment: null, decisionComment: null }).where(eq(absencePeriods.personId, personId));
    });

    async function loadType(id: string): Promise<AbsenceType> {
      const [t] = await db.select().from(absenceTypes).where(eq(absenceTypes.id, id));
      if (!t) throw notFound('Absence type not found');
      return t;
    }

    async function loadPeriod(id: string): Promise<AbsencePeriod> {
      const [p] = await db.select().from(absencePeriods).where(eq(absencePeriods.id, id));
      if (!p) throw notFound('Absence period not found');
      return p;
    }

    async function view(p: AbsencePeriod, withDays = false) {
      const type = await loadType(p.typeId);
      const breakdown = await breakdownFor(db, p, type);
      const [person] = await db.select({ firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(eq(persons.id, p.personId));
      return { ...p, typeName: type.name, typeColor: type.color, unit: type.unit, person, days: sumAmounts(breakdown), ...(withDays ? { breakdown } : {}) };
    }

    /** Whether the principal may approve: approver permission over the person, never for oneself unless company-wide. */
    async function canApprove(user: Principal, personId: string) {
      if (!(await authz.can(user, 'absence.approve', personId))) return false;
      if (personId === user.personId) return (user.permissions['absence.approve'] ?? []).includes('all');
      return true;
    }

    async function assertBalance(user: Principal, input: { personId: string; startDate: string; endDate: string | null; startHalf: boolean; endHalf: boolean }, type: AbsenceType, excludeId?: string) {
      if (!type.countsAgainstBalance) return;
      const days = await breakdownFor(db, input, type);
      const years = [...new Set(days.map((d) => yearOf(d.date)))];
      for (const y of years) {
        const balance = await balanceFor(db, input.personId, type, y, undefined, excludeId);
        if (!balance) continue;
        const policy = await db.select().from(absencePolicies).where(eq(absencePolicies.absenceTypeId, type.id));
        if (policy.some((p) => p.allowNegative)) continue;
        if ((await authz.can(user, 'absence.manage', input.personId)) && user.personId !== input.personId) continue;
        const needed = sumAmounts(days.filter((d) => yearOf(d.date) === y));
        if (needed > balance.available) {
          throw unprocessable('Insufficient balance', [{ path: 'endDate', message: `Requested ${needed}, available ${balance.available} in ${y}` }]);
        }
      }
    }

    // ---------- Types ----------
    route({ method: 'GET', url: '/api/v1/absence-types', tag: 'absence', summary: 'List absence types' }, async () => ({ items: await db.select().from(absenceTypes).orderBy(asc(absenceTypes.position), asc(absenceTypes.name)) }));
    route({ method: 'POST', url: '/api/v1/absence-types', perm: 'absence.manage', tag: 'absence', summary: 'Create absence type', body: typeBody }, async ({ user, body }, reply) => {
      const [row] = await db.insert(absenceTypes).values(body).returning();
      await audit(db, user.userId, 'absence_type', row.id, 'create', body);
      reply.code(201);
      return row;
    });
    route({ method: 'PATCH', url: '/api/v1/absence-types/:id', perm: 'absence.manage', tag: 'absence', summary: 'Update absence type', body: typeBody.partial() }, async ({ user, body, params }) => {
      const before = await loadType(params.id);
      const [row] = await db.update(absenceTypes).set(body).where(eq(absenceTypes.id, params.id)).returning();
      await audit(db, user.userId, 'absence_type', row.id, 'update', diff(before, body));
      return row;
    });

    // ---------- Policies ----------
    route({ method: 'GET', url: '/api/v1/absence-policies', tag: 'absence', summary: 'List absence policies' }, async () => ({ items: await db.select().from(absencePolicies).orderBy(asc(absencePolicies.name)) }));
    route({ method: 'POST', url: '/api/v1/absence-policies', perm: 'absence.manage', tag: 'absence', summary: 'Create absence policy', body: policyBody }, async ({ user, body }, reply) => {
      await loadType(body.absenceTypeId);
      const row = await db.transaction(async (tx) => {
        if (body.isDefault) await tx.update(absencePolicies).set({ isDefault: false }).where(eq(absencePolicies.absenceTypeId, body.absenceTypeId));
        const [r] = await tx.insert(absencePolicies).values(body).returning();
        await audit(tx, user.userId, 'absence_policy', r.id, 'create', body);
        return r;
      });
      reply.code(201);
      return row;
    });
    route({ method: 'PATCH', url: '/api/v1/absence-policies/:id', perm: 'absence.manage', tag: 'absence', summary: 'Update absence policy', body: policyBody.omit({ absenceTypeId: true }).partial() }, async ({ user, body, params }) => {
      const [before] = await db.select().from(absencePolicies).where(eq(absencePolicies.id, params.id));
      if (!before) throw notFound();
      const row = await db.transaction(async (tx) => {
        if (body.isDefault) await tx.update(absencePolicies).set({ isDefault: false }).where(eq(absencePolicies.absenceTypeId, before.absenceTypeId));
        const [r] = await tx.update(absencePolicies).set(body).where(eq(absencePolicies.id, params.id)).returning();
        await audit(tx, user.userId, 'absence_policy', r.id, 'update', diff(before, body));
        return r;
      });
      return row;
    });
    route(
      {
        method: 'POST',
        url: '/api/v1/absence-policies/:id/assign',
        perm: 'absence.manage',
        tag: 'absence',
        summary: 'Assign a policy to persons',
        body: z.object({ personIds: z.array(z.string().uuid()).min(1), validFrom: isoDateSchema, entitlementOverride: z.number().min(0).max(366).nullish() }),
      },
      async ({ user, body, params }) => {
        const [policy] = await db.select().from(absencePolicies).where(eq(absencePolicies.id, params.id));
        if (!policy) throw notFound();
        await db.transaction(async (tx) => {
          for (const personId of body.personIds) {
            await tx.insert(absencePolicyAssignments).values({ personId, policyId: params.id, validFrom: body.validFrom, entitlementOverride: body.entitlementOverride ?? null });
            await audit(tx, user.userId, 'person', personId, 'policy_assign', { policyId: params.id, validFrom: body.validFrom, entitlementOverride: body.entitlementOverride });
          }
        });
        return { ok: true };
      },
    );

    // ---------- Holidays ----------
    route(
      { method: 'GET', url: '/api/v1/holidays', tag: 'absence', summary: 'Public and company holidays', query: z.object({ year: z.coerce.number().int().min(1900).max(2200), region: z.enum(REGIONS as [string, ...string[]]).optional() }) },
      async ({ user, query }) => {
        const region = (query.region ?? (user.personId ? await regionOf(db, user.personId, `${query.year}-01-01`) : 'DE-BE')) as Region;
        return { region, items: await holidaysFor(db, query.year, region) };
      },
    );
    route({ method: 'GET', url: '/api/v1/custom-holidays', tag: 'absence', summary: 'List company holidays' }, async () => ({ items: await db.select().from(customHolidays).orderBy(asc(customHolidays.date)) }));
    route(
      { method: 'POST', url: '/api/v1/custom-holidays', perm: 'absence.manage', tag: 'absence', summary: 'Add a company holiday', body: z.object({ date: isoDateSchema, name: z.string().min(1).max(100), region: z.enum(REGIONS as [string, ...string[]]).nullish() }) },
      async ({ user, body }, reply) => {
        const [row] = await db.insert(customHolidays).values({ date: body.date, name: body.name, region: body.region ?? null }).returning();
        await audit(db, user.userId, 'custom_holiday', row.id, 'create', body);
        reply.code(201);
        return row;
      },
    );
    route({ method: 'DELETE', url: '/api/v1/custom-holidays/:id', perm: 'absence.manage', tag: 'absence', summary: 'Delete a company holiday' }, async ({ user, params }) => {
      const res = await db.delete(customHolidays).where(eq(customHolidays.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'custom_holiday', params.id, 'delete');
    });

    // ---------- Periods ----------
    async function resolveTarget(user: Principal, personId?: string) {
      const target = personId ?? user.personId;
      if (!target) throw unprocessable('No person', [{ path: 'personId', message: 'personId is required for users without a person' }]);
      const self = target === user.personId;
      const allowed = (self && authz.has(user, 'absence.request')) || (await authz.can(user, 'absence.manage', target));
      if (!allowed) throw forbidden('Not allowed to file absences for this person');
      return target;
    }

    route({ method: 'POST', url: '/api/v1/absence-periods/preview', tag: 'absence', summary: 'Preview effective days and balance of a request', body: periodInput.innerType().partial({ endDate: true }) }, async ({ user, body }) => {
      const personId = await resolveTarget(user, body.personId);
      const type = await loadType(body.typeId);
      const shape = { personId, startDate: body.startDate, endDate: body.endDate ?? body.startDate, startHalf: body.startHalf, endHalf: body.endHalf };
      if (shape.endDate < shape.startDate) throw unprocessable('Invalid range', [{ path: 'endDate', message: 'End date must not be before start date' }]);
      const days = await breakdownFor(db, shape, type);
      const balance = type.countsAgainstBalance ? await balanceFor(db, personId, type, yearOf(body.startDate)) : null;
      return { days, total: sumAmounts(days), unit: type.unit, balance };
    });

    route({ method: 'POST', url: '/api/v1/absence-periods', tag: 'absence', summary: 'Request or record an absence', body: periodInput }, async ({ user, body }, reply) => {
      const personId = await resolveTarget(user, body.personId);
      const type = await loadType(body.typeId);
      if (!type.active) throw unprocessable('Inactive type', [{ path: 'typeId', message: 'Absence type is inactive' }]);
      if ((body.startHalf || body.endHalf) && !type.allowsHalfDays) throw unprocessable('Half days not allowed', [{ path: 'startHalf', message: 'This absence type does not allow half days' }]);
      if (!body.endDate && type.countsAgainstBalance) throw unprocessable('End date required', [{ path: 'endDate', message: 'Required for absence types with a balance' }]);
      if (body.substitutePersonId && !type.allowsSubstitute) throw unprocessable('No substitute allowed', [{ path: 'substitutePersonId', message: 'This absence type does not allow substitutes' }]);
      const shape = { personId, startDate: body.startDate, endDate: body.endDate, startHalf: body.startHalf, endHalf: body.endHalf };
      const days = await breakdownFor(db, shape, type);
      if (body.endDate && sumAmounts(days) === 0) throw unprocessable('No working days', [{ path: 'startDate', message: 'The selected range contains no working days' }]);

      const existing = await db.select().from(absencePeriods).where(and(eq(absencePeriods.personId, personId), inArray(absencePeriods.status, [...ACTIVE_STATUSES])));
      const clash = existing.find((e) => periodsOverlap(e, shape));
      if (clash) throw conflict('Overlaps with an existing absence', { conflictingId: clash.id });
      await assertBalance(user, shape, type);

      const skip = body.skipApproval && ((await canApprove(user, personId)) || (await authz.can(user, 'absence.manage', personId)));
      const managerEntry = personId !== user.personId && (await authz.can(user, 'absence.manage', personId));
      const status = !type.requiresApproval || skip || managerEntry ? 'approved' : 'pending';
      const row = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(absencePeriods)
          .values({ personId, typeId: type.id, startDate: body.startDate, endDate: body.endDate, startHalf: body.startHalf, endHalf: body.endHalf, comment: body.comment ?? null, substitutePersonId: body.substitutePersonId ?? null, status, requestedByUserId: user.userId, ...(status === 'approved' ? { decidedByUserId: user.userId, decidedAt: new Date() } : {}) })
          .returning();
        await audit(tx, user.userId, 'absence', r.id, 'create', { personId, typeId: type.id, startDate: body.startDate, endDate: body.endDate, status });
        await emit(tx, status === 'approved' ? 'absence.approved' : 'absence.requested', { absenceId: r.id, personId, typeId: type.id, startDate: r.startDate, endDate: r.endDate });
        return r;
      });
      reply.code(201);
      return view(row);
    });

    route(
      {
        method: 'GET',
        url: '/api/v1/absence-periods',
        tag: 'absence',
        summary: 'List absence periods',
        query: z.object({ personId: z.string().uuid().optional(), from: isoDateSchema.optional(), to: isoDateSchema.optional(), status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(), typeId: z.string().uuid().optional() }),
      },
      async ({ user, query }) => {
        const visible = await authz.visiblePersonIds(user, 'absence.read');
        if (query.personId && visible !== 'all' && !visible.has(query.personId)) throw forbidden();
        const ids = query.personId ? [query.personId] : visible === 'all' ? null : [...visible];
        if (ids && !ids.length) return { items: [] };
        const conds = [
          ids ? inArray(absencePeriods.personId, ids) : undefined,
          query.status ? eq(absencePeriods.status, query.status) : undefined,
          query.typeId ? eq(absencePeriods.typeId, query.typeId) : undefined,
          query.to ? lte(absencePeriods.startDate, query.to) : undefined,
          query.from ? or(isNull(absencePeriods.endDate), gte(absencePeriods.endDate, query.from)) : undefined,
        ].filter(Boolean) as any[];
        const rows = await db.select().from(absencePeriods).where(conds.length ? and(...conds) : undefined).orderBy(desc(absencePeriods.startDate)).limit(1000);
        return { items: await Promise.all(rows.map((r) => view(r))) };
      },
    );

    route({ method: 'GET', url: '/api/v1/absence-periods/:id', tag: 'absence', summary: 'Absence period incl. daily breakdown' }, async ({ user, params }) => {
      const p = await loadPeriod(params.id);
      await authz.assert(user, 'absence.read', p.personId);
      return view(p, true);
    });

    route({ method: 'GET', url: '/api/v1/absence-periods/:id/breakdown', tag: 'absence', summary: 'Daily breakdown of an absence period' }, async ({ user, params }) => {
      const p = await loadPeriod(params.id);
      await authz.assert(user, 'absence.read', p.personId);
      return { items: await breakdownFor(db, p, await loadType(p.typeId)) };
    });

    route(
      { method: 'PATCH', url: '/api/v1/absence-periods/:id', tag: 'absence', summary: 'Change an absence (HR)', body: z.object({ startDate: isoDateSchema.optional(), endDate: isoDateSchema.nullable().optional(), startHalf: z.boolean().optional(), endHalf: z.boolean().optional(), comment: z.string().max(1000).nullish() }) },
      async ({ user, params, body }) => {
        const p = await loadPeriod(params.id);
        await authz.assert(user, 'absence.manage', p.personId);
        const next = { ...p, ...Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) } as AbsencePeriod;
        if (next.endDate && next.endDate < next.startDate) throw unprocessable('Invalid range', [{ path: 'endDate', message: 'End date must not be before start date' }]);
        const others = await db.select().from(absencePeriods).where(and(eq(absencePeriods.personId, p.personId), inArray(absencePeriods.status, [...ACTIVE_STATUSES])));
        const clash = others.find((o) => o.id !== p.id && periodsOverlap(o, next));
        if (clash) throw conflict('Overlaps with an existing absence', { conflictingId: clash.id });
        await assertBalance(user, next, await loadType(p.typeId), p.id);
        const [row] = await db.transaction(async (tx) => {
          const r = await tx.update(absencePeriods).set(body).where(eq(absencePeriods.id, p.id)).returning();
          await audit(tx, user.userId, 'absence', p.id, 'update', diff(p, body));
          await emit(tx, 'absence.updated', { absenceId: p.id, personId: p.personId });
          return r;
        });
        return view(row);
      },
    );

    async function decide(user: Principal, id: string, status: 'approved' | 'rejected', comment?: string | null) {
      const p = await loadPeriod(id);
      if (!(await canApprove(user, p.personId))) throw forbidden('Not allowed to decide on this absence');
      if (p.status !== 'pending') throw conflict(`Absence is already ${p.status}`);
      const [row] = await db.transaction(async (tx) => {
        const r = await tx.update(absencePeriods).set({ status, decidedByUserId: user.userId, decidedAt: new Date(), decisionComment: comment ?? null }).where(eq(absencePeriods.id, id)).returning();
        await audit(tx, user.userId, 'absence', id, status === 'approved' ? 'approve' : 'reject', { comment });
        await emit(tx, `absence.${status}`, { absenceId: id, personId: p.personId, typeId: p.typeId, startDate: p.startDate, endDate: p.endDate });
        return r;
      });
      return view(row);
    }
    const decisionBody = z.object({ comment: z.string().max(1000).nullish() });
    route({ method: 'POST', url: '/api/v1/absence-periods/:id/approve', tag: 'absence', summary: 'Approve a pending absence', body: decisionBody }, ({ user, params, body }) => decide(user, params.id, 'approved', body.comment));
    route({ method: 'POST', url: '/api/v1/absence-periods/:id/reject', tag: 'absence', summary: 'Reject a pending absence', body: decisionBody }, ({ user, params, body }) => decide(user, params.id, 'rejected', body.comment));

    route({ method: 'POST', url: '/api/v1/absence-periods/:id/cancel', tag: 'absence', summary: 'Cancel an absence' }, async ({ user, params }) => {
      const p = await loadPeriod(params.id);
      const own = p.personId === user.personId;
      const manager = await authz.can(user, 'absence.manage', p.personId);
      if (!own && !manager) throw forbidden();
      if (!['pending', 'approved'].includes(p.status)) throw conflict(`Absence is already ${p.status}`);
      const today = new Date().toISOString().slice(0, 10);
      if (own && !manager && p.status === 'approved' && p.startDate <= today) throw forbidden('Approved absences that already started can only be cancelled by HR');
      const [row] = await db.transaction(async (tx) => {
        const r = await tx.update(absencePeriods).set({ status: 'cancelled' }).where(eq(absencePeriods.id, p.id)).returning();
        await audit(tx, user.userId, 'absence', p.id, 'cancel');
        await emit(tx, 'absence.cancelled', { absenceId: p.id, personId: p.personId });
        return r;
      });
      return view(row);
    });

    route({ method: 'GET', url: '/api/v1/absence-approvals', tag: 'absence', summary: 'Pending absences the caller can decide on' }, async ({ user }) => {
      if (!authz.has(user, 'absence.approve')) return { items: [] };
      const visible = await authz.visiblePersonIds(user, 'absence.approve');
      const pending = await db.select().from(absencePeriods).where(eq(absencePeriods.status, 'pending')).orderBy(asc(absencePeriods.startDate));
      const mine = [];
      for (const p of pending) {
        if (visible !== 'all' && !visible.has(p.personId)) continue;
        if (await canApprove(user, p.personId)) mine.push(await view(p));
      }
      return { items: mine };
    });

    // ---------- Balances ----------
    route(
      { method: 'GET', url: '/api/v1/persons/:id/balances', tag: 'absence', summary: 'Absence balances of a person', query: z.object({ year: z.coerce.number().int().default(new Date().getFullYear()), asOf: isoDateSchema.optional() }) },
      async ({ user, params, query }) => {
        await authz.assert(user, 'absence.read', params.id);
        const types = await db.select().from(absenceTypes).where(eq(absenceTypes.countsAgainstBalance, true));
        const items = [];
        for (const t of types) {
          const b = await balanceFor(db, params.id, t, query.year, query.asOf);
          if (b) items.push(b);
        }
        const adjustments = await db.select().from(balanceAdjustments).where(and(eq(balanceAdjustments.personId, params.id), eq(balanceAdjustments.year, query.year)));
        return { items, adjustments };
      },
    );
    route(
      { method: 'POST', url: '/api/v1/persons/:id/balance-adjustments', tag: 'absence', summary: 'Correct a balance', body: z.object({ typeId: z.string().uuid(), year: z.number().int(), amount: z.number().min(-366).max(366), reason: z.string().min(1).max(500) }) },
      async ({ user, params, body }, reply) => {
        await authz.assert(user, 'absence.manage', params.id);
        const [row] = await db.insert(balanceAdjustments).values({ ...body, personId: params.id, createdByUserId: user.userId }).returning();
        await audit(db, user.userId, 'person', params.id, 'balance_adjustment', body);
        reply.code(201);
        return row;
      },
    );

    // ---------- Team calendar ----------
    route(
      { method: 'GET', url: '/api/v1/absence-calendar', tag: 'absence', summary: 'Who is absent when (all employees, details only where permitted)', query: z.object({ from: isoDateSchema, to: isoDateSchema, orgUnitId: z.string().uuid().optional() }) },
      async ({ user, query }) => {
        const visible = await authz.visiblePersonIds(user, 'absence.read');
        const rows = await db
          .select({ p: absencePeriods, t: absenceTypes, firstName: persons.firstName, lastName: persons.lastName })
          .from(absencePeriods)
          .innerJoin(absenceTypes, eq(absenceTypes.id, absencePeriods.typeId))
          .innerJoin(persons, eq(persons.id, absencePeriods.personId))
          .where(and(inArray(absencePeriods.status, [...ACTIVE_STATUSES]), lte(absencePeriods.startDate, query.to), or(isNull(absencePeriods.endDate), gte(absencePeriods.endDate, query.from)), isNull(persons.anonymizedAt)));
        return {
          items: rows.flatMap(({ p, t, firstName, lastName }) => {
            const detailed = visible === 'all' || visible.has(p.personId);
            if (!detailed && p.status === 'pending') return [];
            return [{
              id: p.id,
              personId: p.personId,
              firstName,
              lastName,
              startDate: p.startDate,
              endDate: p.endDate,
              startHalf: p.startHalf,
              endHalf: p.endHalf,
              status: detailed ? p.status : 'approved',
              typeName: detailed ? t.name : 'Abwesend',
              color: detailed ? t.color : '#94a3b8',
            }];
          }),
        };
      },
    );
  },
};
