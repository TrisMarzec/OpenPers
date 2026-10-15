import { describe, expect, it } from 'vitest';
import { enps, MIN_PEER_REVIEWS, MIN_SURVEY_GROUP, summarizeChoice, summarizeScale, visibleGroup } from '../src/feedback';
import { BUILTIN_ROLES, DATA_CATEGORIES } from '../src/permissions';

describe('enps', () => {
  it('is promoters minus detractors in percent', () => {
    // 9,10 promoters; 7,8 passives; 0–6 detractors
    expect(enps([10, 9, 9, 8, 7, 6, 3, 10, 10, 0])).toEqual({ score: 20, promoters: 5, passives: 2, detractors: 3, count: 10 });
  });
  it('is 0 without answers', () => {
    expect(enps([]).score).toBe(0);
  });
});

describe('summarizeScale', () => {
  it('returns average and distribution over the scale', () => {
    expect(summarizeScale([5, 4, 4, 2], 1, 5)).toEqual({ count: 4, average: 3.8, distribution: [0, 1, 0, 2, 1] });
  });
  it('ignores values outside the scale', () => {
    expect(summarizeScale([5, 9, 0], 1, 5).count).toBe(1);
  });
});

describe('summarizeChoice', () => {
  it('counts each option, keeping the option order', () => {
    expect(summarizeChoice(['B', 'A', 'B', 'X'], ['A', 'B', 'C'])).toEqual([
      { option: 'A', count: 1 },
      { option: 'B', count: 2 },
      { option: 'C', count: 0 },
    ]);
  });
});

describe('anonymity thresholds', () => {
  it('shows survey groups only from 3 answers and peer results from 2 reviews', () => {
    expect(MIN_SURVEY_GROUP).toBe(3);
    expect(MIN_PEER_REVIEWS).toBe(2);
    expect(visibleGroup(2)).toBe(false);
    expect(visibleGroup(3)).toBe(true);
  });
});

describe('performance data category', () => {
  it('exists and keeps results away from colleagues', () => {
    expect(DATA_CATEGORIES).toContain('performance');
    const emp = BUILTIN_ROLES.find((r) => r.key === 'employee')!;
    const mgr = BUILTIN_ROLES.find((r) => r.key === 'manager')!;
    const hr = BUILTIN_ROLES.find((r) => r.key === 'hr')!;
    expect(emp.fieldAccess.performance).toEqual({ self: 'view', others: 'none' });
    expect(mgr.fieldAccess.performance.others).toBe('edit');
    expect(hr.permissions).toEqual(expect.arrayContaining(['performance.manage', 'surveys.manage']));
    expect(mgr.permissions).not.toContain('surveys.manage');
  });
});
