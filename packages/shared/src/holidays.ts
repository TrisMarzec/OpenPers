import { addDays, makeDate, weekdayIndex, type ISODate } from './dates';

export const GERMAN_STATES = ['BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV', 'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'] as const;
export type GermanState = (typeof GERMAN_STATES)[number];
export type Region = `DE-${GermanState}` | 'AT' | 'CH';
export const REGIONS: Region[] = [...GERMAN_STATES.map((s) => `DE-${s}` as Region), 'AT', 'CH'];

export const REGION_NAMES: Record<Region, string> = {
  'DE-BW': 'Baden-Württemberg', 'DE-BY': 'Bayern', 'DE-BE': 'Berlin', 'DE-BB': 'Brandenburg',
  'DE-HB': 'Bremen', 'DE-HH': 'Hamburg', 'DE-HE': 'Hessen', 'DE-MV': 'Mecklenburg-Vorpommern',
  'DE-NI': 'Niedersachsen', 'DE-NW': 'Nordrhein-Westfalen', 'DE-RP': 'Rheinland-Pfalz', 'DE-SL': 'Saarland',
  'DE-SN': 'Sachsen', 'DE-ST': 'Sachsen-Anhalt', 'DE-SH': 'Schleswig-Holstein', 'DE-TH': 'Thüringen',
  AT: 'Österreich', CH: 'Schweiz',
};

export interface Holiday {
  date: ISODate;
  name: string;
}

/** Anonymous Gregorian algorithm (Meeus/Jones/Butcher). */
export function easterSunday(year: number): ISODate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return makeDate(year, month, day);
}

function bussUndBettag(year: number): ISODate {
  // Wednesday before 23 November
  let d = makeDate(year, 11, 22);
  while (weekdayIndex(d) !== 2) d = addDays(d, -1);
  return d;
}

function germanHolidays(year: number, state: GermanState): Holiday[] {
  const easter = easterSunday(year);
  const list: Holiday[] = [
    { date: makeDate(year, 1, 1), name: 'Neujahr' },
    { date: addDays(easter, -2), name: 'Karfreitag' },
    { date: addDays(easter, 1), name: 'Ostermontag' },
    { date: makeDate(year, 5, 1), name: 'Tag der Arbeit' },
    { date: addDays(easter, 39), name: 'Christi Himmelfahrt' },
    { date: addDays(easter, 50), name: 'Pfingstmontag' },
    { date: makeDate(year, 10, 3), name: 'Tag der Deutschen Einheit' },
    { date: makeDate(year, 12, 25), name: '1. Weihnachtstag' },
    { date: makeDate(year, 12, 26), name: '2. Weihnachtstag' },
  ];
  const add = (states: GermanState[], date: ISODate, name: string) => {
    if (states.includes(state)) list.push({ date, name });
  };
  add(['BW', 'BY', 'ST'], makeDate(year, 1, 6), 'Heilige Drei Könige');
  if (year >= 2019) add(['BE'], makeDate(year, 3, 8), 'Internationaler Frauentag');
  if (year >= 2023) add(['MV'], makeDate(year, 3, 8), 'Internationaler Frauentag');
  add(['BB'], easter, 'Ostersonntag');
  add(['BB'], addDays(easter, 49), 'Pfingstsonntag');
  add(['BW', 'BY', 'HE', 'NW', 'RP', 'SL'], addDays(easter, 60), 'Fronleichnam');
  add(['SL'], makeDate(year, 8, 15), 'Mariä Himmelfahrt');
  if (year >= 2019) add(['TH'], makeDate(year, 9, 20), 'Weltkindertag');
  const reformation: GermanState[] = year === 2017 ? [...GERMAN_STATES] : year >= 2018 ? ['BB', 'MV', 'SN', 'ST', 'TH', 'HB', 'HH', 'NI', 'SH'] : ['BB', 'MV', 'SN', 'ST', 'TH'];
  add(reformation, makeDate(year, 10, 31), 'Reformationstag');
  add(['BW', 'BY', 'NW', 'RP', 'SL'], makeDate(year, 11, 1), 'Allerheiligen');
  add(['SN'], bussUndBettag(year), 'Buß- und Bettag');
  return list;
}

function austrianHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  return [
    { date: makeDate(year, 1, 1), name: 'Neujahr' },
    { date: makeDate(year, 1, 6), name: 'Heilige Drei Könige' },
    { date: addDays(easter, 1), name: 'Ostermontag' },
    { date: makeDate(year, 5, 1), name: 'Staatsfeiertag' },
    { date: addDays(easter, 39), name: 'Christi Himmelfahrt' },
    { date: addDays(easter, 50), name: 'Pfingstmontag' },
    { date: addDays(easter, 60), name: 'Fronleichnam' },
    { date: makeDate(year, 8, 15), name: 'Mariä Himmelfahrt' },
    { date: makeDate(year, 10, 26), name: 'Nationalfeiertag' },
    { date: makeDate(year, 11, 1), name: 'Allerheiligen' },
    { date: makeDate(year, 12, 8), name: 'Mariä Empfängnis' },
    { date: makeDate(year, 12, 25), name: 'Christtag' },
    { date: makeDate(year, 12, 26), name: 'Stefanitag' },
  ];
}

/** Swiss holidays observed in most cantons; cantonal specifics can be added as custom holidays. */
function swissHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  return [
    { date: makeDate(year, 1, 1), name: 'Neujahr' },
    { date: addDays(easter, -2), name: 'Karfreitag' },
    { date: addDays(easter, 1), name: 'Ostermontag' },
    { date: addDays(easter, 39), name: 'Auffahrt' },
    { date: addDays(easter, 50), name: 'Pfingstmontag' },
    { date: makeDate(year, 8, 1), name: 'Bundesfeier' },
    { date: makeDate(year, 12, 25), name: 'Weihnachten' },
    { date: makeDate(year, 12, 26), name: 'Stephanstag' },
  ];
}

const cache = new Map<string, Holiday[]>();

export function getHolidays(year: number, region: Region): Holiday[] {
  const key = `${year}:${region}`;
  let list = cache.get(key);
  if (!list) {
    if (region === 'AT') list = austrianHolidays(year);
    else if (region === 'CH') list = swissHolidays(year);
    else if (region.startsWith('DE-')) list = germanHolidays(year, region.slice(3) as GermanState);
    else throw new Error(`Unknown region: ${region}`);
    list.sort((a, b) => a.date.localeCompare(b.date));
    cache.set(key, list);
  }
  return list;
}

export function holidayName(date: ISODate, region: Region): string | undefined {
  return getHolidays(Number(date.slice(0, 4)), region).find((h) => h.date === date)?.name;
}

export function isHoliday(date: ISODate, region: Region): boolean {
  return holidayName(date, region) !== undefined;
}
