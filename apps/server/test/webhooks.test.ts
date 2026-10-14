import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { webhookDeliveries } from '../src/db/schema';
import { runWorkerOnce } from '../src/lib/worker';
import { createTestApp, setupCompany, type Client } from './helpers';

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
}

describe('webhooks', () => {
  let app: FastifyInstance;
  let admin: Client;
  let server: Server;
  let url: string;
  const received: Received[] = [];
  let failNext = 0;

  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.statusCode = 500;
        }
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
    // Drain setup events so tests only see their own.
    await runWorkerOnce(app.ctx);
  });
  afterAll(async () => {
    server.close();
    await app.close();
  });

  const newPerson = (email: string) => admin.post('/api/v1/persons', { firstName: 'Web', lastName: 'Hook', email, employment: { startDate: '2026-01-01' } });

  it('delivers subscribed events with HMAC signature and auth token', async () => {
    const hook = await admin.post('/api/v1/webhooks', { url, events: ['person.created'], authType: 'TOKEN', token: 'Bearer s3cret' });
    expect(hook.status).toBe(201);
    expect(hook.body.secret).toMatch(/^whsec_/);
    expect((await admin.get('/api/v1/webhooks')).body.items[0]).not.toHaveProperty('secret');

    await newPerson('web1@example.com');
    received.length = 0;
    await runWorkerOnce(app.ctx);
    expect(received).toHaveLength(1);
    const r = received[0];
    const payload = JSON.parse(r.body);
    expect(payload.event).toBe('person.created');
    expect(payload.data.personId).toBeTruthy();
    expect(r.headers['x-openpers-event']).toBe('person.created');
    expect(r.headers.authorization).toBe('Bearer s3cret');
    const expected = 'sha256=' + createHmac('sha256', hook.body.secret).update(r.body).digest('hex');
    expect(r.headers['x-openpers-signature']).toBe(expected);
    await admin.delete(`/api/v1/webhooks/${hook.body.id}`);
  });

  it('retries failed deliveries with backoff', async () => {
    const hook = await admin.post('/api/v1/webhooks', { url, events: ['person.created'] });
    await newPerson('web2@example.com');
    failNext = 1;
    received.length = 0;
    await runWorkerOnce(app.ctx);
    expect(received).toHaveLength(1);
    let [d] = await app.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, hook.body.id));
    expect(d).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 500 });
    expect(d.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await runWorkerOnce(app.ctx);
    expect(received).toHaveLength(1);

    await app.ctx.db.update(webhookDeliveries).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(webhookDeliveries.id, d.id));
    await runWorkerOnce(app.ctx);
    [d] = await app.ctx.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, d.id));
    expect(d.status).toBe('delivered');
    const deliveries = await admin.get(`/api/v1/webhooks/${hook.body.id}/deliveries`);
    expect(deliveries.body.items[0].status).toBe('delivered');
    await admin.delete(`/api/v1/webhooks/${hook.body.id}`);
  });

  it('does not deliver unsubscribed or disabled webhooks', async () => {
    const hook = await admin.post('/api/v1/webhooks', { url, events: ['absence.approved'] });
    const disabled = await admin.post('/api/v1/webhooks', { url, events: ['*'], status: 'DISABLED' });
    await newPerson('web3@example.com');
    received.length = 0;
    await runWorkerOnce(app.ctx);
    expect(received).toHaveLength(0);
    await admin.delete(`/api/v1/webhooks/${hook.body.id}`);
    await admin.delete(`/api/v1/webhooks/${disabled.body.id}`);
  });

  it('validates custom headers and sends ping events', async () => {
    const bad = await admin.post('/api/v1/webhooks', { url, events: ['*'], authType: 'CUSTOM', customHeaders: { Host: 'evil' } });
    expect(bad.status).toBe(422);
    const hook = await admin.post('/api/v1/webhooks', { url, events: ['*'], authType: 'CUSTOM', customHeaders: { 'X-Api-Key': 'k1' } });
    expect(hook.status).toBe(201);
    received.length = 0;
    expect((await admin.post(`/api/v1/webhooks/${hook.body.id}/ping`)).status).toBe(202);
    await runWorkerOnce(app.ctx);
    expect(received.map((r) => JSON.parse(r.body).event)).toEqual(['ping']);
    expect(received[0].headers['x-api-key']).toBe('k1');
    const rotated = await admin.post(`/api/v1/webhooks/${hook.body.id}/rotate-secret`);
    expect(rotated.body.secret).toMatch(/^whsec_/);
  });

  it('lists the available events', async () => {
    const res = await admin.get('/api/v1/webhook-events');
    expect(res.body.items).toEqual(expect.arrayContaining(['person.created', 'absence.approved', 'candidate.hired']));
  });
});
