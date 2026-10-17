import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, multipart, setupCompany, type Client } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
type Emp = Awaited<ReturnType<typeof createEmployee>>;

describe('company documents with read confirmation', () => {
  let app: FastifyInstance;
  let admin: Client;
  let hr: Emp;
  let emp: Emp;
  let outsider: Emp;
  let salesId: string;
  let handbook: any;

  const upload = async (c: Client, fields: Record<string, string>, file = { name: 'handbuch.pdf', type: 'application/pdf', data: PDF }) => {
    const mp = multipart(fields, file);
    const res = await app.inject({ method: 'POST', url: '/api/v1/company-documents', payload: mp.payload, headers: { 'content-type': mp.contentType, cookie: c.cookie!, 'x-requested-with': 'openpers' } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    salesId = (await admin.post('/api/v1/org-units', { name: 'Vertrieb', type: 'department' })).body.id;
    hr = await createEmployee(app, admin, { firstName: 'Hilde', role: 'hr' });
    emp = await createEmployee(app, admin, { firstName: 'Emil', orgUnitIds: [salesId] });
    outsider = await createEmployee(app, admin, { firstName: 'Olga' });
  });
  afterAll(() => app.close());

  it('lets HR publish a document that everyone has to confirm', async () => {
    const res = await upload(hr.client, { title: 'Mitarbeiterhandbuch', description: 'Regeln & Abläufe', requiresAck: 'true' });
    expect(res.status).toBe(201);
    handbook = res.body;
    expect(handbook).toMatchObject({ title: 'Mitarbeiterhandbuch', requiresAck: true, mime: 'application/pdf' });
    expect(handbook.fileKey).toBeUndefined();
    const mine = (await emp.client.get('/api/v1/company-documents')).body.items;
    expect(mine.find((d: any) => d.id === handbook.id)).toMatchObject({ acknowledgedAt: null });
    // Whoever publishes the document does not have to confirm it again.
    expect((await hr.client.get('/api/v1/company-documents')).body.items.find((d: any) => d.id === handbook.id).acknowledgedAt).not.toBeNull();
    const notes = (await emp.client.get('/api/v1/notifications')).body.items;
    expect(notes.some((n: any) => n.kind === 'company_document')).toBe(true);
    expect((await upload(emp.client, { title: 'Hack' })).status).toBe(403);
  });

  it('records read confirmations and shows who is missing', async () => {
    const dl = await app.inject({ method: 'GET', url: `/api/v1/company-documents/${handbook.id}/download`, headers: { cookie: emp.client.cookie! } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
    expect((await emp.client.post(`/api/v1/company-documents/${handbook.id}/acknowledge`)).status).toBe(200);
    // Confirming twice keeps the first timestamp.
    const first = (await emp.client.get('/api/v1/company-documents')).body.items.find((d: any) => d.id === handbook.id).acknowledgedAt;
    await emp.client.post(`/api/v1/company-documents/${handbook.id}/acknowledge`);
    expect((await emp.client.get('/api/v1/company-documents')).body.items.find((d: any) => d.id === handbook.id).acknowledgedAt).toBe(first);
    const acks = (await hr.client.get(`/api/v1/company-documents/${handbook.id}/acknowledgements`)).body;
    expect(acks.acknowledged.map((a: any) => a.person.id).sort()).toEqual([emp.personId, hr.personId].sort());
    expect(acks.pending.map((a: any) => a.person.id)).toContain(outsider.personId);
    expect(acks.pending.map((a: any) => a.person.id)).not.toContain(hr.personId);
    expect((await emp.client.get(`/api/v1/company-documents/${handbook.id}/acknowledgements`)).status).toBe(403);
    const list = (await hr.client.get('/api/v1/company-documents')).body.items.find((d: any) => d.id === handbook.id);
    expect(list.stats).toMatchObject({ acknowledged: 2 });
  });

  it('limits documents to a department when an audience is set', async () => {
    const res = await upload(hr.client, { title: 'Provisionsrichtlinie', orgUnitId: salesId, requiresAck: 'false' }, { name: 'p.pdf', type: 'application/pdf', data: Buffer.concat([PDF, Buffer.from('x')]) });
    expect(res.status).toBe(201);
    expect((await emp.client.get('/api/v1/company-documents')).body.items.some((d: any) => d.id === res.body.id)).toBe(true);
    expect((await outsider.client.get('/api/v1/company-documents')).body.items.some((d: any) => d.id === res.body.id)).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/api/v1/company-documents/${res.body.id}/download`, headers: { cookie: outsider.client.cookie! } })).statusCode).toBe(403);
    expect((await outsider.client.post(`/api/v1/company-documents/${res.body.id}/acknowledge`)).status).toBe(403);
  });

  it('rejects disguised files and lets HR update and delete', async () => {
    expect((await upload(hr.client, { title: 'Fake' }, { name: 'x.pdf', type: 'application/pdf', data: Buffer.from('<html>') })).status).toBe(415);
    const upd = await hr.client.patch(`/api/v1/company-documents/${handbook.id}`, { title: 'Handbuch 2027' });
    expect(upd.body.title).toBe('Handbuch 2027');
    expect((await hr.client.delete(`/api/v1/company-documents/${handbook.id}`)).status).toBe(204);
    expect((await emp.client.get('/api/v1/company-documents')).body.items.some((d: any) => d.id === handbook.id)).toBe(false);
  });

  it('counts documents in the setup guide', async () => {
    const s = (await admin.get('/api/v1/setup-guide')).body.steps.find((x: any) => x.key === 'documents');
    expect(s).toMatchObject({ status: 'done', count: 1 });
  });
});
