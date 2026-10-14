import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  computeBalanceChain,
  computeBreakdown,
  getHolidays,
  proratedEntitlement,
  sumAmounts,
  yearOf,
  type BreakdownDay,
  type Region,
} from '@openpers/shared';
import type { Exec } from '../../db';
import { absencePeriods, absencePolicies, absencePolicyAssignments, absenceTypes, balanceAdjustments, customHolidays, employments } from '../../db/schema';
import { regionOf, schedulesOf } from '../people/service';

export type AbsenceType = typeof absenceTypes.$inferSelect;
export type AbsencePeriod = typeof absencePeriods.$inferSelect;
export const ACTIVE_STATUSES = ['pending', 'approved'] as const;

const today = () => new Date().toISOString().slice(0, 10);

export async function customHolidaysFor(db: Exec, region: string, from: string, to: string) {
  const rows = await db
    .select()
    .from(customHolidays)
    .where(and(sql`${customHolidays.date} BETWEEN ${from} AND ${to}`, or(isNull(customHolidays.region), eq(customHolidays.region, region))));
  return rows.map((r) => ({ date: r.date, name: r.name }));
}

export async function holidaysFor(db: Exec, year: number, region: Region) {
  const custom = await customHolidaysFor(db, region, `${year}-01-01`, `${year}-12-31`);
  return [...getHolidays(year, region), ...custom].sort((a, b) => a.date.localeCompare(b.date));
}

export interface PeriodShape {
  personId: string;
  startDate: string;
  endDate: string | null;
  startHalf: boolean;
  endHalf: boolean;
}

/** Day-by-day breakdown of a period; open-ended periods are evaluated up to today. */
export async function breakdownFor(db: Exec, period: PeriodShape, type: Pick<AbsenceType, 'unit'>): Promise<BreakdownDay[]> {
  const end = period.endDate ?? (today() >= period.startDate ? today() : period.startDate);
  const region = (await regionOf(db, period.personId, period.startDate)) as Region;
  const [schedules, custom] = await Promise.all([schedulesOf(db, period.personId), customHolidaysFor(db, region, period.startDate, end)]);
  return computeBreakdown({
    start: period.startDate,
    end,
    startHalf: period.startHalf,
    endHalf: period.endHalf,
    schedules,
    region,
    unit: type.unit as 'DAY' | 'HOUR',
    customHolidays: custom,
  });
}

export async function policyFor(db: Exec, personId: string, typeId: string, year: number) {
  const [assigned] = await db
    .select({ policy: absencePolicies, override: absencePolicyAssignments.entitlementOverride })
    .from(absencePolicyAssignments)
    .innerJoin(absencePolicies, eq(absencePolicies.id, absencePolicyAssignments.policyId))
    .where(and(eq(absencePolicyAssignments.personId, personId), eq(absencePolicies.absenceTypeId, typeId), lte(absencePolicyAssignments.validFrom, `${year}-12-31`)))
    .orderBy(desc(absencePolicyAssignments.validFrom))
    .limit(1);
  if (assigned) return { ...assigned.policy, annualEntitlement: assigned.override ?? assigned.policy.annualEntitlement };
  const [def] = await db
    .select()
    .from(absencePolicies)
    .where(and(eq(absencePolicies.absenceTypeId, typeId), eq(absencePolicies.isDefault, true)))
    .limit(1);
  return def ?? null;
}

export interface BalanceView {
  typeId: string;
  typeName: string;
  unit: string;
  year: number;
  entitlement: number;
  carryover: number;
  carryoverExpired: number;
  adjustments: number;
  taken: number;
  pending: number;
  remaining: number;
  available: number;
}

/** Balance of one person for one absence type and year; `null` if the type has no balance/policy. */
export async function balanceFor(db: Exec, personId: string, type: AbsenceType, year: number, asOf = today(), excludePeriodId?: string): Promise<BalanceView | null> {
  if (!type.countsAgainstBalance) return null;
  const policy = await policyFor(db, personId, type.id, year);
  if (!policy) return null;
  const emps = await db.select({ startDate: employments.startDate, endDate: employments.endDate }).from(employments).where(eq(employments.personId, personId));
  if (!emps.length) return null;
  const start = emps.reduce((m, e) => (e.startDate < m ? e.startDate : m), emps[0].startDate);
  const end = emps.some((e) => !e.endDate) ? null : emps.reduce((m, e) => (e.endDate! > m ? e.endDate! : m), emps[0].endDate!);

  const periods = (await db
    .select()
    .from(absencePeriods)
    .where(and(eq(absencePeriods.personId, personId), eq(absencePeriods.typeId, type.id), inArray(absencePeriods.status, [...ACTIVE_STATUSES]))))
    .filter((p) => p.id !== excludePeriodId);
  const approvedDays: { date: string; amount: number }[] = [];
  const pendingDays: { date: string; amount: number }[] = [];
  for (const p of periods) {
    const days = await breakdownFor(db, p, type);
    (p.status === 'approved' ? approvedDays : pendingDays).push(...days.filter((d) => d.amount > 0));
  }
  const adjustments = await db.select().from(balanceAdjustments).where(and(eq(balanceAdjustments.personId, personId), eq(balanceAdjustments.typeId, type.id)));

  const balance = computeBalanceChain({
    startYear: yearOf(start),
    year,
    entitlementFor: (y) => proratedEntitlement(policy.annualEntitlement, y, start, end),
    adjustmentsFor: (y) => sumAmounts(adjustments.filter((a) => a.year === y)),
    takenFor: (y) => approvedDays.filter((d) => yearOf(d.date) === y),
    carryoverMax: policy.carryoverMax,
    carryoverExpiry: policy.carryoverExpiry,
    asOf,
  });
  const pending = sumAmounts(pendingDays.filter((d) => yearOf(d.date) === year));
  return {
    typeId: type.id,
    typeName: type.name,
    unit: type.unit,
    ...balance,
    pending,
    available: Math.round((balance.remaining - pending) * 100) / 100,
  };
}

export function periodsOverlap(a: PeriodShape, b: PeriodShape): boolean {
  const aEnd = a.endDate ?? '9999-12-31';
  const bEnd = b.endDate ?? '9999-12-31';
  if (a.startDate > bEnd || b.startDate > aEnd) return false;
  // Touching on a single day with complementary halves (morning vs. afternoon) is fine.
  if (aEnd === b.startDate && a.endHalf && b.startHalf && !(a.startDate === aEnd && a.startHalf)) return false;
  if (bEnd === a.startDate && b.endHalf && a.startHalf && !(b.startDate === bEnd && b.startHalf)) return false;
  return true;
}
