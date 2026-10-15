import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { addDays, enps, MIN_SURVEY_GROUP, summarizeChoice, summarizeScale, visibleGroup } from '@openpers/shared';
import type { Exec } from '../../db';
import { employmentOrgUnits, employments, orgUnits, surveyParticipants, surveyResponses, surveys, users } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import { audit, type AppContext, type OpenPersModule } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { isoDateSchema } from '../people/service';
import { notify } from '../workflow';
import type { SurveyQuestion } from './schema';

type Survey = typeof surveys.$inferSelect;
const today = () => new Date().toISOString().slice(0, 10);
/** Reminders go out this many days before a survey closes. */
const REMINDER_DAYS = 2;

const questionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
    type: z.enum(['scale', 'enps', 'choice', 'text']),
    text: z.string().min(1).max(500),
    options: z.array(z.string().min(1).max(100)).max(20).optional(),
    required: z.boolean().default(true),
  })
  .refine((q) => q.type !== 'choice' || (q.options?.length ?? 0) >= 2, { path: ['options'], message: 'Choice questions need at least two options' });
const surveyBody = z.object({
  title: z.string().min(1).max(200),
  intro: z.string().max(2000).nullish(),
  anonymous: z.boolean().default(true),
  orgUnitId: z.string().uuid().nullish(),
  closesAt: isoDateSchema.nullish(),
  questions: z.array(questionSchema).max(40).refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, 'Question ids must be unique'),
});

/** Active users with an active employment, optionally limited to an org unit: userId → orgUnitIds. */
async function audienceOf(db: Exec, s: Survey): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ userId: users.id, employmentId: employments.id, endDate: employments.endDate, status: employments.status })
    .from(users)
    .innerJoin(employments, eq(employments.personId, users.personId))
    .where(eq(users.active, true));
  const links = await db.select().from(employmentOrgUnits);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (r.status === 'INACTIVE' || (r.endDate && r.endDate < today())) continue;
    const units = links.filter((l) => l.employmentId === r.employmentId).map((l) => l.orgUnitId);
    if (s.orgUnitId && !units.includes(s.orgUnitId)) continue;
    out.set(r.userId, [...new Set([...(out.get(r.userId) ?? []), ...units])]);
  }
  return out;
}

function checkAnswers(questions: SurveyQuestion[], answers: Record<string, unknown>) {
  const errors: { path: string; message: string }[] = [];
  for (const q of questions) {
    const v = answers[q.id];
    if (v === undefined || v === null || v === '') {
      if (q.required) errors.push({ path: q.id, message: 'Required' });
      continue;
    }
    const ok =
      q.type === 'scale' ? Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 5
      : q.type === 'enps' ? Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10
      : q.type === 'choice' ? typeof v === 'string' && !!q.options?.includes(v)
      : typeof v === 'string' && v.length <= 2000;
    if (!ok) errors.push({ path: q.id, message: 'Invalid answer' });
  }
  for (const key of Object.keys(answers)) if (!questions.some((q) => q.id === key)) errors.push({ path: key, message: 'Unknown question' });
  if (errors.length) throw unprocessable('Invalid answers', errors);
}

export const surveysModule: OpenPersModule = {
  name: 'surveys',
  register(app, ctx: AppContext) {
    const { db, authz } = ctx;
    const route = makeRoute(app, ctx.registry);

    async function load(id: string) {
      const [s] = await db.select().from(surveys).where(eq(surveys.id, id));
      if (!s) throw notFound('Survey not found');
      return s;
    }

    // Close expired surveys and remind people who have not answered yet (once).
    ctx.maintenance.push(async (c) => {
      const open = await c.db.select().from(surveys).where(eq(surveys.status, 'open'));
      for (const s of open) {
        if (s.closesAt && s.closesAt < today()) {
          await c.db.update(surveys).set({ status: 'closed', closedAt: new Date() }).where(eq(surveys.id, s.id));
          continue;
        }
        if (s.reminderSentAt || !s.closesAt || s.closesAt > addDays(today(), REMINDER_DAYS)) continue;
        await c.db.transaction(async (tx) => {
          const audience = await audienceOf(tx, s);
          const done = new Set((await tx.select().from(surveyParticipants).where(eq(surveyParticipants.surveyId, s.id))).map((p) => p.userId));
          await notify(tx, [...audience.keys()].filter((u) => !done.has(u)), 'survey_reminder', { surveyId: s.id, title: s.title, closesAt: s.closesAt }, `/surveys/${s.id}`);
          await tx.update(surveys).set({ reminderSentAt: new Date() }).where(eq(surveys.id, s.id));
        });
      }
    });

    // ---------- management ----------
    route({ method: 'GET', url: '/api/v1/surveys', perm: 'surveys.manage', tag: 'surveys', summary: 'All surveys with response counts' }, async () => {
      const list = await db.select().from(surveys).orderBy(desc(surveys.createdAt));
      const items = [];
      for (const s of list) {
        const responses = (await db.select({ id: surveyResponses.id }).from(surveyResponses).where(eq(surveyResponses.surveyId, s.id))).length;
        items.push({ ...s, responses, audience: s.status === 'draft' ? null : (await audienceOf(db, s)).size });
      }
      return { items };
    });
    route({ method: 'POST', url: '/api/v1/surveys', perm: 'surveys.manage', tag: 'surveys', summary: 'Create a survey (draft)', body: surveyBody }, async ({ user, body }, reply) => {
      const [s] = await db.insert(surveys).values({ ...body, intro: body.intro ?? null, orgUnitId: body.orgUnitId ?? null, closesAt: body.closesAt ?? null, createdByUserId: user.userId }).returning();
      await audit(db, user.userId, 'survey', s.id, 'create', { title: s.title });
      reply.code(201);
      return s;
    });
    route({ method: 'PATCH', url: '/api/v1/surveys/:id', perm: 'surveys.manage', tag: 'surveys', summary: 'Edit a draft survey', body: surveyBody.partial() }, async ({ user, body, params }) => {
      const s = await load(params.id);
      // Questions and anonymity cannot change once answers may exist.
      if (s.status !== 'draft' && (body.questions || body.anonymous !== undefined || body.orgUnitId !== undefined)) throw conflict('Only the title, intro and end date can change after opening');
      const [u] = await db.update(surveys).set(body).where(eq(surveys.id, s.id)).returning();
      await audit(db, user.userId, 'survey', s.id, 'update', { title: u.title });
      return u;
    });
    route({ method: 'DELETE', url: '/api/v1/surveys/:id', perm: 'surveys.manage', tag: 'surveys', summary: 'Delete a survey and its answers' }, async ({ user, params }) => {
      const res = await db.delete(surveys).where(eq(surveys.id, params.id)).returning();
      if (!res.length) throw notFound();
      await audit(db, user.userId, 'survey', params.id, 'delete');
    });
    route({ method: 'POST', url: '/api/v1/surveys/:id/open', perm: 'surveys.manage', tag: 'surveys', summary: 'Open the survey and notify the audience' }, async ({ user, params }) => {
      const s = await load(params.id);
      if (s.status !== 'draft') throw conflict('Survey was already opened');
      if (!s.questions.length) throw unprocessable('No questions', [{ path: 'questions', message: 'Add at least one question' }]);
      return db.transaction(async (tx) => {
        const [u] = await tx.update(surveys).set({ status: 'open', openedAt: new Date() }).where(eq(surveys.id, s.id)).returning();
        await notify(tx, [...(await audienceOf(tx, u)).keys()], 'survey_open', { surveyId: s.id, title: s.title, closesAt: s.closesAt }, `/surveys/${s.id}`);
        await audit(tx, user.userId, 'survey', s.id, 'open');
        return u;
      });
    });
    route({ method: 'POST', url: '/api/v1/surveys/:id/close', perm: 'surveys.manage', tag: 'surveys', summary: 'Close the survey' }, async ({ user, params }) => {
      const s = await load(params.id);
      const [u] = await db.update(surveys).set({ status: 'closed', closedAt: new Date() }).where(eq(surveys.id, s.id)).returning();
      await audit(db, user.userId, 'survey', s.id, 'close');
      return u;
    });

    // ---------- answering ----------
    route({ method: 'GET', url: '/api/v1/surveys/open', tag: 'surveys', summary: 'Open surveys for the caller' }, async ({ user }) => {
      const list = await db.select().from(surveys).where(eq(surveys.status, 'open'));
      const done = new Set((await db.select().from(surveyParticipants).where(eq(surveyParticipants.userId, user.userId))).map((p) => p.surveyId));
      const items = [];
      for (const s of list) if ((await audienceOf(db, s)).has(user.userId)) items.push({ ...s, answered: done.has(s.id) });
      return { items };
    });
    route({ method: 'GET', url: '/api/v1/surveys/:id/form', tag: 'surveys', summary: 'Survey questions for answering' }, async ({ user, params }) => {
      const s = await load(params.id);
      if (!(await audienceOf(db, s)).has(user.userId) && !authz.has(user, 'surveys.manage')) throw forbidden();
      const [done] = await db.select().from(surveyParticipants).where(and(eq(surveyParticipants.surveyId, s.id), eq(surveyParticipants.userId, user.userId)));
      return { id: s.id, title: s.title, intro: s.intro, anonymous: s.anonymous, status: s.status, closesAt: s.closesAt, questions: s.questions, answered: !!done };
    });
    route({ method: 'POST', url: '/api/v1/surveys/:id/responses', tag: 'surveys', summary: 'Answer a survey (once)', body: z.object({ answers: z.record(z.unknown()) }) }, async ({ user, params, body }, reply) => {
      const s = await load(params.id);
      if (s.status !== 'open') throw conflict('This survey is not open');
      const audience = await audienceOf(db, s);
      if (!audience.has(user.userId)) throw forbidden('Not part of this survey’s audience');
      checkAnswers(s.questions, body.answers);
      const units = audience.get(user.userId) ?? [];
      await db.transaction(async (tx) => {
        const [already] = await tx.select().from(surveyParticipants).where(and(eq(surveyParticipants.surveyId, s.id), eq(surveyParticipants.userId, user.userId)));
        if (already) throw conflict('You have already answered this survey');
        await tx.insert(surveyParticipants).values({ surveyId: s.id, userId: user.userId, submittedOn: today() });
        await tx.insert(surveyResponses).values({ surveyId: s.id, orgUnitId: s.orgUnitId ?? units[0] ?? null, answers: body.answers });
      });
      reply.code(201);
      return { ok: true };
    });

    // ---------- results ----------
    route({ method: 'GET', url: '/api/v1/surveys/:id/results', perm: 'surveys.manage', tag: 'surveys', summary: 'Aggregated, anonymity-preserving results' }, async ({ params }) => {
      const s = await load(params.id);
      const rows = await db.select().from(surveyResponses).where(eq(surveyResponses.surveyId, s.id));
      const audience = s.status === 'draft' ? 0 : (await audienceOf(db, s)).size;
      const participants = (await db.select().from(surveyParticipants).where(eq(surveyParticipants.surveyId, s.id))).length;
      const suppressed = !visibleGroup(rows.length);
      const base = { survey: { id: s.id, title: s.title, status: s.status, anonymous: s.anonymous, closesAt: s.closesAt }, responses: rows.length, audience, responseRate: audience ? Math.round((participants / audience) * 100) : 0, suppressed, minGroup: MIN_SURVEY_GROUP };
      if (suppressed) return { ...base, questions: s.questions.map((q) => ({ id: q.id, text: q.text, type: q.type })), heatmap: [] };
      const valuesOf = (list: typeof rows, q: SurveyQuestion) => list.map((r) => r.answers[q.id]).filter((v) => v !== undefined && v !== null && v !== '');
      const questions = s.questions.map((q) => {
        const vals = valuesOf(rows, q);
        if (q.type === 'scale') return { id: q.id, text: q.text, type: q.type, summary: summarizeScale(vals as number[], 1, 5) };
        if (q.type === 'enps') return { id: q.id, text: q.text, type: q.type, enps: enps(vals as number[]), summary: summarizeScale(vals as number[], 0, 10) };
        if (q.type === 'choice') return { id: q.id, text: q.text, type: q.type, choices: summarizeChoice(vals as string[], q.options ?? []) };
        // Free texts are shuffled so their order says nothing about who answered when.
        const texts = (vals as string[]).map((v) => ({ v, k: Math.random() })).sort((a, b) => a.k - b.k).map((x) => x.v);
        return { id: q.id, text: q.text, type: q.type, texts: visibleGroup(texts.length) ? texts : [] };
      });
      const unitIds = [...new Set(rows.map((r) => r.orgUnitId).filter(Boolean))] as string[];
      const units = unitIds.length ? await db.select().from(orgUnits).where(inArray(orgUnits.id, unitIds)) : [];
      const heatmap = units
        .map((u) => {
          const group = rows.filter((r) => r.orgUnitId === u.id);
          if (!visibleGroup(group.length)) return null;
          const values: Record<string, number> = {};
          for (const q of s.questions) {
            if (q.type === 'scale') values[q.id] = summarizeScale(valuesOf(group, q) as number[], 1, 5).average;
            if (q.type === 'enps') values[q.id] = enps(valuesOf(group, q) as number[]).score;
          }
          return { unit: u.name, responses: group.length, values };
        })
        .filter(Boolean);
      return { ...base, questions, heatmap };
    });
  },
};

