import { describe, expect, it } from 'vitest';
import { easterSunday, getHolidays, isHoliday } from '../src/holidays';

describe('easterSunday', () => {
  it.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
  ])('computes Easter %i', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });
});

describe('getHolidays', () => {
  it('includes nationwide holidays everywhere in Germany', () => {
    const be = getHolidays(2026, 'DE-BE').map((h) => h.date);
    expect(be).toEqual(
      expect.arrayContaining(['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-10-03', '2026-12-25', '2026-12-26']),
    );
  });

  it('has Fronleichnam and Allerheiligen in Bavaria but not in Berlin', () => {
    expect(isHoliday('2026-06-04', 'DE-BY')).toBe(true);
    expect(isHoliday('2026-11-01', 'DE-BY')).toBe(true);
    expect(isHoliday('2026-06-04', 'DE-BE')).toBe(false);
    expect(isHoliday('2026-11-01', 'DE-BE')).toBe(false);
  });

  it('has Frauentag in Berlin', () => {
    expect(isHoliday('2026-03-08', 'DE-BE')).toBe(true);
    expect(isHoliday('2026-03-08', 'DE-HH')).toBe(false);
  });

  it('has Buß- und Bettag only in Saxony on the Wednesday before Nov 23', () => {
    expect(isHoliday('2026-11-18', 'DE-SN')).toBe(true);
    expect(isHoliday('2026-11-18', 'DE-BY')).toBe(false);
  });

  it('has Reformationstag in Hamburg since 2018 and nationwide in 2017', () => {
    expect(isHoliday('2026-10-31', 'DE-HH')).toBe(true);
    expect(isHoliday('2017-10-31', 'DE-BY')).toBe(true);
    expect(isHoliday('2026-10-31', 'DE-BY')).toBe(false);
  });

  it('has Weltkindertag in Thuringia', () => {
    expect(isHoliday('2026-09-20', 'DE-TH')).toBe(true);
  });

  it('supports Austria', () => {
    expect(isHoliday('2026-10-26', 'AT')).toBe(true);
    expect(isHoliday('2026-12-08', 'AT')).toBe(true);
  });

  it('returns holidays sorted by date with names', () => {
    const list = getHolidays(2026, 'DE-NW');
    expect(list[0]).toEqual({ date: '2026-01-01', name: 'Neujahr' });
    const dates = list.map((h) => h.date);
    expect([...dates].sort()).toEqual(dates);
  });
});
