import { boolean, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { persons } from '../people/schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const documentCategories = pgTable('document_categories', {
  id: id(),
  name: text('name').notNull(),
  /** Default visibility for employees of new documents in this category. */
  employeeVisible: boolean('employee_visible').notNull().default(false),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
});

export const documents = pgTable(
  'documents',
  {
    id: id(),
    ownerPersonId: uuid('owner_person_id').references(() => persons.id, { onDelete: 'cascade' }),
    categoryId: uuid('category_id').references(() => documentCategories.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    fileKey: text('file_key').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    documentDate: date('document_date', { mode: 'string' }),
    employeeVisible: boolean('employee_visible').notNull().default(false),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('documents_owner_idx').on(t.ownerPersonId)],
);

export const documentTemplates = pgTable('document_templates', {
  id: id(),
  name: text('name').notNull(),
  /** Markdown with {{placeholders}} */
  body: text('body').notNull(),
  categoryId: uuid('category_id').references(() => documentCategories.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
});
