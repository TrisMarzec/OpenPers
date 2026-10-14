import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../../db';
import { applicationNotes, applications, applicationStageTransitions, candidates, company, hiringTeamMembers, jobs, orgUnits, persons, pipelineStages, users, workplaces } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import { audit, emit, type AppContext, type OpenPersModule } from '../../lib/context';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import type { Principal } from '../../lib/authz';
import { checkFileType } from '../documents';
import { createPersonWithEmployment, employmentInput, isoDateSchema } from '../people/service';

const DEFAULT_STAGES = [
  { name: 'Eingegangen', kind: 'applied' },
  { name: 'Screening', kind: 'screening' },
  { name: 'Interview', kind: 'interview' },
  { name: 'Angebot', kind: 'offer' },
  { name: 'Eingestellt', kind: 'hired' },
  { name: 'Abgesagt', kind: 'rejected' },
];
const CLOSED_KINDS = ['hired', 'rejected'];

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'job'
  );
}

/** Anonymizes candidates of applications closed longer than the retention period. */
export async function anonymizeExpiredApplications(db: DB, retentionMonths: number): Promise<number> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  const expired = await db.select().from(applications).where(and(isNull(applications.anonymizedAt), lt(applications.closedAt, cutoff), isNull(applications.hiredPersonId)));
  for (const a of expired) {
    await db.transaction(async (tx) => {
      await tx.update(applications).set({ coverLetter: null, cvFileKey: null, cvName: null, cvMime: null, anonymizedAt: new Date() }).where(eq(applications.id, a.id));
      await tx.delete(applicationNotes).where(eq(applicationNotes.applicationId, a.id));
      const open = await tx.select({ id: applications.id }).from(applications).where(and(eq(applications.candidateId, a.candidateId), isNull(applications.anonymizedAt)));
      if (!open.length) {
        await tx.update(candidates).set({ firstName: 'Anonymisiert', lastName: a.candidateId.slice(0, 8), email: `anonymized-${a.candidateId}@invalid.local`, phone: null, anonymizedAt: new Date() }).where(eq(candidates.id, a.candidateId));
      }
      await audit(tx, null, 'application', a.id, 'anonymize');
    });
  }
  return expired.length;
}

export async function retentionMonths(db: DB): Promise<number> {
  const [c] = await db.select().from(company).limit(1);
  return Number((c?.settings as any)?.recruiting?.retentionMonths ?? 6);
}

export const recruitingModule: OpenPersModule = {
  name: 'recruiting',

  async seed(tx) {
    await tx.insert(pipelineStages).values(DEFAULT_STAGES.map((s, i) => ({ ...s, position: i })));
  },

  register(app, ctx: AppContext) {
    const { db, storage } = ctx;
    const route = makeRoute(app, ctx.registry);

    async function stages() {
      return db.select().from(pipelineStages).orderBy(asc(pipelineStages.position));
    }

    async function uniqueSlug(title: string, excludeId?: string) {
      const base = slugify(title);
      for (let i = 0; ; i++) {
        const slug = i ? `${base}-${i + 1}` : base;
        const [dup] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.slug, slug));
        if (!dup || dup.id === excludeId) return slug;
      }
    }

    /** Jobs the caller may see: all with company-wide recruiting rights, otherwise only hiring-team jobs. */
    async function visibleJobIds(user: Principal): Promise<Set<string> | null> {
      if ((user.permissions['recruiting.read'] ?? []).includes('all')) return null;
      const rows = await db.select({ jobId: hiringTeamMembers.jobId }).from(hiringTeamMembers).where(eq(hiringTeamMembers.userId, user.userId));
      return new Set(rows.map((r) => r.jobId));
    }

    async function assertJobAccess(user: Principal, jobId: string) {
      const visible = await visibleJobIds(user);
      if (visible && !visible.has(jobId)) throw forbidden('Not on the hiring team of this job');
    }

    async function loadApplicationFor(user: Principal, id: string) {
      const a = await loadApplication(id);
      await assertJobAccess(user, a.jobId);
      return a;
    }

    async function loadApplication(id: string) {
      const [a] = await db.select().from(applications).where(eq(applications.id, id));
      if (!a) throw notFound('Application not found');
      return a;
    }

    async function applicationView(id: string, full = false) {
      const a = await loadApplication(id);
      const [candidate] = await db.select().from(candidates).where(eq(candidates.id, a.candidateId));
      const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, a.stageId));
      const [job] = await db.select({ id: jobs.id, title: jobs.title }).from(jobs).where(eq(jobs.id, a.jobId));
      const { cvFileKey, ...rest } = a;
      const base = { ...rest, hasCv: !!cvFileKey, candidate, stage, job };
      if (!full) return base;
      const transitions = await db.select().from(applicationStageTransitions).where(eq(applicationStageTransitions.applicationId, id)).orderBy(desc(applicationStageTransitions.at));
      const notes = await db.select().from(applicationNotes).where(eq(applicationNotes.applicationId, id)).orderBy(desc(applicationNotes.createdAt));
      return { ...base, transitions, notes };
    }

    async function moveTo(applicationId: string, stageId: string, actorUserId: string | null) {
      const a = await loadApplication(applicationId);
      const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.id, stageId));
      if (!stage) throw unprocessable('Unknown stage', [{ path: 'stageId', message: 'Stage not found' }]);
      if (a.stageId === stageId) return;
      await db.transaction(async (tx) => {
        await tx.update(applications).set({ stageId, updatedAt: new Date(), closedAt: CLOSED_KINDS.includes(stage.kind) ? new Date() : null }).where(eq(applications.id, a.id));
        await tx.insert(applicationStageTransitions).values({ applicationId: a.id, fromStageId: a.stageId, toStageId: stageId, actorUserId });
        await audit(tx, actorUserId, 'application', a.id, 'move', { from: a.stageId, to: stageId });
        await emit(tx, 'application.stage_changed', { applicationId: a.id, jobId: a.jobId, fromStageId: a.stageId, toStageId: stageId });
      });
    }

    async function createApplication(input: { jobId: string; firstName: string; lastName: string; email: string; phone?: string | null; coverLetter?: string | null; channel: string; cv?: { name: string; mime: string; data: Buffer } }, actorUserId: string | null) {
      const [first] = await stages();
      const cv = input.cv ? await storage.put(input.cv.data) : null;
      return db.transaction(async (tx) => {
        let [candidate] = await tx.select().from(candidates).where(and(eq(candidates.email, input.email), isNull(candidates.anonymizedAt)));
        if (!candidate) [candidate] = await tx.insert(candidates).values({ firstName: input.firstName, lastName: input.lastName, email: input.email, phone: input.phone ?? null }).returning();
        const [a] = await tx
          .insert(applications)
          .values({ jobId: input.jobId, candidateId: candidate.id, stageId: first.id, channel: input.channel, coverLetter: input.coverLetter ?? null, cvFileKey: cv?.key ?? null, cvName: input.cv?.name ?? null, cvMime: input.cv?.mime ?? null })
          .returning();
        await tx.insert(applicationStageTransitions).values({ applicationId: a.id, fromStageId: null, toStageId: first.id, actorUserId });
        await audit(tx, actorUserId, 'application', a.id, 'create', { jobId: input.jobId, channel: input.channel });
        await emit(tx, 'application.created', { applicationId: a.id, jobId: input.jobId, candidateId: candidate.id });
        return a;
      });
    }

    // ---------- Stages ----------
    const stageBody = z.object({ name: z.string().min(1).max(100), position: z.number().int(), kind: z.enum(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']) });
    route({ method: 'GET', url: '/api/v1/pipeline-stages', perm: 'recruiting.read', tag: 'recruiting', summary: 'Pipeline stages' }, async () => ({ items: await stages() }));
    route({ method: 'POST', url: '/api/v1/pipeline-stages', perm: 'recruiting.manage', tag: 'recruiting', summary: 'Add pipeline stage', body: stageBody }, async ({ user, body }, reply) => {
      const [s] = await db.insert(pipelineStages).values(body).returning();
      await audit(db, user.userId, 'pipeline_stage', s.id, 'create', body);
      reply.code(201);
      return s;
    });
    route({ method: 'PATCH', url: '/api/v1/pipeline-stages/:id', perm: 'recruiting.manage', tag: 'recruiting', summary: 'Update pipeline stage', body: stageBody.partial() }, async ({ user, body, params }) => {
      const [s] = await db.update(pipelineStages).set(body).where(eq(pipelineStages.id, params.id)).returning();
      if (!s) throw notFound();
      await audit(db, user.userId, 'pipeline_stage', s.id, 'update', body);
      return s;
    });

    // ---------- Jobs ----------
    const jobBody = z.object({
      title: z.string().min(1).max(200),
      departmentOrgUnitId: z.string().uuid().nullish(),
      workplaceId: z.string().uuid().nullish(),
      category: z.string().max(100).nullish(),
      employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'WORKING_STUDENT', 'INTERN', 'MINI_JOB', 'FREELANCE']).default('FULL_TIME'),
      description: z.string().max(50_000).default(''),
      status: z.enum(['draft', 'published', 'closed']).default('draft'),
      hiringTeamUserIds: z.array(z.string().uuid()).optional(),
    });
    route({ method: 'GET', url: '/api/v1/jobs', perm: 'recruiting.read', tag: 'recruiting', summary: 'List jobs with application counts' }, async ({ user }) => {
      const visible = await visibleJobIds(user);
      const list = (await db.select().from(jobs).orderBy(desc(jobs.updatedAt))).filter((j) => !visible || visible.has(j.id));
      const counts = await db.select({ jobId: applications.jobId, n: sql<number>`count(*)::int` }).from(applications).where(isNull(applications.closedAt)).groupBy(applications.jobId);
      return { items: list.map((j) => ({ ...j, openApplications: counts.find((c) => c.jobId === j.id)?.n ?? 0 })) };
    });
    route({ method: 'GET', url: '/api/v1/jobs/:id', perm: 'recruiting.read', tag: 'recruiting', summary: 'Job details' }, async ({ user, params }) => {
      const [j] = await db.select().from(jobs).where(eq(jobs.id, params.id));
      if (!j) throw notFound();
      await assertJobAccess(user, j.id);
      const team = await db.select().from(hiringTeamMembers).where(eq(hiringTeamMembers.jobId, j.id));
      return { ...j, hiringTeam: team };
    });
    route({ method: 'POST', url: '/api/v1/jobs', perm: 'recruiting.write', tag: 'recruiting', summary: 'Create job', body: jobBody }, async ({ user, body }, reply) => {
      const { hiringTeamUserIds, ...data } = body;
      const [j] = await db.insert(jobs).values({ ...data, slug: await uniqueSlug(body.title) }).returning();
      if (hiringTeamUserIds?.length) await db.insert(hiringTeamMembers).values(hiringTeamUserIds.map((userId) => ({ jobId: j.id, userId })));
      await audit(db, user.userId, 'job', j.id, 'create', { title: j.title });
      reply.code(201);
      return j;
    });
    route({ method: 'PATCH', url: '/api/v1/jobs/:id', perm: 'recruiting.write', tag: 'recruiting', summary: 'Update job', body: jobBody.partial() }, async ({ user, body, params }) => {
      const { hiringTeamUserIds, ...data } = body;
      const [j] = await db.update(jobs).set({ ...data, updatedAt: new Date() }).where(eq(jobs.id, params.id)).returning();
      if (!j) throw notFound();
      if (hiringTeamUserIds) {
        await db.delete(hiringTeamMembers).where(eq(hiringTeamMembers.jobId, j.id));
        if (hiringTeamUserIds.length) await db.insert(hiringTeamMembers).values(hiringTeamUserIds.map((userId) => ({ jobId: j.id, userId })));
      }
      await audit(db, user.userId, 'job', j.id, 'update', data);
      return j;
    });

    route({ method: 'GET', url: '/api/v1/recruiting/team-candidates', perm: 'recruiting.write', tag: 'recruiting', summary: 'Active users that can be added to a hiring team' }, async () => {
      const rows = await db
        .select({ userId: users.id, email: users.email, firstName: persons.firstName, lastName: persons.lastName })
        .from(users)
        .innerJoin(persons, eq(persons.id, users.personId))
        .where(and(eq(users.active, true), isNull(persons.anonymizedAt)))
        .orderBy(asc(persons.lastName));
      return { items: rows };
    });

    // ---------- Applications ----------
    route({ method: 'GET', url: '/api/v1/applications', perm: 'recruiting.read', tag: 'recruiting', summary: 'List applications', query: z.object({ jobId: z.string().uuid().optional(), stageId: z.string().uuid().optional() }) }, async ({ user, query }) => {
      const visible = await visibleJobIds(user);
      if (visible && !visible.size) return { items: [] };
      const conds = [query.jobId ? eq(applications.jobId, query.jobId) : undefined, query.stageId ? eq(applications.stageId, query.stageId) : undefined, visible ? inArray(applications.jobId, [...visible]) : undefined].filter(Boolean) as any[];
      const rows = await db.select({ id: applications.id }).from(applications).where(conds.length ? and(...conds) : undefined).orderBy(desc(applications.appliedAt)).limit(2000);
      return { items: await Promise.all(rows.map((r) => applicationView(r.id))) };
    });
    route({ method: 'GET', url: '/api/v1/applications/:id', perm: 'recruiting.read', tag: 'recruiting', summary: 'Application details incl. history and notes' }, async ({ user, params }) => {
      await loadApplicationFor(user, params.id);
      return applicationView(params.id, true);
    });
    route(
      {
        method: 'POST',
        url: '/api/v1/applications',
        perm: 'recruiting.write',
        tag: 'recruiting',
        summary: 'Add an application manually',
        body: z.object({ jobId: z.string().uuid(), firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().trim().toLowerCase().email(), phone: z.string().nullish(), coverLetter: z.string().nullish(), channel: z.string().default('manual') }),
      },
      async ({ user, body }, reply) => {
        const [j] = await db.select().from(jobs).where(eq(jobs.id, body.jobId));
        if (!j) throw notFound('Job not found');
        const a = await createApplication(body, user.userId);
        reply.code(201);
        return applicationView(a.id);
      },
    );
    route({ method: 'PATCH', url: '/api/v1/applications/:id', perm: 'recruiting.write', tag: 'recruiting', summary: 'Rate an application', body: z.object({ rating: z.number().int().min(1).max(5).nullable() }) }, async ({ user, params, body }) => {
      await loadApplicationFor(user, params.id);
      await db.update(applications).set({ rating: body.rating, updatedAt: new Date() }).where(eq(applications.id, params.id));
      await audit(db, user.userId, 'application', params.id, 'rate', body);
      return applicationView(params.id);
    });
    route({ method: 'POST', url: '/api/v1/applications/:id/move', perm: 'recruiting.write', tag: 'recruiting', summary: 'Move to pipeline stage', body: z.object({ stageId: z.string().uuid() }) }, async ({ user, params, body }) => {
      await loadApplicationFor(user, params.id);
      await moveTo(params.id, body.stageId, user.userId);
      return applicationView(params.id);
    });
    route({ method: 'POST', url: '/api/v1/applications/:id/notes', perm: 'recruiting.read', tag: 'recruiting', summary: 'Add a note', body: z.object({ body: z.string().min(1).max(10_000) }) }, async ({ user, params, body }, reply) => {
      await loadApplicationFor(user, params.id);
      const [n] = await db.insert(applicationNotes).values({ applicationId: params.id, authorUserId: user.userId, body: body.body }).returning();
      reply.code(201);
      return n;
    });
    route({ method: 'GET', url: '/api/v1/applications/:id/cv', perm: 'recruiting.read', tag: 'recruiting', summary: 'Download CV' }, async ({ user, params }, reply) => {
      const a = await loadApplicationFor(user, params.id);
      if (!a.cvFileKey) throw notFound('No CV');
      await audit(db, user.userId, 'application', a.id, 'cv_download');
      reply
        .header('content-type', a.cvMime ?? 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${(a.cvName ?? 'cv').replace(/[^\w.\-]/g, '_')}"`)
        .header('x-content-type-options', 'nosniff');
      return reply.send(storage.stream(a.cvFileKey));
    });
    route(
      {
        method: 'POST',
        url: '/api/v1/applications/:id/hire',
        perm: 'recruiting.write',
        tag: 'recruiting',
        summary: 'Hire: create person + onboarding employment',
        body: employmentInput.partial().extend({ startDate: isoDateSchema }),
      },
      async ({ user, params, body }) => {
        if (!ctx.authz.has(user, 'people.write')) throw forbidden('Hiring requires people.write');
        const a = await loadApplicationFor(user, params.id);
        if (a.hiredPersonId) throw conflict('Candidate already hired');
        const [candidate] = await db.select().from(candidates).where(eq(candidates.id, a.candidateId));
        const [job] = await db.select().from(jobs).where(eq(jobs.id, a.jobId));
        const hiredStage = (await stages()).find((s) => s.kind === 'hired');
        const { personId } = await db.transaction(async (tx) => {
          const created = await createPersonWithEmployment(
            tx,
            {
              firstName: candidate.firstName,
              lastName: candidate.lastName,
              email: candidate.email,
              phone: candidate.phone,
              employment: { ...body, status: 'ONBOARDING', positionTitle: body.positionTitle ?? job.title, workplaceId: body.workplaceId ?? job.workplaceId, orgUnitIds: body.orgUnitIds ?? (job.departmentOrgUnitId ? [job.departmentOrgUnitId] : []) },
            },
            user.userId,
          );
          await tx.update(applications).set({ hiredPersonId: created.personId, updatedAt: new Date() }).where(eq(applications.id, a.id));
          await emit(tx, 'candidate.hired', { applicationId: a.id, candidateId: candidate.id, personId: created.personId });
          return created;
        });
        if (hiredStage) await moveTo(a.id, hiredStage.id, user.userId);
        return { ...(await applicationView(a.id)), hiredPersonId: personId };
      },
    );
    route({ method: 'POST', url: '/api/v1/recruiting/anonymize-expired', perm: 'recruiting.manage', tag: 'recruiting', summary: 'Anonymize closed applications past the retention period' }, async () => ({
      anonymized: await anonymizeExpiredApplications(db, await retentionMonths(db)),
    }));

    // ---------- Public career page ----------
    async function publicJob(j: typeof jobs.$inferSelect) {
      const [dep] = j.departmentOrgUnitId ? await db.select({ name: orgUnits.name }).from(orgUnits).where(eq(orgUnits.id, j.departmentOrgUnitId)) : [];
      const [wp] = j.workplaceId ? await db.select({ name: workplaces.name }).from(workplaces).where(eq(workplaces.id, j.workplaceId)) : [];
      return { slug: j.slug, title: j.title, description: j.description, employmentType: j.employmentType, category: j.category, department: dep?.name ?? null, location: wp?.name ?? null, publishedAt: j.updatedAt };
    }
    route({ method: 'GET', url: '/api/v1/public/jobs', auth: false, tag: 'careers', summary: 'Published jobs' }, async () => {
      const list = await db.select().from(jobs).where(eq(jobs.status, 'published')).orderBy(desc(jobs.updatedAt));
      const [c] = await db.select({ name: company.name }).from(company).limit(1);
      return { company: c?.name ?? null, items: await Promise.all(list.map(publicJob)) };
    });
    route({ method: 'GET', url: '/api/v1/public/jobs/:slug', auth: false, tag: 'careers', summary: 'Published job' }, async ({ params }) => {
      const [j] = await db.select().from(jobs).where(and(eq(jobs.slug, params.slug), eq(jobs.status, 'published')));
      if (!j) throw notFound('Job not found');
      return publicJob(j);
    });
    route({ method: 'POST', url: '/api/v1/public/jobs/:slug/apply', auth: false, tag: 'careers', summary: 'Apply (multipart: firstName, lastName, email, phone?, coverLetter?, privacyConsent=true, cv?)' }, async ({ params, raw }, reply) => {
      const [j] = await db.select().from(jobs).where(and(eq(jobs.slug, params.slug), eq(jobs.status, 'published')));
      if (!j) throw notFound('Job not found');
      const fields: Record<string, string> = {};
      let cv: { name: string; mime: string; data: Buffer } | undefined;
      if (raw.isMultipart()) {
        for await (const part of raw.parts()) {
          if (part.type === 'file') cv = { name: part.filename, mime: part.mimetype, data: await part.toBuffer() };
          else fields[part.fieldname] = String(part.value);
        }
      } else Object.assign(fields, raw.body as Record<string, string>);
      const input = z
        .object({
          firstName: z.string().trim().min(1).max(100),
          lastName: z.string().trim().min(1).max(100),
          email: z.string().trim().toLowerCase().email(),
          phone: z.string().max(50).optional(),
          coverLetter: z.string().max(20_000).optional(),
          privacyConsent: z.literal('true', { errorMap: () => ({ message: 'Consent to the privacy policy is required' }) }),
          website: z.string().optional(),
        })
        .parse(fields);
      reply.code(201);
      // Honeypot: real users never fill the hidden "website" field.
      if (input.website) return { ok: true };
      if (cv) checkFileType(cv.mime, cv.name, cv.data);
      await createApplication({ jobId: j.id, ...input, channel: 'career_page', cv }, null);
      return { ok: true };
    });
  },
};
