import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { attributeValues } from '../src/db/schema';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

describe('org & people', () => {
  let app: FastifyInstance;
  let admin: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
  });
  afterAll(() => app.close());

  it('manages legal entities, workplaces, cost centers and an org unit tree', async () => {
    const le = await admin.post('/api/v1/legal-entities', { name: 'Acme GmbH', region: 'DE-BY' });
    expect(le.status).toBe(201);
    const wp = await admin.post('/api/v1/workplaces', { name: 'München', region: 'DE-BY' });
    expect(wp.status).toBe(201);
    const cc = await admin.post('/api/v1/cost-centers', { code: '4711', name: 'Engineering' });
    expect(cc.status).toBe(201);
    const dep = await admin.post('/api/v1/org-units', { name: 'Engineering', type: 'department' });
    const team = await admin.post('/api/v1/org-units', { name: 'Platform', type: 'team', parentId: dep.body.id });
    expect(team.body.parentId).toBe(dep.body.id);
    const list = await admin.get('/api/v1/org-units');
    expect(list.body.items.map((o: any) => o.name)).toEqual(expect.arrayContaining(['Engineering', 'Platform']));
    expect((await admin.patch(`/api/v1/org-units/${dep.body.id}`, { parentId: team.body.id })).status).toBe(422);
  });

  it('creates a person with employment and rejects duplicate emails', async () => {
    const body = { firstName: 'Max', lastName: 'Muster', email: 'max@example.com', employment: { startDate: '2025-01-01', positionTitle: 'Dev', weeklyHours: [8, 8, 8, 8, 0, 0, 0] } };
    const res = await admin.post('/api/v1/persons', body);
    expect(res.status).toBe(201);
    expect((await admin.post('/api/v1/persons', body)).status).toBe(409);
    const p = await admin.get(`/api/v1/persons/${res.body.id}`);
    expect(p.body.firstName).toBe('Max');
    expect(p.body.employments).toHaveLength(1);
    expect(p.body.employments[0].schedules[0].hours).toEqual([8, 8, 8, 8, 0, 0, 0]);
  });

  it('restricts managers to their reports and employees to themselves', async () => {
    const mgr = await createEmployee(app, admin, { firstName: 'Mona', role: 'manager' });
    const report = await createEmployee(app, admin, { firstName: 'Rita', supervisorPersonId: mgr.personId });
    const indirect = await createEmployee(app, admin, { firstName: 'Ida', supervisorPersonId: report.personId });
    const other = await createEmployee(app, admin, { firstName: 'Otto' });

    const list = await mgr.client.get('/api/v1/persons');
    const ids = list.body.items.map((p: any) => p.id);
    expect(ids).toEqual(expect.arrayContaining([report.personId, indirect.personId]));
    expect(ids).not.toContain(other.personId);
    expect((await mgr.client.get(`/api/v1/persons/${other.personId}`)).status).toBe(403);
    expect((await mgr.client.get(`/api/v1/persons/${report.personId}`)).status).toBe(200);

    expect((await other.client.get(`/api/v1/persons/${other.personId}`)).status).toBe(200);
    expect((await other.client.get(`/api/v1/persons/${report.personId}`)).status).toBe(403);
    const own = await other.client.get('/api/v1/persons');
    expect(own.body.items.map((p: any) => p.id)).toEqual([other.personId]);
  });

  it('offers a company directory with limited fields to everyone', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Dora' });
    const dir = await emp.client.get('/api/v1/directory');
    expect(dir.status).toBe(200);
    expect(dir.body.items.length).toBeGreaterThan(2);
    expect(dir.body.items[0]).not.toHaveProperty('birthDate');
    expect(dir.body.items[0]).not.toHaveProperty('privateAddress');
  });

  it('lets employees edit only their own contact details', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Egon' });
    expect((await emp.client.patch(`/api/v1/persons/${emp.personId}`, { phone: '+49 30 123' })).status).toBe(200);
    expect((await emp.client.patch(`/api/v1/persons/${emp.personId}`, { lastName: 'Hacker' })).status).toBe(403);
    const changed = await admin.patch(`/api/v1/persons/${emp.personId}`, { lastName: 'Neu' });
    expect(changed.body.lastName).toBe('Neu');
    const audit = await admin.get(`/api/v1/audit-log?entity=person&entityId=${emp.personId}`);
    expect(audit.body.items.some((a: any) => a.action === 'update' && a.changes.lastName)).toBe(true);
  });

  it('schedules future employment changes and applies past-dated ones immediately', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Fritz' });
    const p = await admin.get(`/api/v1/persons/${emp.personId}`);
    const eid = p.body.employments[0].id;
    const future = await admin.patch(`/api/v1/persons/${emp.personId}/employments/${eid}`, { effectiveDate: '2099-01-01', positionTitle: 'Lead' });
    expect(future.status).toBe(200);
    expect(future.body.positionTitle).toBe('Engineer');
    const changes = await admin.get(`/api/v1/persons/${emp.personId}/employments/${eid}/changes`);
    expect(changes.body.items[0]).toMatchObject({ effectiveDate: '2099-01-01', appliedAt: null });
    const now = await admin.patch(`/api/v1/persons/${emp.personId}/employments/${eid}`, { positionTitle: 'Senior Engineer' });
    expect(now.body.positionTitle).toBe('Senior Engineer');
    const sched = await admin.post(`/api/v1/persons/${emp.personId}/employments/${eid}/schedules`, { validFrom: '2026-01-01', weeklyHours: [4, 4, 4, 4, 4, 0, 0] });
    expect(sched.status).toBe(201);
  });

  it('rejects a person being their own supervisor', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Selma' });
    const p = await admin.get(`/api/v1/persons/${emp.personId}`);
    const res = await admin.patch(`/api/v1/persons/${emp.personId}/employments/${p.body.employments[0].id}`, { supervisorPersonId: emp.personId });
    expect(res.status).toBe(422);
  });

  it('encrypts sensitive custom attributes and hides them without permission', async () => {
    const def = await admin.post('/api/v1/attribute-definitions', { key: 'iban', label: 'IBAN', type: 'text', sensitive: true, section: 'payroll' });
    expect(def.status).toBe(201);
    await admin.post('/api/v1/attribute-definitions', { key: 'shirt', label: 'T-Shirt', type: 'select', options: ['S', 'M', 'L'] });
    const mgr = await createEmployee(app, admin, { firstName: 'Mark', role: 'manager' });
    const emp = await createEmployee(app, admin, { firstName: 'Ina', supervisorPersonId: mgr.personId });
    const put = await admin.put(`/api/v1/persons/${emp.personId}/attributes`, { iban: 'DE89370400440532013000', shirt: 'M' });
    expect(put.status).toBe(200);
    expect((await admin.put(`/api/v1/persons/${emp.personId}/attributes`, { shirt: 'XXL' })).status).toBe(422);

    const rows = await app.ctx.db.select().from(attributeValues).where(eq(attributeValues.definitionId, def.body.id));
    expect(JSON.stringify(rows[0].value)).not.toContain('DE89');

    const asAdmin = await admin.get(`/api/v1/persons/${emp.personId}`);
    expect(asAdmin.body.attributes.iban).toBe('DE89370400440532013000');
    const asMgr = await mgr.client.get(`/api/v1/persons/${emp.personId}`);
    expect(asMgr.body.attributes.iban).toBeUndefined();
    expect(asMgr.body.attributes.shirt).toBe('M');
  });

  it('exports all personal data (DSGVO Art. 15) and anonymizes on request', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Gerda' });
    const exp = await admin.get(`/api/v1/persons/${emp.personId}/export`);
    expect(exp.status).toBe(200);
    expect(exp.body.person.firstName).toBe('Gerda');
    expect(exp.body.employments).toHaveLength(1);
    expect((await emp.client.get(`/api/v1/persons/${emp.personId}/export`)).status).toBe(200);

    const anon = await admin.post(`/api/v1/persons/${emp.personId}/anonymize`);
    expect(anon.status).toBe(200);
    const after = await admin.get(`/api/v1/persons/${emp.personId}`);
    expect(after.body.firstName).not.toBe('Gerda');
    expect(after.body.anonymizedAt).toBeTruthy();
    expect((await emp.client.get('/api/v1/auth/me')).status).toBe(401);
  });
});
