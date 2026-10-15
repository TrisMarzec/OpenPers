import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createEmployee, createTestApp, multipart, setupCompany, type Client } from './helpers';

// Smallest valid PNG / JPEG headers are enough: the server sniffs the signature, it does not decode.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');

describe('profile photos and company logo', () => {
  let app: FastifyInstance;
  let admin: Client;
  let mia: Awaited<ReturnType<typeof createEmployee>>;
  let noah: Awaited<ReturnType<typeof createEmployee>>;

  const put = async (c: Client | null, url: string, file: { name: string; type: string; data: Buffer }) => {
    const mp = multipart({}, file);
    const res = await app.inject({ method: 'PUT', url, payload: mp.payload, headers: { 'content-type': mp.contentType, 'x-requested-with': 'openpers', ...(c ? { cookie: c.cookie! } : {}) } });
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  };

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    mia = await createEmployee(app, admin, { firstName: 'Mia' });
    noah = await createEmployee(app, admin, { firstName: 'Noah' });
  });
  afterAll(() => app.close());

  it('lets employees upload their own photo and shows it to colleagues', async () => {
    const res = await put(mia.client, `/api/v1/persons/${mia.personId}/photo`, { name: 'me.png', type: 'image/png', data: PNG });
    expect(res.status).toBe(200);
    expect(res.body.photoUrl).toMatch(new RegExp(`^/api/v1/persons/${mia.personId}/photo\\?v=\\d+$`));
    const detail = await admin.get(`/api/v1/persons/${mia.personId}`);
    expect(detail.body.photoUrl).toBe(res.body.photoUrl);
    expect(detail.body.photoKey).toBeUndefined();
    // Colleagues see photos through the company directory.
    const dir = await noah.client.get('/api/v1/directory');
    expect(dir.body.items.find((p: any) => p.id === mia.personId).photoUrl).toBe(res.body.photoUrl);
    const img = await app.inject({ method: 'GET', url: res.body.photoUrl, headers: { cookie: noah.client.cookie! } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['x-content-type-options']).toBe('nosniff');
    expect(img.rawPayload.equals(PNG)).toBe(true);
    const me = await mia.client.get('/api/v1/auth/me');
    expect(me.body.person.photoUrl).toBe(res.body.photoUrl);
    const list = await admin.get('/api/v1/persons');
    expect(list.body.items.find((p: any) => p.id === mia.personId).photoUrl).toBe(res.body.photoUrl);
  });

  it('rejects foreign photos, spoofed types, SVG and anonymous access', async () => {
    expect((await put(noah.client, `/api/v1/persons/${mia.personId}/photo`, { name: 'x.png', type: 'image/png', data: PNG })).status).toBe(403);
    expect((await put(mia.client, `/api/v1/persons/${mia.personId}/photo`, { name: 'x.png', type: 'image/png', data: Buffer.from('<html>not an image</html>') })).status).toBe(415);
    expect((await put(mia.client, `/api/v1/persons/${mia.personId}/photo`, { name: 'x.svg', type: 'image/svg+xml', data: SVG })).status).toBe(415);
    expect((await put(mia.client, `/api/v1/persons/${mia.personId}/photo`, { name: 'big.jpg', type: 'image/jpeg', data: Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]) })).status).toBe(413);
    expect((await app.inject({ method: 'GET', url: `/api/v1/persons/${mia.personId}/photo` })).statusCode).toBe(401);
  });

  it('lets HR replace and remove photos; 404 without a photo', async () => {
    expect((await put(admin, `/api/v1/persons/${noah.personId}/photo`, { name: 'n.jpg', type: 'image/jpeg', data: JPEG })).status).toBe(200);
    expect((await admin.delete(`/api/v1/persons/${noah.personId}/photo`)).status).toBe(204);
    expect((await admin.get(`/api/v1/persons/${noah.personId}`)).body.photoUrl).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/api/v1/persons/${noah.personId}/photo`, headers: { cookie: admin.cookie! } })).statusCode).toBe(404);
  });

  it('serves the company logo publicly, including inert SVG', async () => {
    expect((await put(mia.client, '/api/v1/company/logo', { name: 'l.png', type: 'image/png', data: PNG })).status).toBe(403);
    const res = await put(admin, '/api/v1/company/logo', { name: 'logo.svg', type: 'image/svg+xml', data: SVG });
    expect(res.status).toBe(200);
    expect(res.body.logoUrl).toMatch(/^\/api\/v1\/public\/logo\?v=\d+$/);
    const pub = await app.inject({ method: 'GET', url: res.body.logoUrl });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/svg+xml');
    expect(pub.headers['content-security-policy']).toContain('sandbox');
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/company' })).json()).toMatchObject({ logoUrl: res.body.logoUrl });
    expect((await admin.get('/api/v1/company')).body.logoUrl).toBe(res.body.logoUrl);
    expect((await admin.delete('/api/v1/company/logo')).status).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/public/logo' })).statusCode).toBe(404);
  });
});
