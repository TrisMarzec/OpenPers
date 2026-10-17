import { boolean, index, integer, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgUnits } from '../org/schema';
import { persons } from '../people/schema';

/** Documents for the whole company or one department: handbook, privacy notice, policies. */
export const companyDocuments = pgTable(
  'company_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    description: text('description'),
    /** Original file name, used for the download. */
    fileName: text('file_name').notNull(),
    fileKey: text('file_key').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    /** Employees have to confirm that they have read the document. */
    requiresAck: boolean('requires_ack').notNull().default(false),
    /** Audience: everyone, or the members of this org unit. */
    orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
    uploadedByUserId: uuid('uploaded_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('company_documents_unit_idx').on(t.orgUnitId)],
);

export const companyDocumentAcks = pgTable(
  'company_document_acks',
  {
    documentId: uuid('document_id').notNull().references(() => companyDocuments.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.personId] })],
);
