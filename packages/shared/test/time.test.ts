import { describe, expect, it } from 'vitest';
import { checkArbZG, computeTimeBalance, minimalCompliantBreak, requiredBreakMinutes } from '../src/time';
import type { ScheduleVersion } from '../src/dates';

const w = (start: string, end: string) => ({ start: `2026-06-08T${start}:00`, end: `2026-06-08T${end}:00` });

describe('checkArbZG', () => {
  it('accepts 8h with 30min break', () => {
    expect(checkArbZG([w('08:00', '12:00'), w('12:30', '16:30')])).toEqual([]);
  });
  it('warns when more than 6h without 30min break', () => {
    expect(checkArbZG([w('08:00', '15:00')]).map((x) => x.code)).toEqual(['BREAK_6H']);
  });
  it('warns when more than 9h with only 30min break', () => {
    expect(checkArbZG([w('07:00', '12:00'), w('12:30', '17:30')]).map((x) => x.code)).toEqual(['BREAK_9H']);
  });
  it('ignores break fragments shorter than 15 minutes', () => {
    expect(checkArbZG([w('08:00', '11:00'), w('11:10', '14:00'), w('14:10', '15:30')]).map((x) => x.code)).toEqual(['BREAK_6H']);
  });
  it('warns above 10h of work', () => {
    expect(checkArbZG([w('06:00', '12:00'), w('13:00', '18:30')]).map((x) => x.code)).toEqual(['MAX_10H']);
  });
  it('warns when rest period since previous day is under 11h', () => {
    const codes = checkArbZG([w('06:00', '10:00')], '2026-06-07T22:00:00').map((x) => x.code);
    expect(codes).toEqual(['REST_11H']);
  });
});

describe('requiredBreakMinutes', () => {
  it.each([
    [360, 0],
    [361, 30],
    [540, 30],
    [541, 45],
  ])('needs %i min work → %i min break', (work, br) => {
    expect(requiredBreakMinutes(work)).toBe(br);
  });
});

describe('minimalCompliantBreak', () => {
  it.each([
    [540, 0, 30], // 9h span → 8h30 work needs 30
    [600, 0, 45], // 10h span → needs 45 (9h15 work)
    [380, 0, 20], // 6h20 span: a 20 min break brings work to 6h, no further break needed
    [540, 40, 40], // already enough
    [300, 0, 0],
  ])('span %i min, recorded %i → %i', (span, recorded, expected) => {
    expect(minimalCompliantBreak(span, recorded)).toBe(expected);
  });
});

describe('checkArbZG with recorded break minutes', () => {
  it('counts break minutes inside a work entry', () => {
    // 08:00–16:30 with 30 min break recorded on the entry = 8h work, compliant
    expect(checkArbZG([{ ...w('08:00', '16:30'), breakMinutes: 30 }])).toEqual([]);
  });
  it('still warns when the recorded break is too short', () => {
    expect(checkArbZG([{ ...w('08:00', '17:00'), breakMinutes: 15 }]).map((x) => x.code)).toEqual(['BREAK_6H']);
  });
});

describe('computeTimeBalance', () => {
  const schedules: ScheduleVersion[] = [{ validFrom: '2000-01-01', hours: [8, 8, 8, 8, 8, 0, 0] }];

  it('computes target minus holidays and absences', () => {
    // 2026-05-11..2026-05-15: Mo–Fr, Thu 05-14 is Himmelfahrt; Fri absent full day
    const r = computeTimeBalance({
      from: '2026-05-11',
      to: '2026-05-15',
      schedules,
      region: 'DE-BE',
      absences: [{ date: '2026-05-15', fraction: 1 }],
      worked: [
        { date: '2026-05-11', minutes: 540 },
        { date: '2026-05-12', minutes: 480 },
        { date: '2026-05-13', minutes: 450 },
      ],
    });
    expect(r.targetMinutes).toBe(3 * 480);
    expect(r.workedMinutes).toBe(1470);
    expect(r.balanceMinutes).toBe(30);
  });

  it('halves target on half-day absence', () => {
    const r = computeTimeBalance({ from: '2026-05-11', to: '2026-05-11', schedules, region: 'DE-BE', absences: [{ date: '2026-05-11', fraction: 0.5 }], worked: [] });
    expect(r.targetMinutes).toBe(240);
  });
});
