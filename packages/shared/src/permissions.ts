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

export interface RoleDefinition {
  key: string;
  name: string;
  permissions: Permission[];
  defaultScope: Scope;
}

export const BUILTIN_ROLES: RoleDefinition[] = [
  { key: 'admin', name: 'Administrator', permissions: [...PERMISSIONS], defaultScope: 'all' },
  {
    key: 'hr',
    name: 'HR',
    permissions: PERMISSIONS.filter((p) => !['users.manage', 'settings.manage', 'webhooks.manage'].includes(p)),
    defaultScope: 'all',
  },
  {
    key: 'manager',
    name: 'Führungskraft',
    permissions: ['people.read', 'absence.read', 'absence.approve', 'time.read', 'time.approve', 'documents.read', 'recruiting.read'],
    defaultScope: 'reports',
  },
  {
    key: 'employee',
    name: 'Mitarbeiter:in',
    permissions: ['people.read', 'absence.read', 'absence.request', 'time.read', 'time.track', 'documents.read'],
    defaultScope: 'self',
  },
];
