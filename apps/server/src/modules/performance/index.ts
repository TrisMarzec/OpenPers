import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { atLeast, MIN_PEER_REVIEWS, summarizeScale } from '@openpers/shared';
import type { Exec } from '../../db';
import { employmentOrgUnits, employments, feedback, goals, persons, reviewCycles, reviewReleases, reviews, users } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, type AppContext, type OpenPersModule } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { currentEmployment, isoDateSchema } from '../people/service';
import { notify } from '../workflow';
import type { ReviewQuestion } from './schema';

const today = () => new Date().toISOString().slice(0, 10);

const questionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  type: z.enum(['rating', 'text']),
  text: z.string().min(1).max(500),
  required: z.boolean().default(true),
});
const cycleBody = z.object({
  name: z.string().min(1).max(200),
  periodStart: isoDateSchema.nullish(),
  periodEnd: isoDateSchema.nullish(),
  dueDate: isoDateSchema.nullish(),
  selfReview: z.boolean().default(true),
  managerReview: z.boolean().default(true),
  peerReview: z.boolean().default(false),
  questions: z.array(questionSchema).max(50).refine((qs) => new Set(qs.map((q) => q.id)).size === qs.length, 'Question ids must be unique'),
  participantPersonIds: z.array(z.string().uuid()).default([]),
  orgUnitId: z.string().uuid().nullish(),
});

async function userOfPerson(tx: Exec, personId: string | null | undefined) {
  if (!personId) return null;
  const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.personId, personId), eq(users.active, true)));
  return u?.id ?? null;
}

/** Validates answers against the questionnaire; on submit all required questions must be answered. */
function checkAnswers(questions: ReviewQuestion[], answers: Record<string, unknown>, submit: boolean) {
  const errors: { path: string; message: string }[] = [];
  for (const [key, value] of Object.entries(answers)) {
    const q = questions.find((x) => x.id === key);
    if (!q) errors.push({ path: key, message: 'Unknown question' });
    else if (value !== null && q.type === 'rating' && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5)) errors.push({ path: key, message: 'Rating must be 1–5' });
    else if (value !== null && q.type === 'text' && (typeof value !== 'string' || value.length > 5000)) errors.push({ path: key, message: 'Text expected' });
  }
  if (submit) for (const q of questions) if (q.required && (answers[q.id] === undefined || answers[q.id] === null || answers[q.id] === '')) errors.push({ path: q.id, message: 'Required' });
  if (errors.length) throw unprocessable('Invalid answers', errors);
}

export const performanceModule: OpenPersModule = {
  name: 'performance',
  register(app, ctx: AppContext) {
    const { db, authz } = ctx;
    const route = makeRoute(app, ctx.registry);

    const access = async (user: Principal, personId: string) => (await authz.categoryAccess(user, personId)).performance;

    ctx.exporters.performance = async (x: Exec, personId: string) => ({
      goals: await x.select().from(goals).where(eq(goals.personId, personId)),
      // Own reviews as reviewee; peer reviews stay anonymous and are exported in aggregate only via the UI.
      reviews: (await x.select().from(reviews).where(eq(reviews.revieweeId, personId))).filter((r) => r.type !== 'peer'),
      feedbackReceived: (await x.select().from(feedback).where(eq(feedback.personId, personId))).filter((f) => f.kind === 'praise').map(({ authorPersonId: _a, ...f }) => f),
    });

    async function loadCycle(id: string) {
      const [c] = await db.select().from(reviewCycles).where(eq(reviewCycles.id, id));
      if (!c) throw notFound('Review cycle not found');
      return c;
    }

    async function participantsOf(c: typeof reviewCycles.$inferSelect): Promise<string[]> {
      if (c.participantPersonIds.length) return c.participantPersonIds;
      const emps = await db.select().from(employments).where(isNull(employments.endDate));
      let ids = emps.filter((e) => e.status !== 'INACTIVE').map((e) => e.personId);
      if (c.orgUnitId) {
        const links = await db.select().from(employmentOrgUnits).where(eq(employmentOrgUnits.orgUnitId, c.orgUnitId));
        const inUnit = new Set(emps.filter((e) => links.some((l) => l.employmentId === e.id)).map((e) => e.personId));
        ids = ids.filter((id) => inUnit.has(id));
      }
      return [...new Set(ids)];
    }

    // ---------- cycles ----------
    route({ method: 'GET', url: '/api/v1/review-cycles', perm: 'performance.manage', tag: 'performance', summary: 'Review cycles' }, async () => ({
      items: await db.select().from(reviewCycles).orderBy(desc(reviewCycles.createdAt)),
    }));
    route({ method: 'GET', url: '/api/v1/review-cycles/:id', perm: 'performance.manage', tag: 'performance', summary: 'Review cycle with progress per person' }, async ({ params }) => {
      const c = await loadCycle(params.id);
      const rows = await db.select().from(reviews).where(eq(reviews.cycleId, c.id));
      const releases = await db.select().from(reviewReleases).where(eq(reviewReleases.cycleId, c.id));
      const people = rows.length ? await db.select({ id: persons.id, firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(inArray(persons.id, [...new Set(rows.map((r) => r.revieweeId))])) : [];
      return {
        ...c,
        progress: { submitted: rows.filter((r) => r.status === 'submitted').length, total: rows.length },
        participants: people.map((p) => {
          const own = rows.filter((r) => r.revieweeId === p.id);
          return {
            person: p,
            self: own.find((r) => r.type === 'self')?.status ?? null,
            manager: own.find((r) => r.type === 'manager')?.status ?? null,
            peers: { submitted: own.filter((r) => r.type === 'peer' && r.status === 'submitted').length, total: own.filter((r) => r.type === 'peer').length },
            released: releases.some((x) => x.personId === p.id),
          };
        }),
      };
    });
    route({ method: 'POST', url: '/api/v1/review-cycles', perm: 'performance.manage', tag: 'performance', summary: 'Create a review cycle (draft)', body: cycleBody }, async ({ user, body }, reply) => {
      const [c] = await db.insert(reviewCycles).values({ ...body, orgUnitId: body.orgUnitId ?? null, createdByUserId: user.userId }).returning();
      await audit(db, user.userId, 'review_cycle', c.id, 'create', { name: c.name });
      reply.code(201);
      return c;
    });
    route({ method: 'PATCH', url: '/api/v1/review-cycles/:id', perm: 'performance.manage', tag: 'performance', summary: 'Edit a draft cycle', body: cycleBody.partial() }, async ({ user, body, params }) => {
      const c = await loadCycle(params.id);
      if (c.status !== 'draft') throw conflict('Only draft cycles can be edited');
      const [u] = await db.update(reviewCycles).set(body).where(eq(reviewCycles.id, c.id)).returning();
      await audit(db, user.userId, 'review_cycle', c.id, 'update', { name: u.name });
      return u;
    });
    route({ method: 'POST', url: '/api/v1/review-cycles/:id/start', perm: 'performance.manage', tag: 'performance', summary: 'Start: assign self and manager reviews' }, async ({ user, params }) => {
      const c = await loadCycle(params.id);
      if (c.status !== 'draft') throw conflict('Cycle already started');
      if (!c.questions.length) throw unprocessable('No questions', [{ path: 'questions', message: 'Add at least one question' }]);
      const people = await participantsOf(c);
      const updated = await db.transaction(async (tx) => {
        const reviewers = new Map<string, number>();
        for (const pid of people) {
          const rows: (typeof reviews.$inferInsert)[] = [];
          if (c.selfReview) rows.push({ cycleId: c.id, revieweeId: pid, reviewerPersonId: pid, type: 'self' });
          const emp = await currentEmployment(tx, pid, today());
          if (c.managerReview && emp?.supervisorPersonId) rows.push({ cycleId: c.id, revieweeId: pid, reviewerPersonId: emp.supervisorPersonId, type: 'manager' });
          if (rows.length) await tx.insert(reviews).values(rows);
          for (const r of rows) reviewers.set(r.reviewerPersonId, (reviewers.get(r.reviewerPersonId) ?? 0) + 1);
        }
        for (const [personId, count] of reviewers) await notify(tx, [await userOfPerson(tx, personId)], 'review_assigned', { count, cycleName: c.name, dueDate: c.dueDate }, '/performance');
        const [u] = await tx.update(reviewCycles).set({ status: 'active', startedAt: new Date() }).where(eq(reviewCycles.id, c.id)).returning();
        await audit(tx, user.userId, 'review_cycle', c.id, 'start', { participants: people.length });
        return u;
      });
      return updated;
    });
    route({ method: 'POST', url: '/api/v1/review-cycles/:id/close', perm: 'performance.manage', tag: 'performance', summary: 'Close a cycle' }, async ({ user, params }) => {
      const c = await loadCycle(params.id);
      const [u] = await db.update(reviewCycles).set({ status: 'closed', closedAt: new Date() }).where(eq(reviewCycles.id, c.id)).returning();
      await audit(db, user.userId, 'review_cycle', c.id, 'close');
      return u;
    });

    route(
      { method: 'POST', url: '/api/v1/review-cycles/:id/peers', tag: 'performance', summary: 'Assign peer reviewers (HR or the reviewee’s manager)', body: z.object({ revieweeId: z.string().uuid(), reviewerPersonIds: z.array(z.string().uuid()).min(1).max(10) }) },
      async ({ user, params, body }, reply) => {
        const c = await loadCycle(params.id);
        if (c.status !== 'active') throw conflict('Cycle is not active');
        if (!c.peerReview) throw unprocessable('Peer reviews disabled', [{ path: 'reviewerPersonIds', message: 'This cycle has no peer reviews' }]);
        const manage = authz.has(user, 'performance.manage');
        if (!manage && (body.revieweeId === user.personId || !atLeast(await access(user, body.revieweeId), 'edit'))) throw forbidden();
        const existing = await db.select().from(reviews).where(and(eq(reviews.cycleId, c.id), eq(reviews.revieweeId, body.revieweeId), eq(reviews.type, 'peer')));
        const fresh = body.reviewerPersonIds.filter((id) => id !== body.revieweeId && !existing.some((r) => r.reviewerPersonId === id));
        await db.transaction(async (tx) => {
          if (fresh.length) await tx.insert(reviews).values(fresh.map((reviewerPersonId) => ({ cycleId: c.id, revieweeId: body.revieweeId, reviewerPersonId, type: 'peer' })));
          for (const pid of fresh) await notify(tx, [await userOfPerson(tx, pid)], 'review_assigned', { count: 1, cycleName: c.name, dueDate: c.dueDate }, '/performance');
          await audit(tx, user.userId, 'review_cycle', c.id, 'peers_assigned', { revieweeId: body.revieweeId, count: fresh.length });
        });
        reply.code(201);
        return { added: fresh.length };
      },
    );

    // ---------- reviewing ----------
    route({ method: 'GET', url: '/api/v1/reviews/mine', tag: 'performance', summary: 'Reviews the caller has to write' }, async ({ user }) => {
      if (!user.personId) return { items: [] };
      const rows = await db
        .select({ r: reviews, c: reviewCycles, firstName: persons.firstName, lastName: persons.lastName })
        .from(reviews)
        .innerJoin(reviewCycles, eq(reviewCycles.id, reviews.cycleId))
        .innerJoin(persons, eq(persons.id, reviews.revieweeId))
        .where(eq(reviews.reviewerPersonId, user.personId))
        .orderBy(asc(reviews.status), asc(persons.lastName));
      return {
        items: rows.map(({ r, c, firstName, lastName }) => ({ ...r, cycle: { id: c.id, name: c.name, status: c.status, dueDate: c.dueDate, questions: c.questions }, reviewee: { id: r.revieweeId, firstName, lastName } })),
      };
    });

    route({ method: 'PUT', url: '/api/v1/reviews/:id', tag: 'performance', summary: 'Save or submit a review', body: z.object({ answers: z.record(z.unknown()), submit: z.boolean().default(false) }) }, async ({ user, params, body }) => {
      const [r] = await db.select().from(reviews).where(eq(reviews.id, params.id));
      if (!r) throw notFound();
      if (r.reviewerPersonId !== user.personId) throw forbidden('Only the reviewer can write this review');
      const c = await loadCycle(r.cycleId);
      if (c.status !== 'active') throw conflict('The cycle is not active');
      if (r.status === 'submitted') throw conflict('Already submitted');
      checkAnswers(c.questions, body.answers, body.submit);
      const [u] = await db
        .update(reviews)
        .set({ answers: body.answers, ...(body.submit ? { status: 'submitted', submittedAt: new Date() } : {}) })
        .where(eq(reviews.id, r.id))
        .returning();
      return u;
    });

    // ---------- results ----------
    route(
      { method: 'GET', url: '/api/v1/reviews/results', tag: 'performance', summary: 'Self, manager and anonymous peer results of a person in a cycle', query: z.object({ cycleId: z.string().uuid(), personId: z.string().uuid() }) },
      async ({ user, query }) => {
        const level = await access(user, query.personId);
        if (!atLeast(level, 'view')) throw forbidden();
        const c = await loadCycle(query.cycleId);
        const rows = await db.select().from(reviews).where(and(eq(reviews.cycleId, c.id), eq(reviews.revieweeId, query.personId)));
        const [release] = await db.select().from(reviewReleases).where(and(eq(reviewReleases.cycleId, c.id), eq(reviewReleases.personId, query.personId)));
        const self = query.personId === user.personId;
        const showOthers = !self || !!release;
        const pick = (type: string) => {
          const r = rows.find((x) => x.type === type);
          return r ? { status: r.status, answers: r.status === 'submitted' || (type === 'self' && self) ? r.answers : {}, submittedAt: r.submittedAt } : null;
        };
        const peerRows = rows.filter((r) => r.type === 'peer');
        const submittedPeers = peerRows.filter((r) => r.status === 'submitted');
        const visible = submittedPeers.length >= MIN_PEER_REVIEWS;
        const peers = !c.peerReview
          ? null
          : {
              submitted: submittedPeers.length,
              total: peerRows.length,
              visible,
              // Aggregated only, never per reviewer; texts in a stable but not reviewer-ordered sequence.
              ...(visible
                ? {
                    answers: Object.fromEntries(
                      c.questions.map((q) => {
                        const vals = submittedPeers.map((r) => r.answers[q.id]).filter((v) => v !== undefined && v !== null && v !== '');
                        return [q.id, q.type === 'rating' ? summarizeScale(vals as number[], 1, 5) : { texts: (vals as string[]).slice().sort() }];
                      }),
                    ),
                  }
                : {}),
            };
        return {
          cycle: { id: c.id, name: c.name, status: c.status, questions: c.questions },
          released: !!release,
          self: pick('self'),
          manager: showOthers ? pick('manager') : null,
          peers: showOthers ? peers : null,
        };
      },
    );

    route({ method: 'POST', url: '/api/v1/review-cycles/:id/release', tag: 'performance', summary: 'Share the results with the reviewee', body: z.object({ personId: z.string().uuid() }) }, async ({ user, params, body }) => {
      const c = await loadCycle(params.id);
      if (body.personId === user.personId || !atLeast(await access(user, body.personId), 'edit')) throw forbidden();
      await db.transaction(async (tx) => {
        await tx.insert(reviewReleases).values({ cycleId: c.id, personId: body.personId, releasedByUserId: user.userId }).onConflictDoNothing();
        await notify(tx, [await userOfPerson(tx, body.personId)], 'review_released', { cycleName: c.name }, '/performance');
        await audit(tx, user.userId, 'person', body.personId, 'review_released', { cycleId: c.id });
      });
      return { released: true };
    });

    // ---------- goals ----------
    const goalBody = z.object({ title: z.string().min(1).max(300), description: z.string().max(5000).nullish(), dueDate: isoDateSchema.nullish(), progress: z.number().int().min(0).max(100).default(0), status: z.enum(['open', 'achieved', 'dropped']).default('open') });
    route({ method: 'GET', url: '/api/v1/persons/:id/goals', tag: 'performance', summary: 'Goals of a person' }, async ({ user, params }) => {
      if (!atLeast(await access(user, params.id), 'view')) throw forbidden();
      return { items: await db.select().from(goals).where(eq(goals.personId, params.id)).orderBy(asc(goals.status), asc(goals.dueDate)) };
    });
    route({ method: 'POST', url: '/api/v1/persons/:id/goals', tag: 'performance', summary: 'Add a goal (own goals or as manager/HR)', body: goalBody }, async ({ user, params, body }, reply) => {
      if (params.id !== user.personId && !atLeast(await access(user, params.id), 'edit')) throw forbidden();
      const [g] = await db.insert(goals).values({ ...body, personId: params.id, createdByUserId: user.userId }).returning();
      await audit(db, user.userId, 'person', params.id, 'goal_create', { title: g.title });
      reply.code(201);
      return g;
    });
    route({ method: 'PATCH', url: '/api/v1/goals/:id', tag: 'performance', summary: 'Update a goal (owners may update progress and status)', body: goalBody.partial() }, async ({ user, params, body }) => {
      const [g] = await db.select().from(goals).where(eq(goals.id, params.id));
      if (!g) throw notFound();
      const canEdit = atLeast(await access(user, g.personId), 'edit');
      const ownProgressOnly = g.personId === user.personId && Object.keys(body).every((k) => ['progress', 'status'].includes(k));
      if (!canEdit && !ownProgressOnly && !(g.personId === user.personId && g.createdByUserId === user.userId)) throw forbidden();
      const [u] = await db.update(goals).set({ ...body, updatedAt: new Date() }).where(eq(goals.id, g.id)).returning();
      return u;
    });
    route({ method: 'DELETE', url: '/api/v1/goals/:id', tag: 'performance', summary: 'Delete a goal' }, async ({ user, params }) => {
      const [g] = await db.select().from(goals).where(eq(goals.id, params.id));
      if (!g) throw notFound();
      if (!atLeast(await access(user, g.personId), 'edit') && !(g.personId === user.personId && g.createdByUserId === user.userId)) throw forbidden();
      await db.delete(goals).where(eq(goals.id, g.id));
    });

    // ---------- feedback ----------
    route({ method: 'GET', url: '/api/v1/persons/:id/feedback', tag: 'performance', summary: 'Feedback about a person (praise visible to them, private feedback for manager/HR)' }, async ({ user, params }) => {
      const self = params.id === user.personId;
      if (!self && !atLeast(await access(user, params.id), 'view')) throw forbidden();
      const rows = await db
        .select({ f: feedback, firstName: persons.firstName, lastName: persons.lastName })
        .from(feedback)
        .leftJoin(persons, eq(persons.id, feedback.authorPersonId))
        .where(eq(feedback.personId, params.id))
        .orderBy(desc(feedback.createdAt));
      return { items: rows.filter(({ f }) => !self || f.kind === 'praise').map(({ f, firstName, lastName }) => ({ ...f, author: firstName ? { firstName, lastName } : null })) };
    });
    route({ method: 'POST', url: '/api/v1/persons/:id/feedback', tag: 'performance', summary: 'Give feedback or praise', body: z.object({ kind: z.enum(['praise', 'private']), text: z.string().trim().min(1).max(2000) }) }, async ({ user, params, body }, reply) => {
      if (!user.personId) throw forbidden('Only employees can give feedback');
      if (params.id === user.personId) throw unprocessable('Not for yourself', [{ path: 'text', message: 'Feedback is for colleagues' }]);
      const [target] = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, params.id));
      if (!target) throw notFound();
      const [f] = await db.transaction(async (tx) => {
        const r = await tx.insert(feedback).values({ personId: params.id, authorPersonId: user.personId, kind: body.kind, text: body.text }).returning();
        if (body.kind === 'praise') await notify(tx, [await userOfPerson(tx, params.id)], 'praise_received', {}, '/me');
        return r;
      });
      reply.code(201);
      return f;
    });
  },
};
