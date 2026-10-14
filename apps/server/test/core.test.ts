import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ADMIN, client, createTestApp, login, setupCompany } from './helpers';

describe('core: setup & auth', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(() => app.close());

  it('reports that setup is needed, then performs setup exactly once', async () => {
    const anon = client(app);
    expect((await anon.get('/api/v1/setup/status')).body).toEqual({ needsSetup: true });
    await setupCompany(app);
    expect((await anon.get('/api/v1/setup/status')).body).toEqual({ needsSetup: false });
    const again = await anon.post('/api/v1/setup', { companyName: 'X', region: 'DE-BY', locale: 'de', admin: { ...ADMIN, firstName: 'A', lastName: 'B' } });
    expect(again.status).toBe(409);
  });

  it('rejects a wrong password with 401 problem+json', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: ADMIN.email, password: 'nope' }, headers: { 'x-requested-with': 'openpers' } });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('returns the current user with admin permissions', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    const me = await admin.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(ADMIN.email);
    expect(me.body.personId).toBeTruthy();
    expect(me.body.permissions['users.manage']).toEqual(['all']);
  });

  it('requires authentication', async () => {
    expect((await client(app).get('/api/v1/auth/me')).status).toBe(401);
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    const res = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: admin.cookie! }, payload: { email: 'x@example.com', password: 'password-123456', roles: ['employee'] } });
    expect(res.statusCode).toBe(403);
  });

  it('validates input with 422 and field errors', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    const res = await admin.post('/api/v1/users', { email: 'not-an-email', password: 'x', roles: [] });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: any) => e.path)).toEqual(expect.arrayContaining(['email', 'password']));
  });

  it('lets admins create users; employees cannot manage users', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    const created = await admin.post('/api/v1/users', { email: 'emp@example.com', password: 'password-123456', roles: ['employee'] });
    expect(created.status).toBe(201);
    const dup = await admin.post('/api/v1/users', { email: 'EMP@example.com', password: 'password-123456', roles: ['employee'] });
    expect(dup.status).toBe(409);
    const emp = await login(app, 'emp@example.com', 'password-123456');
    expect((await emp.get('/api/v1/users')).status).toBe(403);
    const audit = await admin.get('/api/v1/audit-log?entity=user');
    expect(audit.body.items.some((a: any) => a.entityId === created.body.id && a.action === 'create')).toBe(true);
  });

  it('logs out and invalidates the session', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    expect((await admin.post('/api/v1/auth/logout')).status).toBe(204);
    expect((await admin.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('supports API tokens shown once, usable without CSRF header, revocable', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    const t = await admin.post('/api/v1/api-tokens', { name: 'CI' });
    expect(t.status).toBe(201);
    expect(t.body.token).toMatch(/^opk_/);
    const list = await admin.get('/api/v1/api-tokens');
    expect(JSON.stringify(list.body)).not.toContain(t.body.token);
    const res = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${t.body.token}` } });
    expect(res.statusCode).toBe(200);
    expect((await admin.delete(`/api/v1/api-tokens/${t.body.id}`)).status).toBe(204);
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${t.body.token}` } });
    expect(after.statusCode).toBe(401);
  });

  it('serves an OpenAPI document and health check', async () => {
    const doc = await client(app).get('/api/v1/openapi.json');
    expect(doc.body.openapi).toBe('3.1.0');
    expect(Object.keys(doc.body.paths)).toContain('/api/v1/users');
    expect((await client(app).get('/healthz')).status).toBe(200);
  });

  it('updates company settings', async () => {
    const admin = await login(app, ADMIN.email, ADMIN.password);
    const res = await admin.patch('/api/v1/company', { name: 'Acme AG' });
    expect(res.status).toBe(200);
    expect((await admin.get('/api/v1/company')).body.name).toBe('Acme AG');
  });
});
