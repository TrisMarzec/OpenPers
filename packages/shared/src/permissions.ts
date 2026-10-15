export const PERMISSIONS = [
  'people.read',
  'people.write',
  'people.sensitive',
  'org.manage',
  'absence.read',
  'absence.request',
  'absence.approve',
  'absence.manage',
  'time.read',
  'time.track',
  'time.approve',
  'time.manage',
  'documents.read',
  'documents.write',
  'documents.manage',
  'recruiting.read',
  'recruiting.write',
  'recruiting.manage',
  'users.manage',
  'settings.manage',
  'webhooks.manage',
  'checklists.manage',
  'analytics.read',
  'performance.manage',
  'surveys.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Whose data a role assignment applies to:
 * - all: every person
 * - org_unit: persons in the user's org units and their sub-units
 * - reports: direct and indirect reports of the user
 * - self: only the user's own person
 */
export type Scope = 'all' | 'org_unit' | 'reports' | 'self';
export const SCOPES: Scope[] = ['all', 'org_unit', 'reports', 'self'];

/**
 * Sensitive person data is grouped into categories. Each role grants a level per category,
 * separately for the user's own profile (`self`) and for other persons in the role's scope (`others`).
 */
export const DATA_CATEGORIES = ['profile', 'contact', 'personal', 'employment', 'compensation', 'payroll', 'performance'] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

export const ACCESS_LEVELS = ['none', 'view', 'edit'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export type FieldAccess = Record<DataCategory, { self: AccessLevel; others: AccessLevel }>;
export type CategoryAccess = Record<DataCategory, AccessLevel>;

const RANK: Record<AccessLevel, number> = { none: 0, view: 1, edit: 2 };
export const maxLevel = (a: AccessLevel, b: AccessLevel): AccessLevel => (RANK[a] >= RANK[b] ? a : b);
export const atLeast = (level: AccessLevel, required: AccessLevel) => RANK[level] >= RANK[required];

/** Highest level per category across several grants; missing categories count as `none`. */
export function mergeFieldAccess(grants: Partial<CategoryAccess>[]): CategoryAccess {
  const out = Object.fromEntries(DATA_CATEGORIES.map((c) => [c, 'none'])) as CategoryAccess;
  for (const g of grants) for (const c of DATA_CATEGORIES) if (g[c]) out[c] = maxLevel(out[c], g[c]!);
  return out;
}

/** Category of each built-in person field. */
export const PERSON_FIELD_CATEGORY: Record<string, DataCategory> = {
  firstName: 'profile',
  lastName: 'profile',
  preferredName: 'profile',
  email: 'profile',
  photoDocumentId: 'profile',
  phone: 'contact',
  emergencyContact: 'contact',
  birthDate: 'personal',
  gender: 'personal',
  privateAddress: 'personal',
  language: 'personal',
};

const all = (self: AccessLevel, others: AccessLevel): FieldAccess => Object.fromEntries(DATA_CATEGORIES.map((c) => [c, { self, others }])) as FieldAccess;

const EMPLOYEE_SELF: Record<DataCategory, AccessLevel> = { profile: 'view', contact: 'edit', personal: 'edit', employment: 'view', compensation: 'view', payroll: 'edit', performance: 'view' };

const fieldAccess = (others: Partial<CategoryAccess>): FieldAccess =>
  Object.fromEntries(DATA_CATEGORIES.map((c) => [c, { self: EMPLOYEE_SELF[c], others: others[c] ?? 'none' }])) as FieldAccess;

export interface RoleDefinition {
  key: string;
  name: string;
  permissions: Permission[];
  defaultScope: Scope;
  fieldAccess: FieldAccess;
}

export const BUILTIN_ROLES: RoleDefinition[] = [
  { key: 'admin', name: 'Administrator', permissions: [...PERMISSIONS], defaultScope: 'all', fieldAccess: all('edit', 'edit') },
  {
    key: 'hr',
    name: 'HR',
    permissions: PERMISSIONS.filter((p) => !['users.manage', 'settings.manage', 'webhooks.manage'].includes(p)),
    defaultScope: 'all',
    fieldAccess: all('edit', 'edit'),
  },
  {
    key: 'manager',
    name: 'Führungskraft',
    permissions: ['people.read', 'absence.read', 'absence.approve', 'time.read', 'time.approve', 'documents.read', 'recruiting.read'],
    defaultScope: 'reports',
    // Managers write reviews and maintain goals of their team.
    fieldAccess: fieldAccess({ profile: 'view', contact: 'view', employment: 'view', performance: 'edit' }),
  },
  {
    key: 'employee',
    name: 'Mitarbeiter:in',
    permissions: ['people.read', 'absence.read', 'absence.request', 'time.read', 'time.track', 'documents.read'],
    defaultScope: 'self',
    fieldAccess: fieldAccess({ profile: 'view', contact: 'view' }),
  },
];

/** Field access for custom roles created without an explicit matrix: like employees. */
export const DEFAULT_FIELD_ACCESS: FieldAccess = fieldAccess({ profile: 'view', contact: 'view' });
