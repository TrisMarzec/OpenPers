import { describe, expect, it } from 'vitest';
import { computeBalanceChain, computeBreakdown, proratedEntitlement, sumAmounts } from '../src/absence';
import type { ScheduleVersion } from '../src/dates';

const fullTime: ScheduleVersion[] = [{ validFrom: '2000-01-01', hours: [8, 8, 8, 8, 8, 0, 0] }];

describe('computeBreakdown', () => {
  it('skips weekends and holidays (Karfreitag/Ostermontag 2026)', () => {
    // Mo 2026-03-30 .. Fr 2026-04-10 → 10 weekdays minus Karfreitag (04-03) and Ostermontag (04-06)
    const days = computeBreakdown({ start: '2026-03-30', end: '2026-04-10', schedules: fullTime, region: 'DE-BE', unit: 'DAY' });
    expect(days).toHaveLength(12);
    expect(sumAmounts(days)).toBe(8);
    expect(days.find((d) => d.date === '2026-04-04')!.amount).toBe(0);
    expect(days.find((d) => d.date === '2026-04-03')!.holiday).toBe('Karfreitag');
  });

  it('counts half days at the edges', () => {
    const days = computeBreakdown({ start: '2026-06-08', end: '2026-06-10', startHalf: true, endHalf: true, schedules: fullTime, region: 'DE-BE', unit: 'DAY' });
    expect(days.map((d) => d.amount)).toEqual([0.5, 1, 0.5]);
  });

  it('counts a single half day as 0.5', () => {
    const days = computeBreakdown({ start: '2026-06-08', end: '2026-06-08', startHalf: true, schedules: fullTime, region: 'DE-BE', unit: 'DAY' });
    expect(sumAmounts(days)).toBe(0.5);
  });

  it('respects part-time schedules and schedule changes', () => {
    const schedules: ScheduleVersion[] = [
      { validFrom: '2026-01-01', hours: [8, 8, 8, 0, 0, 0, 0] },
      { validFrom: '2026-06-15', hours: [8, 8, 8, 8, 8, 0, 0] },
    ];
    // week of 06-08: Mo–Mi = 3 days; week of 06-15: 5 days
    const days = computeBreakdown({ start: '2026-06-08', end: '2026-06-19', schedules, region: 'DE-BE', unit: 'DAY' });
    expect(sumAmounts(days)).toBe(8);
  });

  it('uses scheduled hours for HOUR unit', () => {
    const schedules: ScheduleVersion[] = [{ validFrom: '2000-01-01', hours: [6, 6, 6, 6, 6, 0, 0] }];
    const days = computeBreakdown({ start: '2026-06-08', end: '2026-06-09', schedules, region: 'DE-BE', unit: 'HOUR' });
    expect(sumAmounts(days)).toBe(12);
  });

  it('rejects end before start', () => {
    expect(() => computeBreakdown({ start: '2026-06-09', end: '2026-06-08', schedules: fullTime, region: 'DE-BE', unit: 'DAY' })).toThrow();
  });
});

describe('proratedEntitlement', () => {
  it('gives full entitlement for a full year', () => {
    expect(proratedEntitlement(30, 2026, '2020-01-01', null)).toBe(30);
  });
  it('gives 1/12 per full month when starting mid-year', () => {
    expect(proratedEntitlement(30, 2026, '2026-07-01', null)).toBe(15);
  });
  it('rounds fractions >= 0.5 up (BUrlG §5 Abs. 2)', () => {
    // Aug–Dec = 5 full months → 12.5 → 13
    expect(proratedEntitlement(30, 2026, '2026-07-15', null)).toBe(13);
  });
  it('handles leaving mid-year', () => {
    expect(proratedEntitlement(24, 2026, '2020-01-01', '2026-03-31')).toBe(6);
  });
  it('is 0 outside employment', () => {
    expect(proratedEntitlement(30, 2026, '2027-01-01', null)).toBe(0);
  });
});

describe('computeBalanceChain', () => {
  const base = {
    startYear: 2025,
    entitlementFor: () => 30,
    carryoverMax: 10,
    carryoverExpiry: '03-31',
    adjustmentsFor: () => 0,
  };
  type Taken = Record<number, { date: string; amount: number }[]>;

  it('carries over unused days up to the cap', () => {
    const taken: Taken = { 2025: [{ date: '2025-08-01', amount: 15 }] };
    const b = computeBalanceChain({ ...base, year: 2026, takenFor: (y) => taken[y] ?? [], asOf: '2026-02-01' });
    expect(b.carryover).toBe(10);
    expect(b.remaining).toBe(40);
  });

  it('expires unused carryover after the expiry date', () => {
    const taken: Taken = { 2025: [{ date: '2025-08-01', amount: 25 }], 2026: [{ date: '2026-02-02', amount: 2 }, { date: '2026-05-04', amount: 1 }] };
    const b = computeBalanceChain({ ...base, year: 2026, takenFor: (y) => taken[y] ?? [], asOf: '2026-06-01' });
    expect(b.carryover).toBe(5);
    expect(b.carryoverExpired).toBe(3);
    expect(b.taken).toBe(3);
    expect(b.remaining).toBe(29);
  });

  it('does not expire carryover before the expiry date', () => {
    const taken: Taken = { 2025: [{ date: '2025-08-01', amount: 25 }] };
    const b = computeBalanceChain({ ...base, year: 2026, takenFor: (y) => taken[y] ?? [], asOf: '2026-03-01' });
    expect(b.carryoverExpired).toBe(0);
    expect(b.remaining).toBe(35);
  });
});
