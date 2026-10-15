import { describe, expect, it } from 'vitest';
import { headcountAt, monthRange, movementsInMonth, suppressSmallGroups, tenureBucket, turnoverRate } from '../src/analytics';
import { BUILTIN_ROLES } from '../src/permissions';

const e = (personId: string, startDate: string, endDate: string | null = null) => ({ personId, startDate, endDate });

describe('monthRange', () => {
  it('lists months inclusive across a year boundary', () => {
    expect(monthRange('2025-11', '2026-02')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });
});

describe('headcountAt', () => {
  it('counts persons with an employment active on the date, once per person', () => {
    const emps = [e('a', '2025-01-01'), e('b', '2025-06-01', '2025-12-31'), e('c', '2026-03-01'), e('a', '2024-01-01', '2024-12-31'), e('d', '2025-01-01', '2025-05-31'), e('d', '2025-06-01')];
    expect(headcountAt(emps, '2025-12-31')).toBe(3);
    expect(headcountAt(emps, '2026-01-01')).toBe(2);
    expect(headcountAt(emps, '2026-03-01')).toBe(3);
  });
});

describe('movementsInMonth', () => {
  it('counts hires and exits but not a seamless change of employment', () => {
    const emps = [e('a', '2026-01-15'), e('b', '2025-01-01', '2026-01-31'), e('d', '2025-01-01', '2026-01-31'), e('d', '2026-02-01')];
    expect(movementsInMonth(emps, '2026-01')).toEqual({ hires: 1, exits: 1 });
    expect(movementsInMonth(emps, '2026-02')).toEqual({ hires: 0, exits: 0 });
  });
});

describe('turnoverRate', () => {
  it('is exits per average headcount in percent', () => {
    expect(turnoverRate(3, 30)).toBe(10);
    expect(turnoverRate(1, 0)).toBe(0);
  });
});

describe('tenureBucket', () => {
  it.each([
    ['2026-06-01', 'lt1'],
    ['2024-01-01', '1to3'],
    ['2022-01-01', '3to5'],
    ['2015-01-01', 'gt5'],
  ])('%s → %s', (start, bucket) => {
    expect(tenureBucket(start, '2026-10-15')).toBe(bucket);
  });
});

describe('suppressSmallGroups', () => {
  it('merges groups smaller than the minimum into "other" to protect privacy', () => {
    expect(suppressSmallGroups([{ key: 'A', count: 5 }, { key: 'B', count: 2 }, { key: 'C', count: 1 }], 3)).toEqual([
      { key: 'A', count: 5 },
      { key: 'other', count: 3 },
    ]);
  });
});

describe('new permissions', () => {
  it('gives HR checklist management and analytics, but not managers', () => {
    const hr = BUILTIN_ROLES.find((r) => r.key === 'hr')!;
    const mgr = BUILTIN_ROLES.find((r) => r.key === 'manager')!;
    expect(hr.permissions).toEqual(expect.arrayContaining(['checklists.manage', 'analytics.read']));
    expect(mgr.permissions).not.toContain('analytics.read');
  });
});
