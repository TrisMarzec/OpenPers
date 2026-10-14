/** ISO calendar date `YYYY-MM-DD`. All date math is done in UTC to avoid DST drift. */
export type ISODate = string;

/** Working hours per weekday, index 0 = Monday … 6 = Sunday. */
export type WeekHours = [number, number, number, number, number, number, number];

export interface ScheduleVersion {
  validFrom: ISODate;
  hours: WeekHours | number[];
}

const DAY_MS = 86_400_000;

export function parseDate(iso: ISODate): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) throw new Error(`Invalid date: ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${iso}`);
  return d;
}

export function toISODate(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(iso: ISODate, days: number): ISODate {
  return toISODate(new Date(parseDate(iso).getTime() + days * DAY_MS));
}

export function makeDate(year: number, month: number, day: number): ISODate {
  return toISODate(new Date(Date.UTC(year, month - 1, day)));
}

/** 0 = Monday … 6 = Sunday */
export function weekdayIndex(iso: ISODate): number {
  return (parseDate(iso).getUTCDay() + 6) % 7;
}

export function eachDay(start: ISODate, end: ISODate): ISODate[] {
  if (end < start) throw new Error(`End ${end} is before start ${start}`);
  const out: ISODate[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysBetween(start: ISODate, end: ISODate): number {
  return Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / DAY_MS);
}

export function scheduleFor(date: ISODate, schedules: ScheduleVersion[]): ScheduleVersion | undefined {
  let best: ScheduleVersion | undefined;
  for (const s of schedules) {
    if (s.validFrom <= date && (!best || s.validFrom > best.validFrom)) best = s;
  }
  return best;
}

export function scheduledHours(date: ISODate, schedules: ScheduleVersion[]): number {
  const s = scheduleFor(date, schedules);
  return s ? (s.hours[weekdayIndex(date)] ?? 0) : 0;
}

export function yearOf(iso: ISODate): number {
  return Number(iso.slice(0, 4));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
