import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, setupCompany, type Client } from './helpers';

function multipart(fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) {
  const boundary = `----openpers${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');

describe('documents', () => {
  let app: FastifyInstance;
  let admin: Client;
  let cats: Record<string, string>;

  const upload = async (c: Client, personId: string, fields: Record<string, string>, file?: { name: string; type: string; data: Buffer }) => {
    const mp = multipart(fields, file);
    const res = await app.inject({ method: 'POST', url: `/api/v1/persons/${personId}/documents`, payload: mp.payload, headers: { 'content-type': mp.contentType, cookie: c.cookie!, 'x-requested-with': 'openpers' } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    const list = await admin.get('/api/v1/document-categories');
    cats = Object.fromEntries(list.body.items.map((c: any) => [c.name, c.id]));
  });
  afterAll(() => app.close());

  it('seeds default categories', () => {
    expect(Object.keys(cats)).toEqual(expect.arrayContaining(['Arbeitsvertrag', 'Gehaltsabrechnungen']));
  });

  it('lets HR upload and employees see only employee-visible documents', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Doku' });
    const contract = await upload(admin, emp.personId, { categoryId: cats['Arbeitsvertrag'] }, { name: 'vertrag.pdf', type: 'application/pdf', data: PDF });
    expect(contract.status).toBe(201);
    expect(contract.body.employeeVisible).toBe(false);
    const payslip = await upload(admin, emp.personId, { categoryId: cats['Gehaltsabrechnungen'], documentDate: '2026-09-30' }, { name: 'lohn-09.pdf', type: 'application/pdf', data: PDF });
    expect(payslip.body.employeeVisible).toBe(true);

    const own = await emp.client.get(`/api/v1/persons/${emp.personId}/documents`);
    expect(own.body.items.map((d: any) => d.id)).toEqual([payslip.body.id]);
    expect((await emp.client.get(`/api/v1/documents/${contract.body.id}/download`)).status).toBe(403);
    const dl = await app.inject({ method: 'GET', url: `/api/v1/documents/${payslip.body.id}/download`, headers: { cookie: emp.client.cookie! } });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PDF)).toBe(true);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.headers['x-content-type-options']).toBe('nosniff');

    const hr = await admin.get(`/api/v1/persons/${emp.personId}/documents`);
    expect(hr.body.items).toHaveLength(2);
  });

  it('denies access to other employees', async () => {
    const a = await createEmployee(app, admin, { firstName: 'Anton' });
    const b = await createEmployee(app, admin, { firstName: 'Berta' });
    const doc = await upload(admin, a.personId, { categoryId: cats['Gehaltsabrechnungen'] }, { name: 'x.pdf', type: 'application/pdf', data: PDF });
    expect((await b.client.get(`/api/v1/persons/${a.personId}/documents`)).status).toBe(403);
    expect((await b.client.get(`/api/v1/documents/${doc.body.id}/download`)).status).toBe(403);
  });

  it('rejects disallowed or spoofed file types and oversized files', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Malte' });
    expect((await upload(admin, emp.personId, {}, { name: 'virus.exe', type: 'application/x-msdownload', data: Buffer.from('MZ\x90\x00') })).status).toBe(415);
    expect((await upload(admin, emp.personId, {}, { name: 'fake.pdf', type: 'application/pdf', data: Buffer.from('<html>not a pdf</html>') })).status).toBe(415);
    expect((await upload(admin, emp.personId, {})).status).toBe(422);
    const big = Buffer.alloc(26 * 1024 * 1024, 0x20);
    PDF.copy(big);
    expect((await upload(admin, emp.personId, {}, { name: 'big.pdf', type: 'application/pdf', data: big })).status).toBe(413);
  });

  it('lets employees upload their own documents (e.g. sick notes)', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Kranki' });
    const res = await upload(emp.client, emp.personId, { categoryId: cats['Bescheinigungen'], name: 'AU-Bescheinigung' }, { name: 'au.png', type: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]) });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('AU-Bescheinigung');
    expect(res.body.employeeVisible).toBe(true);
    const other = await createEmployee(app, admin, { firstName: 'Nope' });
    expect((await upload(emp.client, other.personId, {}, { name: 'a.pdf', type: 'application/pdf', data: PDF })).status).toBe(403);
  });

  it('deletes documents', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Del' });
    const doc = await upload(admin, emp.personId, {}, { name: 'tmp.pdf', type: 'application/pdf', data: Buffer.concat([PDF, Buffer.from('unique-del')]) });
    expect((await admin.delete(`/api/v1/documents/${doc.body.id}`)).status).toBe(204);
    expect((await admin.get(`/api/v1/documents/${doc.body.id}/download`)).status).toBe(404);
  });

  it('renders templates with placeholders and can store the result', async () => {
    const emp = await createEmployee(app, admin, { firstName: 'Tom', lastName: 'Template', startDate: '2026-02-01' });
    const tpl = await admin.post('/api/v1/document-templates', { name: 'Bestätigung', body: 'Hiermit bestätigen wir, dass {{person.firstName}} {{person.lastName}} seit {{employment.startDate}} als {{employment.positionTitle}} bei {{company.name}} beschäftigt ist. {{unknown.key}}' });
    expect(tpl.status).toBe(201);
    const r = await admin.post(`/api/v1/document-templates/${tpl.body.id}/render/${emp.personId}`, { save: true });
    expect(r.status).toBe(200);
    expect(r.body.content).toContain('Tom Template seit 2026-02-01 als Engineer bei Acme GmbH');
    expect(r.body.content).not.toContain('{{');
    expect(r.body.document.mime).toBe('text/markdown');
    const exp = await admin.get(`/api/v1/persons/${emp.personId}/export`);
    expect(exp.body.documents).toHaveLength(1);
  });
});
