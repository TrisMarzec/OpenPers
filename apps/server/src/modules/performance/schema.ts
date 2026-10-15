import { boolean, date, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { persons } from '../people/schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export interface ReviewQuestion {
  id: string;
  type: 'rating' | 'text';
  text: string;
  required: boolean;
}

export const reviewCycles = pgTable('review_cycles', {
  id: id(),
  name: text('name').notNull(),
  periodStart: date('period_start', { mode: 'string' }),
  periodEnd: date('period_end', { mode: 'string' }),
  dueDate: date('due_date', { mode: 'string' }),
  /** draft | active | closed */
  status: text('status').notNull().default('draft'),
  selfReview: boolean('self_review').notNull().default(true),
  managerReview: boolean('manager_review').notNull().default(true),
  peerReview: boolean('peer_review').notNull().default(false),
  questions: jsonb('questions').$type<ReviewQuestion[]>().notNull(),
  /** Explicit participants; empty = everyone active (optionally limited to orgUnitId). */
  participantPersonIds: jsonb('participant_person_ids').$type<string[]>().notNull().default([]),
  orgUnitId: uuid('org_unit_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: createdAt(),
});

export const reviews = pgTable(
  'reviews',
  {
    id: id(),
    cycleId: uuid('cycle_id').notNull().references(() => reviewCycles.id, { onDelete: 'cascade' }),
    revieweeId: uuid('reviewee_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    reviewerPersonId: uuid('reviewer_person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    /** self | manager | peer */
    type: text('type').notNull(),
    /** pending | submitted */
    status: text('status').notNull().default('pending'),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull().default({}),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('reviews_cycle_reviewee_idx').on(t.cycleId, t.revieweeId), index('reviews_reviewer_idx').on(t.reviewerPersonId)],
);

/** Results shared with the reviewee (manager review + peer summary). */
export const reviewReleases = pgTable(
  'review_releases',
  {
    cycleId: uuid('cycle_id').notNull().references(() => reviewCycles.id, { onDelete: 'cascade' }),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
    releasedByUserId: uuid('released_by_user_id'),
  },
  (t) => [primaryKey({ columns: [t.cycleId, t.personId] })],
);

export const goals = pgTable(
  'goals',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    description: text('description'),
    dueDate: date('due_date', { mode: 'string' }),
    progress: integer('progress').notNull().default(0),
    /** open | achieved | dropped */
    status: text('status').notNull().default('open'),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('goals_person_idx').on(t.personId)],
);

export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    personId: uuid('person_id').notNull().references(() => persons.id, { onDelete: 'cascade' }),
    authorPersonId: uuid('author_person_id').references(() => persons.id, { onDelete: 'set null' }),
    /** praise (visible to the person) | private (manager and HR only) */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('feedback_person_idx').on(t.personId)],
);
