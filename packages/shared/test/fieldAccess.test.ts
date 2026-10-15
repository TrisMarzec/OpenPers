import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, DATA_CATEGORIES, PERSON_FIELD_CATEGORY, atLeast, maxLevel, mergeFieldAccess } from '../src/permissions';

const role = (key: string) => BUILTIN_ROLES.find((r) => r.key === key)!;

describe('field access defaults', () => {
  it('gives every built-in role a level for every category, own and others', () => {
    for (const r of BUILTIN_ROLES) {
      for (const c of DATA_CATEGORIES) {
        expect(['none', 'view', 'edit']).toContain(r.fieldAccess[c].self);
        expect(['none', 'view', 'edit']).toContain(r.fieldAccess[c].others);
      }
    }
  });

  it('keeps salary and bank data away from managers by default', () => {
    expect(role('manager').fieldAccess.compensation.others).toBe('none');
    expect(role('manager').fieldAccess.payroll.others).toBe('none');
    expect(role('manager').fieldAccess.personal.others).toBe('none');
    expect(role('manager').fieldAccess.employment.others).toBe('view');
  });

  it('lets employees maintain their own contact, personal and bank data but only read salary', () => {
    const e = role('employee').fieldAccess;
    expect(e.contact.self).toBe('edit');
    expect(e.personal.self).toBe('edit');
    expect(e.payroll.self).toBe('edit');
    expect(e.compensation.self).toBe('view');
    expect(e.profile.self).toBe('view');
    expect(e.personal.others).toBe('none');
  });

  it('maps every editable person field to a category', () => {
    expect(PERSON_FIELD_CATEGORY.birthDate).toBe('personal');
    expect(PERSON_FIELD_CATEGORY.phone).toBe('contact');
    expect(PERSON_FIELD_CATEGORY.lastName).toBe('profile');
  });
});

describe('level helpers', () => {
  it('orders levels', () => {
    expect(maxLevel('none', 'view')).toBe('view');
    expect(maxLevel('edit', 'view')).toBe('edit');
    expect(atLeast('edit', 'view')).toBe(true);
    expect(atLeast('none', 'view')).toBe(false);
  });

  it('merges several roles to the highest level per category', () => {
    const merged = mergeFieldAccess([{ profile: 'view', compensation: 'none' }, { compensation: 'view' }]);
    expect(merged.profile).toBe('view');
    expect(merged.compensation).toBe('view');
    expect(merged.payroll).toBe('none');
  });
});
