import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { addDays } from '@openpers/shared';
import { surveyParticipants, surveyResponses } from '../src/db/schema';
import { runMaintenance } from '../src/lib/worker';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

type Emp = Awaited<ReturnType<typeof createEmployee>>;
const today = () => new Date().toISOString().slice(0, 10);

const QUESTIONS = [
  { id: 'mood', type: 'scale', text: 'Wie zufrieden bist du insgesamt?', required: true },
  { id: 'nps', type: 'enps', text: 'Wie wahrscheinlich empfiehlst du uns als Arbeitgeber?', required: true },
  { id: 'mode', type: 'choice', text: 'Wo arbeitest du am liebsten?', options: ['Büro', 'Remote', 'Hybrid'], required: false },
  { id: 'wish', type: 'text', text: 'Was sollen wir verbessern?', required: false },
];

describe('employee surveys', () => {
  let app: FastifyInstance;
  let admin: Client;
  let unit: string;
  const team: Emp[] = [];
  let outside: Emp;
  let survey: any;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    unit = (await admin.post('/api/v1/org-units', { name: 'Technik' })).body.id;
    for (const n of ['Ana', 'Ben', 'Cem', 'Dea']) team.push(await createEmployee(app, admin, { firstName: n, orgUnitIds: [unit] }));
    outside = await createEmployee(app, admin, { firstName: 'Xia' });
  });
  afterAll(() => app.close());

  it('creates, opens and notifies the audience', async () => {
    const created = await admin.post('/api/v1/surveys', { title: 'Pulse Q4', intro: 'Anonym, 3 Minuten.', anonymous: true, orgUnitId: unit, closesAt: addDays(today(), 10), questions: QUESTIONS });
    expect(created.status).toBe(201);
    const opened = await admin.post(`/api/v1/surveys/${created.body.id}/open`);
    expect(opened.body.status).toBe('open');
    survey = opened.body;
    const notes = (await team[0].client.get('/api/v1/notifications')).body.items;
    expect(notes.some((n: any) => n.kind === 'survey_open')).toBe(true);
    expect((await team[0].client.get('/api/v1/surveys/open')).body.items.map((s: any) => s.id)).toContain(survey.id);
    expect((await outside.client.get('/api/v1/surveys/open')).body.items.map((s: any) => s.id)).not.toContain(survey.id);
    expect((await team[0].client.post('/api/v1/surveys', { title: 'x', questions: [] })).status).toBe(403);
  });

  it('accepts one anonymous response per person and validates answers', async () => {
    expect((await team[0].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 9, nps: 10 } })).status).toBe(422);
    expect((await team[0].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { nps: 10 } })).status).toBe(422);
    const ok = await team[0].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 4, nps: 10, mode: 'Hybrid', wish: 'Mehr Fokuszeit' } });
    expect(ok.status).toBe(201);
    expect((await team[0].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 1, nps: 0 } })).status).toBe(409);
    expect((await outside.client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 1, nps: 0 } })).status).toBe(403);
    // The stored answer carries no person; participation is tracked separately.
    const rows = await app.ctx.db.select().from(surveyResponses);
    expect(Object.keys(rows[0])).not.toContain('userId');
    expect(JSON.stringify(rows)).not.toContain(team[0].personId);
    const parts = await app.ctx.db.select().from(surveyParticipants);
    expect(parts).toHaveLength(1);
    expect(Object.keys(parts[0])).not.toContain('responseId');
  });

  it('hides small groups and free texts until 3 answers exist', async () => {
    let res = await admin.get(`/api/v1/surveys/${survey.id}/results`);
    expect(res.body).toMatchObject({ responses: 1, audience: 4, responseRate: 25, suppressed: true });
    expect(res.body.questions.find((q: any) => q.id === 'wish').texts).toBeUndefined();
    await team[1].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 5, nps: 9, mode: 'Remote', wish: 'Bessere Laptops' } });
    await team[2].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 2, nps: 3, wish: 'Weniger Meetings' } });
    res = await admin.get(`/api/v1/surveys/${survey.id}/results`);
    expect(res.body.suppressed).toBe(false);
    const mood = res.body.questions.find((q: any) => q.id === 'mood');
    expect(mood.summary).toMatchObject({ count: 3, average: 3.7 });
    expect(res.body.questions.find((q: any) => q.id === 'nps').enps).toMatchObject({ score: 33, promoters: 2, detractors: 1 });
    expect(res.body.questions.find((q: any) => q.id === 'wish').texts).toHaveLength(3);
    expect(res.body.questions.find((q: any) => q.id === 'mode').choices.find((c: any) => c.option === 'Hybrid').count).toBe(1);
    expect(res.body.heatmap.find((r: any) => r.unit === 'Technik').values.mood).toBe(3.7);
    expect((await team[0].client.get(`/api/v1/surveys/${survey.id}/results`)).status).toBe(403);
  });

  it('reminds people who have not answered shortly before the end, once', async () => {
    const s = await admin.post('/api/v1/surveys', { title: 'Kurz', anonymous: true, closesAt: addDays(today(), 1), questions: [QUESTIONS[0]] });
    await admin.post(`/api/v1/surveys/${s.body.id}/open`);
    await outside.client.post(`/api/v1/surveys/${s.body.id}/responses`, { answers: { mood: 3 } });
    await runMaintenance(app.ctx);
    await runMaintenance(app.ctx);
    const reminders = (n: any[]) => n.filter((x) => x.kind === 'survey_reminder' && x.params.surveyId === s.body.id);
    expect(reminders((await team[3].client.get('/api/v1/notifications')).body.items)).toHaveLength(1);
    expect(reminders((await outside.client.get('/api/v1/notifications')).body.items)).toHaveLength(0);
  });

  it('stops accepting answers once closed', async () => {
    await admin.post(`/api/v1/surveys/${survey.id}/close`);
    expect((await team[3].client.post(`/api/v1/surveys/${survey.id}/responses`, { answers: { mood: 3, nps: 7 } })).status).toBe(409);
  });
});
