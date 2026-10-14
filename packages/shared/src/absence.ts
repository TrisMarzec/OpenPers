import { eachDay, makeDate, parseDate, round2, scheduledHours, type ISODate, type ScheduleVersion } from './dates';
import { holidayName, type Region } from './holidays';

export type AbsenceUnit = 'DAY' | 'HOUR';

export interface CustomHoliday {
  date: ISODate;
  name: string;
}

export interface BreakdownInput {
  start: ISODate;
  end: ISODate;
  /** Absence starts at noon on the first day (afternoon only). */
  startHalf?: boolean;
  /** Absence ends at noon on the last day (morning only). */
  endHalf?: boolean;
  schedules: ScheduleVersion[];
  region: Region;
  unit: AbsenceUnit;
  customHolidays?: CustomHoliday[];
}

export interface BreakdownDay {
  date: ISODate;
  scheduledHours: number;
  holiday?: string;
  /** Balance consumed on this day: days (DAY unit) or hours (HOUR unit). */
  amount: number;
}

/** Day-by-day breakdown of how much balance an absence consumes. */
export function computeBreakdown(input: BreakdownInput): BreakdownDay[] {
  const days = eachDay(input.start, input.end);
  return days.map((date, i) => {
    const hours = scheduledHours(date, input.schedules);
    const holiday = input.customHolidays?.find((h) => h.date === date)?.name ?? holidayName(date, input.region);
    let fraction = 1;
    const first = i === 0;
    const last = i === days.length - 1;
    if ((first && input.startHalf) || (last && input.endHalf)) fraction = 0.5;
    const working = hours > 0 && !holiday;
    const amount = !working ? 0 : input.unit === 'DAY' ? fraction : round2(hours * fraction);
    return { date, scheduledHours: hours, ...(holiday ? { holiday } : {}), amount };
  });
}

export function sumAmounts(days: { amount: number }[]): number {
  return round2(days.reduce((s, d) => s + d.amount, 0));
}

/**
 * Pro-rated annual entitlement (BUrlG §5): 1/12 per full month of employment in the year
 * when employment starts or ends within the year; fractions ≥ 0.5 round up to a full day.
 */
export function proratedEntitlement(annual: number, year: number, employmentStart: ISODate, employmentEnd: ISODate | null): number {
  const yearStart = makeDate(year, 1, 1);
  const yearEnd = makeDate(year, 12, 31);
  if (employmentStart > yearEnd || (employmentEnd && employmentEnd < yearStart)) return 0;
  if (employmentStart <= yearStart && (!employmentEnd || employmentEnd >= yearEnd)) return annual;
  let fullMonths = 0;
  for (let m = 1; m <= 12; m++) {
    const first = makeDate(year, m, 1);
    const last = new Date(Date.UTC(year, m, 0)).toISOString().slice(0, 10);
    if (employmentStart <= first && (!employmentEnd || employmentEnd >= last)) fullMonths++;
  }
  const raw = (annual * fullMonths) / 12;
  const frac = raw - Math.floor(raw);
  return frac >= 0.5 ? Math.ceil(raw) : round2(raw);
}

export interface TakenItem {
  date: ISODate;
  amount: number;
}

export interface BalanceChainInput {
  /** First year to account for (usually the employment start year). */
  startYear: number;
  year: number;
  entitlementFor: (year: number) => number;
  adjustmentsFor: (year: number) => number;
  takenFor: (year: number) => TakenItem[];
  carryoverMax: number;
  /** `MM-DD` in the following year after which unused carryover expires. */
  carryoverExpiry: string;
  asOf: ISODate;
}

export interface Balance {
  year: number;
  entitlement: number;
  carryover: number;
  carryoverExpired: number;
  adjustments: number;
  taken: number;
  remaining: number;
}

/** Computes a yearly balance including carryover chained from previous years. */
export function computeBalanceChain(input: BalanceChainInput): Balance {
  let carryIn = 0;
  let result: Balance | undefined;
  for (let y = Math.min(input.startYear, input.year); y <= input.year; y++) {
    const entitlement = input.entitlementFor(y);
    const adjustments = input.adjustmentsFor(y);
    const takenItems = input.takenFor(y);
    const taken = sumAmounts(takenItems);
    const carryover = Math.min(carryIn, input.carryoverMax);
    const expiryDate = `${y}-${input.carryoverExpiry}`;
    parseDate(expiryDate);
    const takenBeforeExpiry = sumAmounts(takenItems.filter((t) => t.date <= expiryDate));
    const carryUsed = Math.min(carryover, takenBeforeExpiry);
    // Past years are always fully evaluated; the requested year only after the expiry date.
    const evaluateExpiry = y < input.year || input.asOf > expiryDate;
    const carryoverExpired = evaluateExpiry ? round2(carryover - carryUsed) : 0;
    const remaining = round2(entitlement + carryover - carryoverExpired + adjustments - taken);
    result = { year: y, entitlement, carryover, carryoverExpired, adjustments, taken, remaining };
    carryIn = Math.max(0, remaining);
  }
  return result!;
}
