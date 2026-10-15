import { boolean, date, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgUnits, workplaces } from '../org/schema';
import { persons } from '../people/schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const checklistTemplates = pgTable('checklist_templates', {
  id: id(),
  name: text('name').notNull(),
  /** onboarding | offboarding */
  kind: text('kind').notNull(),
  /** Only applied automatically to employments in this unit / at this workplace (null = everyone). */
  orgUnitId: uuid('org_unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
  workplaceId: uuid('workplace_id').references(() => workplaces.id, { onDelete: 'set null' }),
  /** Started automatically for new hires / leavers. */
  autoStart: boolean('auto_start').notNull().default(false),
  active: boolean('active').notNull().default(true),
  createdAt: createdAt(),
});

export const checklistTemplateTasks = pgTable('checklist_template_tasks', {
  id: id(),
  templateId: uuid('template_id').notNull().references(() => checklistTemplates.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  /** hr | manager | employee | person */
  assignee: text('assignee').notNull(),
  assigneePersonId: uuid('assignee_person_id').references(() => persons.id, { onDelete: 'set null' }),
  /** Due date relative to the reference date (start or end of employment). */
  offsetDays: integer('offset_days').notNull().default(0),
  position: integer('position').notNull().default(0),
});

export const checklists = pgTable(
  'checklists',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    templateId: uuid('template_id').references(() => checklistTemplates.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    referenceDate: date('reference_date', { mode: 'string' }).notNull(),
    /** open | done */
    status: text('status').notNull().default('open'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
  },
  (t) => [index('checklists_person_idx').on(t.personId)],
);

export const checklistTasks = pgTable(
  'checklist_tasks',
  {
    id: id(),
    checklistId: uuid('checklist_id').notNull().references(() => checklists.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    /** hr | manager | employee | person – for display and for unresolved assignees */
    assigneeRole: text('assignee_role').notNull(),
    /** Resolved user; null = open to everyone with checklists.manage. */
    assigneeUserId: uuid('assignee_user_id'),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    doneAt: timestamp('done_at', { withTimezone: true }),
    doneByUserId: uuid('done_by_user_id'),
    remindedAt: timestamp('reminded_at', { withTimezone: true }),
    position: integer('position').notNull().default(0),
  },
  (t) => [index('checklist_tasks_assignee_idx').on(t.assigneeUserId, t.doneAt)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    /** e.g. task_assigned, task_overdue, absence_requested, absence_approved, absence_rejected, application_received */
    kind: text('kind').notNull(),
    /** Parameters for the client-side, translated message. */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('notifications_user_idx').on(t.userId, t.readAt)],
);
