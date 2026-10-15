import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

type Emp = Awaited<ReturnType<typeof createEmployee>>;

describe('performance reviews, goals and feedback', () => {
  let app: FastifyInstance;
  let admin: Client;
  let mgr: Emp;
  let e1: Emp;
  let e2: Emp;
  let e3: Emp;
  let outsider: Emp;
  let cycle: any;

  const reviewFor = async (c: Client, revieweeId: string, type: string) => (await c.get('/api/v1/reviews/mine')).body.items.find((r: any) => r.revieweeId === revieweeId && r.type === type);

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    mgr = await createEmployee(app, admin, { firstName: 'Mara', role: 'manager' });
    e1 = await createEmployee(app, admin, { firstName: 'Ella', supervisorPersonId: mgr.personId });
    e2 = await createEmployee(app, admin, { firstName: 'Emil', supervisorPersonId: mgr.personId });
    e3 = await createEmployee(app, admin, { firstName: 'Enno', supervisorPersonId: mgr.personId });
    outsider = await createEmployee(app, admin, { firstName: 'Olaf' });
  });
  afterAll(() => app.close());

  it('creates and starts a review cycle that assigns self and manager reviews', async () => {
    const created = await admin.post('/api/v1/review-cycles', {
      name: 'Jahresgespräch 2026',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
      dueDate: '2026-12-15',
      selfReview: true,
      managerReview: true,
      peerReview: true,
      participantPersonIds: [e1.personId, e2.personId, e3.personId],
      questions: [
        { id: 'q1', type: 'rating', text: 'Zielerreichung', required: true },
        { id: 'q2', type: 'text', text: 'Was lief besonders gut?', required: true },
      ],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    const started = await admin.post(`/api/v1/review-cycles/${created.body.id}/start`);
    expect(started.status).toBe(200);
    expect(started.body.status).toBe('active');
    cycle = started.body;
    expect(await reviewFor(e1.client, e1.personId, 'self')).toMatchObject({ status: 'pending' });
    const mine = (await mgr.client.get('/api/v1/reviews/mine')).body.items.filter((r: any) => r.type === 'manager');
    expect(mine).toHaveLength(3);
    const notes = (await mgr.client.get('/api/v1/notifications')).body.items;
    expect(notes.some((n: any) => n.kind === 'review_assigned')).toBe(true);
    expect((await outsider.client.post('/api/v1/review-cycles', { name: 'x', questions: [] })).status).toBe(403);
  });

  it('validates answers and locks submitted reviews', async () => {
    const self = await reviewFor(e1.client, e1.personId, 'self');
    expect((await e1.client.put(`/api/v1/reviews/${self.id}`, { answers: { q1: 7 } })).status).toBe(422);
    expect((await e1.client.put(`/api/v1/reviews/${self.id}`, { answers: { q1: 4 } })).status).toBe(200);
    expect((await e1.client.put(`/api/v1/reviews/${self.id}`, { answers: { q1: 4 }, submit: true })).status).toBe(422);
    const done = await e1.client.put(`/api/v1/reviews/${self.id}`, { answers: { q1: 4, q2: 'Projekt X geliefert' }, submit: true });
    expect(done.body.status).toBe('submitted');
    expect((await e1.client.put(`/api/v1/reviews/${self.id}`, { answers: { q1: 5, q2: 'neu' } })).status).toBe(409);
    expect((await e2.client.put(`/api/v1/reviews/${self.id}`, { answers: { q1: 1, q2: 'fremd' } })).status).toBe(403);
  });

  it('keeps peer feedback anonymous and hidden until enough peers submitted', async () => {
    expect((await outsider.client.post(`/api/v1/review-cycles/${cycle.id}/peers`, { revieweeId: e1.personId, reviewerPersonIds: [outsider.personId] })).status).toBe(403);
    const assigned = await mgr.client.post(`/api/v1/review-cycles/${cycle.id}/peers`, { revieweeId: e1.personId, reviewerPersonIds: [e2.personId, e3.personId] });
    expect(assigned.status).toBe(201);
    const p2 = await reviewFor(e2.client, e1.personId, 'peer');
    await e2.client.put(`/api/v1/reviews/${p2.id}`, { answers: { q1: 5, q2: 'Super Teamplayerin' }, submit: true });
    let res = await mgr.client.get(`/api/v1/reviews/results?cycleId=${cycle.id}&personId=${e1.personId}`);
    expect(res.body.peers).toMatchObject({ submitted: 1, visible: false });
    expect(res.body.peers.answers).toBeUndefined();
    const p3 = await reviewFor(e3.client, e1.personId, 'peer');
    await e3.client.put(`/api/v1/reviews/${p3.id}`, { answers: { q1: 4, q2: 'Hilft immer' }, submit: true });
    res = await mgr.client.get(`/api/v1/reviews/results?cycleId=${cycle.id}&personId=${e1.personId}`);
    expect(res.body.peers.visible).toBe(true);
    expect(res.body.peers.answers.q1.average).toBe(4.5);
    expect(res.body.peers.answers.q2.texts.sort()).toEqual(['Hilft immer', 'Super Teamplayerin']);
    expect(JSON.stringify(res.body.peers)).not.toContain(e2.personId);
  });

  it('shows the manager review to the employee only after release', async () => {
    const m = await reviewFor(mgr.client, e1.personId, 'manager');
    await mgr.client.put(`/api/v1/reviews/${m.id}`, { answers: { q1: 4, q2: 'Starkes Jahr' }, submit: true });
    let own = await e1.client.get(`/api/v1/reviews/results?cycleId=${cycle.id}&personId=${e1.personId}`);
    expect(own.body.released).toBe(false);
    expect(own.body.self.answers.q1).toBe(4);
    expect(own.body.manager).toBeNull();
    expect(own.body.peers).toBeNull();
    expect((await e1.client.post(`/api/v1/review-cycles/${cycle.id}/release`, { personId: e1.personId })).status).toBe(403);
    expect((await mgr.client.post(`/api/v1/review-cycles/${cycle.id}/release`, { personId: e1.personId })).status).toBe(200);
    own = await e1.client.get(`/api/v1/reviews/results?cycleId=${cycle.id}&personId=${e1.personId}`);
    expect(own.body.released).toBe(true);
    expect(own.body.manager.answers.q2).toBe('Starkes Jahr');
    expect(own.body.peers.visible).toBe(true);
    expect((await outsider.client.get(`/api/v1/reviews/results?cycleId=${cycle.id}&personId=${e1.personId}`)).status).toBe(403);
    const overview = await admin.get(`/api/v1/review-cycles/${cycle.id}`);
    expect(overview.body.progress).toMatchObject({ submitted: expect.any(Number), total: expect.any(Number) });
  });

  it('lists the cycles a person took part in for permitted viewers', async () => {
    const list = await mgr.client.get(`/api/v1/persons/${e1.personId}/review-cycles`);
    expect(list.body.items.map((c: any) => c.id)).toContain(cycle.id);
    expect((await e1.client.get(`/api/v1/persons/${e1.personId}/review-cycles`)).status).toBe(200);
    expect((await outsider.client.get(`/api/v1/persons/${e1.personId}/review-cycles`)).status).toBe(403);
  });

  it('manages goals for the employee and the manager only', async () => {
    const goal = await mgr.client.post(`/api/v1/persons/${e1.personId}/goals`, { title: 'Zertifizierung abschließen', dueDate: '2026-12-31' });
    expect(goal.status).toBe(201);
    const upd = await e1.client.patch(`/api/v1/goals/${goal.body.id}`, { progress: 60 });
    expect(upd.body.progress).toBe(60);
    expect((await e2.client.post(`/api/v1/persons/${e1.personId}/goals`, { title: 'Hack' })).status).toBe(403);
    expect((await outsider.client.get(`/api/v1/persons/${e1.personId}/goals`)).status).toBe(403);
    expect((await e1.client.get(`/api/v1/persons/${e1.personId}/goals`)).body.items).toHaveLength(1);
  });

  it('shares praise openly but keeps private feedback for the manager', async () => {
    expect((await e2.client.post(`/api/v1/persons/${e1.personId}/feedback`, { kind: 'praise', text: 'Danke für die Hilfe beim Release!' })).status).toBe(201);
    expect((await e2.client.post(`/api/v1/persons/${e1.personId}/feedback`, { kind: 'private', text: 'Könnte Meetings besser vorbereiten.' })).status).toBe(201);
    const own = (await e1.client.get(`/api/v1/persons/${e1.personId}/feedback`)).body.items.map((f: any) => f.kind);
    expect(own).toEqual(['praise']);
    const asMgr = (await mgr.client.get(`/api/v1/persons/${e1.personId}/feedback`)).body.items.map((f: any) => f.kind).sort();
    expect(asMgr).toEqual(['praise', 'private']);
    expect((await e1.client.post(`/api/v1/persons/${e1.personId}/feedback`, { kind: 'praise', text: 'Selbstlob' })).status).toBe(422);
  });

  it('closes the cycle and rejects late submissions', async () => {
    expect((await admin.post(`/api/v1/review-cycles/${cycle.id}/close`)).body.status).toBe('closed');
    const self2 = await reviewFor(e2.client, e2.personId, 'self');
    expect((await e2.client.put(`/api/v1/reviews/${self2.id}`, { answers: { q1: 3, q2: 'x' }, submit: true })).status).toBe(409);
  });
});
