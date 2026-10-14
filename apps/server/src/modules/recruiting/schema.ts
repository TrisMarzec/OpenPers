import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgUnits, workplaces } from '../org/schema';
import { persons } from '../people/schema';

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    title: text('title').notNull(),
    slug: text('slug').notNull(),
    departmentOrgUnitId: uuid('department_org_unit_id').references(() => orgUnits.id, { onDelete: 'set null' }),
    workplaceId: uuid('workplace_id').references(() => workplaces.id, { onDelete: 'set null' }),
    category: text('category'),
    employmentType: text('employment_type').notNull().default('FULL_TIME'),
    description: text('description').notNull().default(''),
    /** draft | published | closed */
    status: text('status').notNull().default('draft'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('jobs_slug_idx').on(t.slug)],
);

export const hiringTeamMembers = pgTable('hiring_team_members', {
  id: id(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull(),
  role: text('role').notNull().default('interviewer'),
});

export const pipelineStages = pgTable('pipeline_stages', {
  id: id(),
  name: text('name').notNull(),
  position: integer('position').notNull(),
  /** applied | screening | interview | offer | hired | rejected */
  kind: text('kind').notNull(),
  createdAt: createdAt(),
});

export const candidates = pgTable(
  'candidates',
  {
    id: id(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone'),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('candidates_email_idx').on(t.email)],
);

export const applications = pgTable(
  'applications',
  {
    id: id(),
    jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
    candidateId: uuid('candidate_id').notNull().references(() => candidates.id, { onDelete: 'cascade' }),
    stageId: uuid('stage_id').notNull().references(() => pipelineStages.id, { onDelete: 'restrict' }),
    channel: text('channel').notNull().default('career_page'),
    coverLetter: text('cover_letter'),
    rating: integer('rating'),
    cvFileKey: text('cv_file_key'),
    cvName: text('cv_name'),
    cvMime: text('cv_mime'),
    appliedAt: createdAt(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    hiredPersonId: uuid('hired_person_id').references(() => persons.id, { onDelete: 'set null' }),
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('applications_job_idx').on(t.jobId)],
);

export const applicationStageTransitions = pgTable('application_stage_transitions', {
  id: id(),
  applicationId: uuid('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  fromStageId: uuid('from_stage_id'),
  toStageId: uuid('to_stage_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  at: createdAt(),
});

export const applicationNotes = pgTable('application_notes', {
  id: id(),
  applicationId: uuid('application_id').notNull().references(() => applications.id, { onDelete: 'cascade' }),
  authorUserId: uuid('author_user_id'),
  body: text('body').notNull(),
  createdAt: createdAt(),
});
