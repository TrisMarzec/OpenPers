import { addDays, type ISODate } from './dates';

export interface EmploymentSpan {
  personId: string;
  startDate: ISODate;
  endDate: ISODate | null;
}

/** Months `YYYY-MM` from `from` to `to`, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/** Last day of a month `YYYY-MM`. */
export function monthEnd(month: string): ISODate {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

const activeOn = (e: EmploymentSpan, date: ISODate) => e.startDate <= date && (!e.endDate || e.endDate >= date);

/** Distinct persons with an employment active on `date`. */
export function headcountAt(emps: EmploymentSpan[], date: ISODate): number {
  return new Set(emps.filter((e) => activeOn(e, date)).map((e) => e.personId)).size;
}

/**
 * Hires and exits within a month. A person moving seamlessly from one employment to the next
 * (e.g. a change of legal entity) is neither a hire nor an exit.
 */
export function movementsInMonth(emps: EmploymentSpan[], month: string): { hires: number; exits: number } {
  const inMonth = (d: ISODate | null) => !!d && d.slice(0, 7) === month;
  const hires = new Set<string>();
  const exits = new Set<string>();
  for (const e of emps) {
    if (inMonth(e.startDate)) {
      const before = addDays(e.startDate, -1);
      if (!emps.some((o) => o !== e && o.personId === e.personId && activeOn(o, before))) hires.add(e.personId);
    }
    if (inMonth(e.endDate)) {
      const after = addDays(e.endDate!, 1);
      if (!emps.some((o) => o !== e && o.personId === e.personId && activeOn(o, after))) exits.add(e.personId);
    }
  }
  return { hires: hires.size, exits: exits.size };
}

/** Exits per average headcount, in percent with one decimal. */
export function turnoverRate(exits: number, averageHeadcount: number): number {
  if (averageHeadcount <= 0) return 0;
  return Math.round((exits / averageHeadcount) * 1000) / 10;
}

export type TenureBucket = 'lt1' | '1to3' | '3to5' | 'gt5';

export function tenureBucket(startDate: ISODate, asOf: ISODate): TenureBucket {
  const years = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / (365.25 * 86_400_000);
  if (years < 1) return 'lt1';
  if (years < 3) return '1to3';
  if (years < 5) return '3to5';
  return 'gt5';
}

/** Merges groups below `min` members into one "other" group so individuals cannot be singled out. */
export function suppressSmallGroups<T extends { key: string; count: number }>(groups: T[], min = 3): { key: string; count: number }[] {
  const kept = groups.filter((g) => g.count >= min).map((g) => ({ key: g.key, count: g.count }));
  const rest = groups.filter((g) => g.count < min).reduce((s, g) => s + g.count, 0);
  return rest > 0 ? [...kept, { key: 'other', count: rest }] : kept;
}
