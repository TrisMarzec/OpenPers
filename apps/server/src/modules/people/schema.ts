import { date, index, integer, jsonb, pgTable, primaryKey, real, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { costCenters, legalEntities, orgUnits, workplaces } from '../org/schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const persons = pgTable(
  'persons',
  {
    id: id(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    preferredName: text('preferred_name'),
    email: text('email').notNull(),
    gender: text('gender').notNull().default('UNKNOWN'),
    birthDate: date('birth_date', { mode: 'string' }),
    phone: text('phone'),
    privateAddress: text('private_address'),
    emergencyContact: text('emergency_contact'),
    language: text('language').notNull().default('de'),
    photoDocumentId: uuid('photo_document_id'),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('persons_email_idx').on(t.email)],
);

export const employments = pgTable(
  'employments',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    employeeNumber: text('employee_number'),
    status: text('status').notNull().default('ACTIVE'),
    type: text('type').notNull().default('INTERNAL'),
    contractType: text('contract_type').notNull().default('PERMANENT'),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }),
    probationEndDate: date('probation_end_date', { mode: 'string' }),
    positionTitle: text('position_title'),
    legalEntityId: uuid('legal_entity_id').references(() => legalEntities.id, { onDelete: 'set null' }),
    workplaceId: uuid('workplace_id').references(() => workplaces.id, { onDelete: 'set null' }),
    supervisorPersonId: uuid('supervisor_person_id').references(() => persons.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('employments_person_idx').on(t.personId), index('employments_supervisor_idx').on(t.supervisorPersonId)],
);

export const employmentOrgUnits = pgTable(
  'employment_org_units',
  {
    employmentId: uuid('employment_id').notNull().references(() => employments.id, { onDelete: 'cascade' }),
    orgUnitId: uuid('org_unit_id').notNull().references(() => orgUnits.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.employmentId, t.orgUnitId] })],
);

export const employmentCostCenters = pgTable(
  'employment_cost_centers',
  {
    employmentId: uuid('employment_id').notNull().references(() => employments.id, { onDelete: 'cascade' }),
    costCenterId: uuid('cost_center_id').notNull().references(() => costCenters.id, { onDelete: 'cascade' }),
    weight: integer('weight').notNull().default(100),
  },
  (t) => [primaryKey({ columns: [t.employmentId, t.costCenterId] })],
);

export const workSchedules = pgTable(
  'work_schedules',
  {
    id: id(),
    employmentId: uuid('employment_id').notNull().references(() => employments.id, { onDelete: 'cascade' }),
    validFrom: date('valid_from', { mode: 'string' }).notNull(),
    hours: jsonb('hours').$type<number[]>().notNull(),
    fullTimeWeeklyHours: real('full_time_weekly_hours').notNull().default(40),
  },
  (t) => [uniqueIndex('work_schedules_valid_idx').on(t.employmentId, t.validFrom)],
);

/** Scheduled changes to an employment, applied on their effective date. */
export const employmentChanges = pgTable('employment_changes', {
  id: id(),
  employmentId: uuid('employment_id').notNull().references(() => employments.id, { onDelete: 'cascade' }),
  effectiveDate: date('effective_date', { mode: 'string' }).notNull(),
  changes: jsonb('changes').$type<Record<string, unknown>>().notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
});

export const attributeDefinitions = pgTable(
  'attribute_definitions',
  {
    id: id(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    type: text('type').notNull(),
    options: jsonb('options').$type<string[]>(),
    section: text('section').notNull().default('general'),
    sensitive: integer('sensitive').notNull().default(0),
    position: integer('position').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('attribute_definitions_key_idx').on(t.key)],
);

export const attributeValues = pgTable(
  'attribute_values',
  {
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id').notNull().references(() => attributeDefinitions.id, { onDelete: 'cascade' }),
    /** Plain JSON value, or `{ enc: "<base64>" }` for sensitive attributes. */
    value: jsonb('value').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.definitionId] })],
);
