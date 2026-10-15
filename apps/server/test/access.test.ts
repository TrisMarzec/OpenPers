import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { auditLog, compensations } from '../src/db/schema';
import { createEmployee, createTestApp, login, setupCompany, type Client } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

describe('field-level access to sensitive data', () => {
  let app: FastifyInstance;
  let admin: Client;
  let mgr: Awaited<ReturnType<typeof createEmployee>>;
  let emp: Awaited<ReturnType<typeof createEmployee>>;
  let hr: Awaited<ReturnType<typeof createEmployee>>;

  const upload = async (c: Client, personId: string, categoryId: string, visible?: boolean) => {
    const boundary = '----x' + Math.random().toString(16).slice(2);
    const fields: Record<string, string> = { categoryId, ...(visible === undefined ? {} : { employeeVisible: String(visible) }) };
    const parts = Object.entries(fields).map(([k, v]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    const payload = Buffer.concat([...parts, Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="d.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), Buffer.concat([PDF, Buffer.from(Math.random().toString())]), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = await app.inject({ method: 'POST', url: `/api/v1/persons/${personId}/documents`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: c.cookie!, 'x-requested-with': 'openpers' } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    mgr = await createEmployee(app, admin, { firstName: 'Mara', role: 'manager' });
    emp = await createEmployee(app, admin, { firstName: 'Erik', supervisorPersonId: mgr.personId });
    hr = await createEmployee(app, admin, { firstName: 'Helga', role: 'hr' });
    await admin.patch(`/api/v1/persons/${emp.personId}`, { birthDate: '1990-05-01', privateAddress: 'Geheimweg 1', phone: '+49 30 1' });
    await admin.post('/api/v1/attribute-definitions', { key: 'iban', label: 'IBAN', type: 'text', sensitive: true, category: 'payroll' });
    await admin.put(`/api/v1/persons/${emp.personId}/attributes`, { iban: 'DE02120300000000202051' });
  });
  afterAll(() => app.close());

  it('returns the viewer’s access per category and hides personal data from managers', async () => {
    const asMgr = await mgr.client.get(`/api/v1/persons/${emp.personId}`);
    expect(asMgr.status).toBe(200);
    expect(asMgr.body.access).toMatchObject({ profile: 'view', contact: 'view', personal: 'none', employment: 'view', compensation: 'none', payroll: 'none' });
    expect(asMgr.body.phone).toBe('+49 30 1');
    expect(asMgr.body).not.toHaveProperty('birthDate');
    expect(asMgr.body).not.toHaveProperty('privateAddress');
    expect(asMgr.body.attributes.iban).toBeUndefined();
    expect(asMgr.body.employments[0].contractType).toBeDefined();

    const self = await emp.client.get(`/api/v1/persons/${emp.personId}`);
    expect(self.body.access).toMatchObject({ profile: 'view', personal: 'edit', payroll: 'edit', compensation: 'view' });
    expect(self.body.birthDate).toBe('1990-05-01');
    expect(self.body.attributes.iban).toBe('DE02120300000000202051');

    const asHr = await hr.client.get(`/api/v1/persons/${emp.personId}`);
    expect(asHr.body.access.compensation).toBe('edit');
    expect(asHr.body.privateAddress).toBe('Geheimweg 1');
  });

  it('enforces edit rights per category on updates', async () => {
    expect((await mgr.client.patch(`/api/v1/persons/${emp.personId}`, { phone: '+49 1' })).status).toBe(403);
    expect((await emp.client.patch(`/api/v1/persons/${emp.personId}`, { privateAddress: 'Neu 2', birthDate: '1990-05-02' })).status).toBe(200);
    expect((await emp.client.patch(`/api/v1/persons/${emp.personId}`, { lastName: 'Anders' })).status).toBe(403);
    expect((await emp.client.put(`/api/v1/persons/${emp.personId}/attributes`, { iban: 'DE89370400440532013000' })).status).toBe(200);
    expect((await mgr.client.put(`/api/v1/persons/${emp.personId}/attributes`, { iban: 'X' })).status).toBe(403);
    expect((await hr.client.patch(`/api/v1/persons/${emp.personId}`, { lastName: 'Korrekt' })).status).toBe(200);
  });

  it('stores compensation encrypted and shows it only to permitted viewers', async () => {
    const created = await hr.client.post(`/api/v1/persons/${emp.personId}/compensations`, { type: 'FIXED_SALARY', amount: 4500, currency: 'EUR', interval: 'MONTHLY', validFrom: '2026-01-01', comment: 'Einstieg' });
    expect(created.status).toBe(201);
    const rows = await app.ctx.db.select().from(compensations).where(eq(compensations.personId, emp.personId));
    expect(JSON.stringify(rows)).not.toContain('4500');

    const own = await emp.client.get(`/api/v1/persons/${emp.personId}/compensations`);
    expect(own.body.items[0]).toMatchObject({ type: 'FIXED_SALARY', amount: 4500, currency: 'EUR', interval: 'MONTHLY' });
    expect((await emp.client.post(`/api/v1/persons/${emp.personId}/compensations`, { type: 'ONE_TIME', amount: 1, currency: 'EUR', validFrom: '2026-02-01' })).status).toBe(403);
    expect((await mgr.client.get(`/api/v1/persons/${emp.personId}/compensations`)).status).toBe(403);
    const invalid = await hr.client.post(`/api/v1/persons/${emp.personId}/compensations`, { type: 'FIXED_SALARY', amount: 100, currency: 'EUR', validFrom: '2026-01-01' });
    expect(invalid.status).toBe(422);
  });

  it('lets admins grant salary visibility to a custom role and logs sensitive reads', async () => {
    const role = await admin.post('/api/v1/roles', {
      key: 'lead_plus',
      name: 'Teamleitung (mit Gehalt)',
      permissions: ['people.read'],
      defaultScope: 'reports',
      fieldAccess: { compensation: { self: 'view', others: 'view' } },
    });
    expect(role.status).toBe(201);
    expect(role.body.fieldAccess.compensation.others).toBe('view');
    expect(role.body.fieldAccess.personal.others).toBe('none');
    await admin.patch(`/api/v1/users/${mgr.userId}`, { roles: ['manager', 'lead_plus'] });
    const relog = await login(app, mgr.email, 'password-123456');
    expect((await relog.get(`/api/v1/persons/${emp.personId}/compensations`)).status).toBe(200);
    const logs = await app.ctx.db.select().from(auditLog).where(eq(auditLog.entityId, emp.personId));
    expect(logs.some((l) => l.action === 'read_sensitive' && l.actorUserId === mgr.userId)).toBe(true);
    await admin.patch(`/api/v1/users/${mgr.userId}`, { roles: ['manager'] });
  });

  it('lets admins change the access matrix of built-in roles but not their permissions', async () => {
    const roles = (await admin.get('/api/v1/roles')).body.items;
    const manager = roles.find((r: any) => r.key === 'manager');
    expect(manager.fieldAccess.payroll.others).toBe('none');
    const ok = await admin.patch(`/api/v1/roles/${manager.id}`, { fieldAccess: { ...manager.fieldAccess, personal: { self: 'edit', others: 'view' } } });
    expect(ok.status).toBe(200);
    expect((await mgr.client.get(`/api/v1/persons/${emp.personId}`)).body.privateAddress).toBe('Neu 2');
    expect((await admin.patch(`/api/v1/roles/${manager.id}`, { permissions: ['people.read'] })).status).toBe(403);
    await admin.patch(`/api/v1/roles/${manager.id}`, { fieldAccess: manager.fieldAccess });
    const admins = roles.find((r: any) => r.key === 'admin');
    expect((await admin.patch(`/api/v1/roles/${admins.id}`, { fieldAccess: manager.fieldAccess })).status).toBe(403);
  });

  it('applies data categories to documents', async () => {
    const cats = Object.fromEntries((await admin.get('/api/v1/document-categories')).body.items.map((c: any) => [c.name, c]));
    expect(cats['Arbeitsvertrag'].dataCategory).toBe('compensation');
    expect(cats['Gehaltsabrechnungen'].dataCategory).toBe('payroll');
    const contract = await upload(hr.client, emp.personId, cats['Arbeitsvertrag'].id);
    const payslip = await upload(hr.client, emp.personId, cats['Gehaltsabrechnungen'].id);
    const reference = await upload(hr.client, emp.personId, cats['Zeugnisse'].id);
    expect([contract.status, payslip.status, reference.status]).toEqual([201, 201, 201]);

    const asMgr = (await mgr.client.get(`/api/v1/persons/${emp.personId}/documents`)).body.items.map((d: any) => d.id);
    expect(asMgr).toEqual([reference.body.id]);
    expect((await mgr.client.get(`/api/v1/documents/${payslip.body.id}/download`)).status).toBe(403);

    const own = (await emp.client.get(`/api/v1/persons/${emp.personId}/documents`)).body.items.map((d: any) => d.id);
    expect(own).toEqual(expect.arrayContaining([payslip.body.id, reference.body.id]));
    expect(own).not.toContain(contract.body.id);
  });
});

describe('team working times', () => {
  let app: FastifyInstance;
  let admin: Client;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
  });
  afterAll(() => app.close());

  it('shows managers the month totals of their reports only', async () => {
    const mgr = await createEmployee(app, admin, { firstName: 'Tea', role: 'manager', startDate: '2026-01-01' });
    const a = await createEmployee(app, admin, { firstName: 'Anja', supervisorPersonId: mgr.personId, startDate: '2026-01-01' });
    const b = await createEmployee(app, admin, { firstName: 'Bodo', supervisorPersonId: mgr.personId, startDate: '2026-01-01' });
    const outsider = await createEmployee(app, admin, { firstName: 'Xaver', startDate: '2026-01-01' });
    await a.client.put('/api/v1/attendance/day', { date: '2026-06-08', start: '08:00', end: '17:00', breakMinutes: 30 });
    await b.client.put('/api/v1/attendance/day', { date: '2026-06-09', start: '09:00', end: '13:00', breakMinutes: 0 });

    const team = await mgr.client.get('/api/v1/attendance/team?month=2026-06');
    expect(team.status).toBe(200);
    const ids = team.body.items.map((r: any) => r.person.id);
    expect(ids).toEqual(expect.arrayContaining([a.personId, b.personId]));
    expect(ids).not.toContain(outsider.personId);
    const anja = team.body.items.find((r: any) => r.person.id === a.personId);
    expect(anja).toMatchObject({ workedMinutes: 510, person: { firstName: 'Anja' } });
    expect(anja.targetMinutes).toBeGreaterThan(0);
    expect(typeof anja.balanceMinutes).toBe('number');

    const own = await outsider.client.get('/api/v1/attendance/team?month=2026-06');
    expect(own.body.items.map((r: any) => r.person.id)).toEqual([outsider.personId]);

    const all = await admin.get('/api/v1/attendance/team?month=2026-06');
    expect(all.body.items.length).toBeGreaterThanOrEqual(5);
  });
});
