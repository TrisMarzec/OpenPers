import { boolean, date, index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const id = () => uuid('id').primaryKey().defaultRandom();

export interface SurveyQuestion {
  id: string;
  /** scale (1–5) | enps (0–10) | choice | text */
  type: 'scale' | 'enps' | 'choice' | 'text';
  text: string;
  options?: string[];
  required: boolean;
}

export const surveys = pgTable('surveys', {
  id: id(),
  title: text('title').notNull(),
  intro: text('intro'),
  anonymous: boolean('anonymous').notNull().default(true),
  /** Audience: everyone, or members of this org unit. */
  orgUnitId: uuid('org_unit_id'),
  questions: jsonb('questions').$type<SurveyQuestion[]>().notNull(),
  /** draft | open | closed */
  status: text('status').notNull().default('draft'),
  closesAt: date('closes_at', { mode: 'string' }),
  openedAt: timestamp('opened_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  reminderSentAt: timestamp('reminder_sent_at', { withTimezone: true }),
  createdByUserId: uuid('created_by_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Answers. Deliberately without user, person or timestamp so a response cannot be traced back
 * to the participant, not even by matching times against `survey_participants`.
 */
export const surveyResponses = pgTable(
  'survey_responses',
  {
    id: id(),
    surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'cascade' }),
    /** Respondent's org unit, used only for aggregated breakdowns of at least 3 answers. */
    orgUnitId: uuid('org_unit_id'),
    answers: jsonb('answers').$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('survey_responses_survey_idx').on(t.surveyId)],
);

/** Who has answered (to prevent double answers and send reminders) – never linked to the answers. */
export const surveyParticipants = pgTable(
  'survey_participants',
  {
    surveyId: uuid('survey_id').notNull().references(() => surveys.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    submittedOn: date('submitted_on', { mode: 'string' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.surveyId, t.userId] })],
);
