import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { outbox, webhookDeliveries, webhooks } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import { audit, type AppContext } from '../../lib/context';
import { randomToken } from '../../lib/crypto';
import { notFound } from '../../lib/errors';

export const WEBHOOK_EVENTS = [
  'person.created',
  'person.updated',
  'person.anonymized',
  'employment.created',
  'employment.updated',
  'absence.requested',
  'absence.approved',
  'absence.rejected',
  'absence.cancelled',
  'absence.updated',
  'attendance.created',
  'attendance.updated',
  'document.created',
  'document.deleted',
  'application.created',
  'application.stage_changed',
  'candidate.hired',
  'compensation.created',
] as const;

const FORBIDDEN_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade', 'te', 'trailer', 'expect', 'content-type', 'x-openpers-'];

const headersSchema = z
  .record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(1000))
  .refine((h) => Object.keys(h).length <= 3, 'At most 3 custom headers')
  .refine((h) => Object.keys(h).every((k) => !FORBIDDEN_HEADERS.some((f) => k.toLowerCase().startsWith(f))), 'Header name not allowed');

const hookBody = z.object({
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'Must be an http(s) URL'),
  description: z.string().max(500).nullish(),
  status: z.enum(['ENABLED', 'DISABLED']).default('ENABLED'),
  events: z.array(z.enum(['*', ...WEBHOOK_EVENTS])).min(1),
  authType: z.enum(['NONE', 'TOKEN', 'CUSTOM']).default('NONE'),
  token: z.string().max(1000).nullish(),
  customHeaders: headersSchema.nullish(),
});

const publicView = ({ secret: _s, token, ...h }: typeof webhooks.$inferSelect) => ({ ...h, hasToken: !!token });

export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const route = makeRoute(app, ctx.registry);

  route({ method: 'GET', url: '/api/v1/webhook-events', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Available webhook events' }, async () => ({ items: [...WEBHOOK_EVENTS] }));
  route({ method: 'GET', url: '/api/v1/webhooks', perm: 'webhooks.manage', tag: 'webhooks', summary: 'List webhooks' }, async () => ({ items: (await db.select().from(webhooks).orderBy(desc(webhooks.createdAt))).map(publicView) }));
  route({ method: 'POST', url: '/api/v1/webhooks', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Create webhook (signing secret is returned once)', body: hookBody }, async ({ user, body }, reply) => {
    const secret = randomToken('whsec_');
    const [h] = await db.insert(webhooks).values({ ...body, description: body.description ?? null, token: body.token ?? null, customHeaders: body.customHeaders ?? null, secret }).returning();
    await audit(db, user.userId, 'webhook', h.id, 'create', { url: h.url, events: h.events });
    reply.code(201);
    return { ...publicView(h), secret };
  });
  route({ method: 'PATCH', url: '/api/v1/webhooks/:id', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Update webhook', body: hookBody.partial() }, async ({ user, body, params }) => {
    const [h] = await db.update(webhooks).set(body).where(eq(webhooks.id, params.id)).returning();
    if (!h) throw notFound();
    await audit(db, user.userId, 'webhook', h.id, 'update', { ...body, token: body.token ? '***' : undefined });
    return publicView(h);
  });
  route({ method: 'DELETE', url: '/api/v1/webhooks/:id', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Delete webhook' }, async ({ user, params }) => {
    const res = await db.delete(webhooks).where(eq(webhooks.id, params.id)).returning();
    if (!res.length) throw notFound();
    await audit(db, user.userId, 'webhook', params.id, 'delete');
  });
  route({ method: 'GET', url: '/api/v1/webhooks/:id/deliveries', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Recent deliveries' }, async ({ params }) => ({
    items: await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.webhookId, params.id)).orderBy(desc(webhookDeliveries.createdAt)).limit(100),
  }));
  route({ method: 'POST', url: '/api/v1/webhooks/:id/ping', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Send a ping event' }, async ({ params }, reply) => {
    const [h] = await db.select().from(webhooks).where(eq(webhooks.id, params.id));
    if (!h) throw notFound();
    await db.transaction(async (tx) => {
      const [e] = await tx.insert(outbox).values({ event: 'ping', payload: { webhookId: h.id }, processedAt: new Date() }).returning();
      await tx.insert(webhookDeliveries).values({ webhookId: h.id, outboxId: e.id, event: 'ping' });
    });
    reply.code(202);
    return { ok: true };
  });
  route({ method: 'POST', url: '/api/v1/webhooks/:id/redeliver/:deliveryId', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Retry a delivery' }, async ({ params }) => {
    const [d] = await db.update(webhookDeliveries).set({ status: 'pending', nextAttemptAt: new Date(), attempts: 0 }).where(eq(webhookDeliveries.id, params.deliveryId)).returning();
    if (!d) throw notFound();
    return d;
  });
  route({ method: 'POST', url: '/api/v1/webhooks/:id/rotate-secret', perm: 'webhooks.manage', tag: 'webhooks', summary: 'Rotate signing secret (returned once)' }, async ({ user, params }) => {
    const secret = randomToken('whsec_');
    const [h] = await db.update(webhooks).set({ secret }).where(eq(webhooks.id, params.id)).returning();
    if (!h) throw notFound();
    await audit(db, user.userId, 'webhook', h.id, 'rotate_secret');
    return { id: h.id, secret };
  });
}
