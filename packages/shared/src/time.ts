import { eachDay, scheduledHours, type ISODate, type ScheduleVersion } from './dates';
import { holidayName, type Region } from './holidays';

export type ArbZGCode = 'BREAK_6H' | 'BREAK_9H' | 'MAX_10H' | 'REST_11H';

export interface ArbZGWarning {
  code: ArbZGCode;
  message: string;
}

export interface WorkInterval {
  /** Local date-time `YYYY-MM-DDTHH:mm:ss` without offset. */
  start: string;
  end: string;
  /** Unpaid break recorded inside this interval. */
  breakMinutes?: number;
}

const minutes = (from: string, to: string) => (Date.parse(`${to}Z`) - Date.parse(`${from}Z`)) / 60_000;

/** Statutory minimum break for a day's working time (ArbZG §4). */
export function requiredBreakMinutes(workMinutes: number): number {
  if (workMinutes > 9 * 60) return 45;
  if (workMinutes > 6 * 60) return 30;
  return 0;
}

/**
 * Checks one day's WORK intervals against the German Working Hours Act (ArbZG §§3–5).
 * Breaks are the gaps between work intervals plus recorded break minutes; only segments
 * of ≥ 15 minutes count (§4). Returns warnings only – OpenPers never blocks time entries.
 */
export function checkArbZG(work: WorkInterval[], previousWorkEnd?: string): ArbZGWarning[] {
  const sorted = [...work].sort((a, b) => a.start.localeCompare(b.start));
  const recordedBreaks = sorted.reduce((s, p) => s + ((p.breakMinutes ?? 0) >= 15 ? p.breakMinutes! : 0), 0);
  const workMin = sorted.reduce((s, p) => s + minutes(p.start, p.end) - (p.breakMinutes ?? 0), 0);
  let breakMin = recordedBreaks;
  for (let i = 1; i < sorted.length; i++) {
    const gap = minutes(sorted[i - 1].end, sorted[i].start);
    if (gap >= 15) breakMin += gap;
  }
  const warnings: ArbZGWarning[] = [];
  if (workMin > 10 * 60) warnings.push({ code: 'MAX_10H', message: 'Mehr als 10 Stunden Arbeitszeit (§3 ArbZG)' });
  if (workMin > 9 * 60 && breakMin < 45) warnings.push({ code: 'BREAK_9H', message: 'Über 9 Stunden Arbeit erfordern 45 Minuten Pause (§4 ArbZG)' });
  else if (workMin > 6 * 60 && breakMin < 30) warnings.push({ code: 'BREAK_6H', message: 'Über 6 Stunden Arbeit erfordern 30 Minuten Pause (§4 ArbZG)' });
  if (previousWorkEnd && sorted.length && minutes(previousWorkEnd, sorted[0].start) < 11 * 60) {
    warnings.push({ code: 'REST_11H', message: 'Weniger als 11 Stunden Ruhezeit (§5 ArbZG)' });
  }
  return warnings;
}

export interface TimeBalanceInput {
  from: ISODate;
  to: ISODate;
  schedules: ScheduleVersion[];
  region: Region;
  /** Fraction of the scheduled day covered by an approved absence (0..1). */
  absences: { date: ISODate; fraction: number }[];
  worked: { date: ISODate; minutes: number }[];
  customHolidays?: { date: ISODate }[];
}

export interface TimeBalance {
  targetMinutes: number;
  workedMinutes: number;
  balanceMinutes: number;
}

export function dailyTargetMinutes(date: ISODate, input: Pick<TimeBalanceInput, 'schedules' | 'region' | 'absences' | 'customHolidays'>): number {
  if (holidayName(date, input.region) || input.customHolidays?.some((h) => h.date === date)) return 0;
  const absent = input.absences.filter((a) => a.date === date).reduce((s, a) => s + a.fraction, 0);
  return Math.round(scheduledHours(date, input.schedules) * 60 * Math.max(0, 1 - absent));
}

export function computeTimeBalance(input: TimeBalanceInput): TimeBalance {
  const targetMinutes = eachDay(input.from, input.to).reduce((s, d) => s + dailyTargetMinutes(d, input), 0);
  const workedMinutes = input.worked.filter((w) => w.date >= input.from && w.date <= input.to).reduce((s, w) => s + w.minutes, 0);
  return { targetMinutes, workedMinutes, balanceMinutes: workedMinutes - targetMinutes };
}
