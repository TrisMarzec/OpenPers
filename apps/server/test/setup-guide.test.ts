import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

describe('company setup guide', () => {
  let app: FastifyInstance;
  let admin: Client;

  const status = async () => {
    const body = (await admin.get('/api/v1/setup-guide')).body;
    return { ...body, byKey: Object.fromEntries(body.steps.map((s: any) => [s.key, s.status])) };
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
  });
  afterAll(() => app.close());

  it('starts with all six steps open for a fresh company', async () => {
    const s = await status();
    expect(s.steps.map((x: any) => x.key)).toEqual(['company', 'locations', 'departments', 'roles', 'documents', 'people']);
    expect(Object.values(s.byKey).every((v) => v === 'open')).toBe(true);
    expect(s).toMatchObject({ completed: 0, total: 6, dismissed: false });
  });

  it('marks data steps done once their data exists', async () => {
    await admin.post('/api/v1/workplaces', { name: 'Berlin', region: 'DE-BE' });
    await admin.post('/api/v1/org-units', { name: 'Vertrieb', type: 'department' });
    await createEmployee(app, admin, { firstName: 'Erste' });
    const s = await status();
    expect(s.byKey).toMatchObject({ locations: 'done', departments: 'done', people: 'done', company: 'open', roles: 'open' });
    expect(s.steps.find((x: any) => x.key === 'departments').count).toBe(1);
    expect(s.completed).toBe(3);
  });

  it('confirms, skips and reopens steps', async () => {
    expect((await admin.post('/api/v1/setup-guide/steps/company', { status: 'done' })).status).toBe(200);
    expect((await admin.post('/api/v1/setup-guide/steps/documents', { status: 'skipped' })).status).toBe(200);
    let s = await status();
    expect(s.byKey).toMatchObject({ company: 'done', documents: 'skipped' });
    expect(s.completed).toBe(5);
    await admin.post('/api/v1/setup-guide/steps/company', { status: 'open' });
    s = await status();
    expect(s.byKey.company).toBe('open');
    expect((await admin.post('/api/v1/setup-guide/steps/nonsense', { status: 'done' })).status).toBe(404);
  });

  it('can be dismissed and is only for admins', async () => {
    expect((await admin.post('/api/v1/setup-guide/dismiss')).status).toBe(200);
    expect((await status()).dismissed).toBe(true);
    const emp = await createEmployee(app, admin, { firstName: 'Neugier' });
    expect((await emp.client.get('/api/v1/setup-guide')).status).toBe(403);
  });
});
