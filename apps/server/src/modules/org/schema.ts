import { pgTable, text, timestamp, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const legalEntities = pgTable('legal_entities', {
  id: id(),
  name: text('name').notNull(),
  country: text('country').notNull().default('DE'),
  region: text('region').notNull(),
  address: text('address'),
  createdAt: createdAt(),
});

export const orgUnits = pgTable('org_units', {
  id: id(),
  name: text('name').notNull(),
  type: text('type').notNull().default('department'),
  parentId: uuid('parent_id').references((): AnyPgColumn => orgUnits.id, { onDelete: 'set null' }),
  headPersonId: uuid('head_person_id'),
  createdAt: createdAt(),
});

export const workplaces = pgTable('workplaces', {
  id: id(),
  name: text('name').notNull(),
  region: text('region').notNull(),
  address: text('address'),
  createdAt: createdAt(),
});

export const costCenters = pgTable('cost_centers', {
  id: id(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  createdAt: createdAt(),
});
