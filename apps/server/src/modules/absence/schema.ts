import { boolean, date, index, integer, pgTable, real, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { persons } from '../people/schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const absenceTypes = pgTable('absence_types', {
  id: id(),
  name: text('name').notNull(),
  /** vacation | sick | parental | special | unpaid | overtime | other */
  category: text('category').notNull(),
  unit: text('unit').notNull().default('DAY'),
  requiresApproval: boolean('requires_approval').notNull().default(true),
  countsAgainstBalance: boolean('counts_against_balance').notNull().default(false),
  allowsSubstitute: boolean('allows_substitute').notNull().default(false),
  allowsHalfDays: boolean('allows_half_days').notNull().default(true),
  certificateRequiredAfterDays: integer('certificate_required_after_days'),
  color: text('color').notNull().default('#3b82f6'),
  active: boolean('active').notNull().default(true),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
});

export const absencePolicies = pgTable('absence_policies', {
  id: id(),
  absenceTypeId: uuid('absence_type_id').notNull().references(() => absenceTypes.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  annualEntitlement: real('annual_entitlement').notNull(),
  carryoverMax: real('carryover_max').notNull().default(0),
  /** MM-DD in the following year after which carried-over days expire. */
  carryoverExpiry: text('carryover_expiry').notNull().default('03-31'),
  /** Applies to everyone without an explicit assignment for this type. */
  isDefault: boolean('is_default').notNull().default(false),
  allowNegative: boolean('allow_negative').notNull().default(false),
  createdAt: createdAt(),
});

export const absencePolicyAssignments = pgTable(
  'absence_policy_assignments',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    policyId: uuid('policy_id').notNull().references(() => absencePolicies.id, { onDelete: 'cascade' }),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    entitlementOverride: real('entitlement_override'),
  },
  (t) => [index('policy_assignments_person_idx').on(t.personId)],
);

export const absencePeriods = pgTable(
  'absence_periods',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    typeId: uuid('type_id').notNull().references(() => absenceTypes.id, { onDelete: 'restrict' }),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    startHalf: boolean('start_half').notNull().default(false),
    endHalf: boolean('end_half').notNull().default(false),
    /** pending | approved | rejected | cancelled */
    status: text('status').notNull(),
    comment: text('comment'),
    substitutePersonId: uuid('substitute_person_id').references(() => persons.id, { onDelete: 'set null' }),
    requestedByUserId: uuid('requested_by_user_id'),
    decidedByUserId: uuid('decided_by_user_id'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionComment: text('decision_comment'),
    createdAt: createdAt(),
  },
  (t) => [index('absence_periods_person_idx').on(t.personId, t.startDate), index('absence_periods_status_idx').on(t.status)],
);

export const balanceAdjustments = pgTable('balance_adjustments', {
  id: id(),
  personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
  typeId: uuid('type_id').notNull().references(() => absenceTypes.id, { onDelete: 'cascade' }),
  year: integer('year').notNull(),
  amount: real('amount').notNull(),
  reason: text('reason').notNull(),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
});

export const customHolidays = pgTable('custom_holidays', {
  id: id(),
  date: date('date', { mode: 'string' }).notNull(),
  name: text('name').notNull(),
  /** null = company-wide, otherwise only for this region */
  region: text('region'),
  createdAt: createdAt(),
});
