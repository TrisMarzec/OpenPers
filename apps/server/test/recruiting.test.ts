import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { applications, outbox } from '../src/db/schema';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----openpers${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="cv"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('recruiting', () => {
  let app: FastifyInstance;
  let admin: Client;
  let job: any;

  const apply = async (slug: string, fields: Record<string, string>, withCv = true) => {
    const mp = multipart(fields, withCv ? { name: 'lebenslauf.pdf', type: 'application/pdf', data: PDF } : undefined);
    const res = await app.inject({ method: 'POST', url: `/api/v1/public/jobs/${slug}/apply`, payload: mp.payload, headers: { 'content-type': mp.contentType } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };
  const applicant = (email: string) => ({ firstName: 'Bea', lastName: 'Werber', email, privacyConsent: 'true', coverLetter: 'Ich freue mich!' });

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    job = (await admin.post('/api/v1/jobs', { title: 'Senior Backend Engineer (m/w/d)', description: '## Deine Aufgaben\n- APIs bauen', employmentType: 'FULL_TIME' })).body;
  });
  afterAll(() => app.close());

  it('seeds a default pipeline', async () => {
    const stages = await admin.get('/api/v1/pipeline-stages');
    expect(stages.body.items.map((s: any) => s.kind)).toEqual(['applied', 'screening', 'interview', 'offer', 'hired', 'rejected']);
  });

  it('only publishes jobs on the career page once published', async () => {
    expect(job.status).toBe('draft');
    expect(job.slug).toMatch(/^senior-backend-engineer-m-w-d/);
    expect((await admin.get('/api/v1/public/jobs')).body.items).toHaveLength(0);
    expect((await apply(job.slug, applicant('early@example.com'))).status).toBe(404);
    const pub = await admin.patch(`/api/v1/jobs/${job.id}`, { status: 'published' });
    expect(pub.body.status).toBe('published');
    const list = await admin.get('/api/v1/public/jobs');
    expect(list.body.items.map((j: any) => j.slug)).toEqual([job.slug]);
    expect(list.body.items[0]).not.toHaveProperty('applicationsCount');
    expect((await admin.get(`/api/v1/public/jobs/${job.slug}`)).body.title).toContain('Backend');
  });

  it('accepts public applications with CV and privacy consent', async () => {
    const res = await apply(job.slug, applicant('bea@example.com'));
    expect(res.status).toBe(201);
    const list = await admin.get(`/api/v1/applications?jobId=${job.id}`);
    const app1 = list.body.items.find((a: any) => a.candidate.email === 'bea@example.com');
    expect(app1.stage.kind).toBe('applied');
    expect(app1.cvName).toBe('lebenslauf.pdf');
    const events = await app.ctx.db.select().from(outbox).where(eq(outbox.event, 'application.created'));
    expect(events).toHaveLength(1);
    const cv = await app.inject({ method: 'GET', url: `/api/v1/applications/${app1.id}/cv`, headers: { cookie: admin.cookie! } });
    expect(cv.statusCode).toBe(200);
  });

  it('validates applications and silently drops bot submissions', async () => {
    expect((await apply(job.slug, { firstName: 'X', lastName: 'Y', email: 'x@example.com' })).status).toBe(422);
    const before = (await app.ctx.db.select().from(applications)).length;
    const bot = await apply(job.slug, { ...applicant('bot@example.com'), website: 'http://spam' });
    expect(bot.status).toBe(201);
    expect((await app.ctx.db.select().from(applications)).length).toBe(before);
  });

  it('moves applications through the pipeline with history and notes', async () => {
    await apply(job.slug, applicant('move@example.com'));
    const list = await admin.get(`/api/v1/applications?jobId=${job.id}`);
    const a = list.body.items.find((x: any) => x.candidate.email === 'move@example.com');
    const stages = (await admin.get('/api/v1/pipeline-stages')).body.items;
    const interview = stages.find((s: any) => s.kind === 'interview');
    const moved = await admin.post(`/api/v1/applications/${a.id}/move`, { stageId: interview.id });
    expect(moved.body.stage.kind).toBe('interview');
    expect((await admin.post(`/api/v1/applications/${a.id}/notes`, { body: 'Starkes Interview' })).status).toBe(201);
    const detail = await admin.get(`/api/v1/applications/${a.id}`);
    expect(detail.body.transitions[0]).toMatchObject({ toStageId: interview.id });
    expect(detail.body.notes[0].body).toBe('Starkes Interview');
  });

  it('hires a candidate into an onboarding employment', async () => {
    await apply(job.slug, { ...applicant('hire@example.com'), firstName: 'Hanna', lastName: 'Hired' });
    const a = (await admin.get(`/api/v1/applications?jobId=${job.id}`)).body.items.find((x: any) => x.candidate.email === 'hire@example.com');
    const hired = await admin.post(`/api/v1/applications/${a.id}/hire`, { startDate: '2026-11-01', positionTitle: 'Senior Backend Engineer' });
    expect(hired.status).toBe(200);
    expect(hired.body.stage.kind).toBe('hired');
    const person = await admin.get(`/api/v1/persons/${hired.body.hiredPersonId}`);
    expect(person.body).toMatchObject({ firstName: 'Hanna', lastName: 'Hired', email: 'hire@example.com' });
    expect(person.body.employments[0]).toMatchObject({ status: 'ONBOARDING', startDate: '2026-11-01' });
    expect((await admin.post(`/api/v1/applications/${a.id}/hire`, { startDate: '2026-11-01' })).status).toBe(409);
  });

  it('restricts recruiting data to recruiting roles', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Neugierig' });
    expect((await emp.client.get('/api/v1/applications')).status).toBe(403);
    expect((await emp.client.post('/api/v1/jobs', { title: 'Hack' })).status).toBe(403);
  });

  it('limits managers to jobs where they are on the hiring team', async () => {
    const mgr = await createEmployee(app, admin, { firstName: 'Teamlos', role: 'manager' });
    const apps = await mgr.client.get(`/api/v1/applications?jobId=${job.id}`);
    expect(apps.status).toBe(200);
    expect(apps.body.items).toHaveLength(0);
    expect((await mgr.client.get('/api/v1/jobs')).body.items).toHaveLength(0);
    const any = (await admin.get(`/api/v1/applications?jobId=${job.id}`)).body.items[0];
    expect((await mgr.client.get(`/api/v1/applications/${any.id}`)).status).toBe(403);

    const candidates = await admin.get('/api/v1/recruiting/team-candidates');
    expect(candidates.body.items.find((c: any) => c.userId === mgr.userId)).toMatchObject({ firstName: 'Teamlos' });
    await admin.patch(`/api/v1/jobs/${job.id}`, { hiringTeamUserIds: [mgr.userId] });
    expect((await mgr.client.get(`/api/v1/applications?jobId=${job.id}`)).body.items.length).toBeGreaterThan(0);
    expect((await mgr.client.get(`/api/v1/applications/${any.id}`)).status).toBe(200);
  });

  it('anonymizes closed applications after the retention period (DSGVO)', async () => {
    await apply(job.slug, applicant('old@example.com'));
    const a = (await admin.get(`/api/v1/applications?jobId=${job.id}`)).body.items.find((x: any) => x.candidate.email === 'old@example.com');
    const rejected = (await admin.get('/api/v1/pipeline-stages')).body.items.find((s: any) => s.kind === 'rejected');
    await admin.post(`/api/v1/applications/${a.id}/move`, { stageId: rejected.id });
    await app.ctx.db.update(applications).set({ closedAt: new Date('2025-01-01') }).where(eq(applications.id, a.id));
    const res = await admin.post('/api/v1/recruiting/anonymize-expired');
    expect(res.body.anonymized).toBe(1);
    const detail = await admin.get(`/api/v1/applications/${a.id}`);
    expect(detail.body.candidate.email).not.toBe('old@example.com');
    expect(detail.body.coverLetter).toBeNull();
    expect(detail.body.anonymizedAt).toBeTruthy();
  });
});
