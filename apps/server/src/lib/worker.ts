import { and, asc, eq, inArray, isNull, lte } from 'drizzle-orm';
import type { DB } from '../db';
import { outbox, webhookDeliveries, webhooks } from '../db/schema';
import type { AppContext } from './context';
import { hmacSha256 } from './crypto';

export const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const TIMEOUT_MS = 10_000;

/** Fans out new outbox events into webhook deliveries. */
export async function dispatchOutbox(db: DB): Promise<number> {
  const events = await db.select().from(outbox).where(isNull(outbox.processedAt)).orderBy(asc(outbox.createdAt)).limit(200);
  if (!events.length) return 0;
  const hooks = await db.select().from(webhooks).where(eq(webhooks.status, 'ENABLED'));
  await db.transaction(async (tx) => {
    for (const e of events) {
      for (const h of hooks) {
        if (h.events.includes('*') || h.events.includes(e.event)) {
          await tx.insert(webhookDeliveries).values({ webhookId: h.id, outboxId: e.id, event: e.event });
        }
      }
    }
    await tx.update(outbox).set({ processedAt: new Date() }).where(inArray(outbox.id, events.map((e) => e.id)));
  });
  return events.length;
}

/** Sends due deliveries; failed ones are retried with exponential backoff. */
export async function deliverDue(db: DB): Promise<number> {
  const due = await db
    .select({ d: webhookDeliveries, h: webhooks, e: outbox })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .innerJoin(outbox, eq(outbox.id, webhookDeliveries.outboxId))
    .where(and(eq(webhookDeliveries.status, 'pending'), lte(webhookDeliveries.nextAttemptAt, new Date())))
    .orderBy(asc(webhookDeliveries.createdAt))
    .limit(50);
  for (const { d, h, e } of due) {
    const body = JSON.stringify({ id: d.id, event: e.event, createdAt: e.createdAt, data: e.payload });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'OpenPers-Webhooks/1.0',
      'x-openpers-event': e.event,
      'x-openpers-delivery': d.id,
      'x-openpers-signature': `sha256=${hmacSha256(h.secret, body)}`,
    };
    if (h.authType === 'TOKEN' && h.token) headers.authorization = h.token;
    if (h.authType === 'CUSTOM' && h.customHeaders) for (const [k, v] of Object.entries(h.customHeaders)) headers[k.toLowerCase()] = v;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const res = await fetch(h.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      error = (err as Error).message;
    }
    const attempts = d.attempts + 1;
    const ok = status !== null && status >= 200 && status < 300;
    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        responseStatus: status,
        lastError: ok ? null : (error ?? `HTTP ${status}`),
        status: ok ? 'delivered' : attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        nextAttemptAt: ok ? d.nextAttemptAt : new Date(Date.now() + BASE_BACKOFF_MS * 2 ** (attempts - 1)),
      })
      .where(eq(webhookDeliveries.id, d.id));
  }
  return due.length;
}

/** Hooks for periodic maintenance jobs registered by modules (e.g. DSGVO retention). */
export type MaintenanceJob = (ctx: AppContext) => Promise<void>;
export const maintenanceJobs: MaintenanceJob[] = [];

export async function runWorkerOnce(ctx: AppContext): Promise<void> {
  await dispatchOutbox(ctx.db);
  await deliverDue(ctx.db);
}

export function startWorker(ctx: AppContext, log: { error: (o: unknown, msg?: string) => void }): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runWorkerOnce(ctx);
    } catch (err) {
      log.error(err, 'webhook worker failed');
    } finally {
      running = false;
    }
  };
  const maintenance = async () => {
    for (const job of maintenanceJobs) {
      try {
        await job(ctx);
      } catch (err) {
        log.error(err, 'maintenance job failed');
      }
    }
  };
  const t1 = setInterval(tick, 5_000);
  const t2 = setInterval(maintenance, 60 * 60_000);
  setTimeout(maintenance, 10_000).unref();
  t1.unref();
  t2.unref();
  return () => {
    clearInterval(t1);
    clearInterval(t2);
  };
}
