import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { atLeast } from '@openpers/shared';
import type { Exec } from '../../db';
import { compensations, persons } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import type { Principal } from '../../lib/authz';
import { audit, emit, type AppContext } from '../../lib/context';
import { forbidden, notFound } from '../../lib/errors';
import { isoDateSchema } from './service';

const compensationBody = z
  .object({
    type: z.enum(['FIXED_SALARY', 'HOURLY_SALARY', 'ONE_TIME', 'RECURRING']),
    amount: z.number().positive().max(100_000_000).multipleOf(0.01),
    currency: z.string().regex(/^[A-Z]{3}$/).default('EUR'),
    interval: z.enum(['MONTHLY', 'YEARLY']).nullish(),
    validFrom: isoDateSchema,
    comment: z.string().max(1000).nullish(),
  })
  // As in common payroll APIs: every type except one-time payments needs a payout interval.
  .refine((c) => c.type === 'ONE_TIME' || c.type === 'HOURLY_SALARY' || !!c.interval, { path: ['interval'], message: 'Interval is required for this type' });

/** Salary and payments: a data category of its own (`compensation`), amounts stored encrypted. */
export function registerCompensationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, authz, cipher } = ctx;
  const route = makeRoute(app, ctx.registry);

  const view = (r: typeof compensations.$inferSelect) => {
    const { amountEnc, ...rest } = r;
    return { ...rest, amount: cipher.decrypt(amountEnc) as number };
  };

  async function level(user: Principal, personId: string) {
    const [p] = await db.select({ id: persons.id }).from(persons).where(eq(persons.id, personId));
    if (!p) throw notFound('Person not found');
    return (await authz.categoryAccess(user, personId)).compensation;
  }

  ctx.exporters.compensations = async (x: Exec, personId: string) => (await x.select().from(compensations).where(eq(compensations.personId, personId))).map(view);

  route({ method: 'GET', url: '/api/v1/persons/:id/compensations', tag: 'people', summary: 'Compensation history (requires view on compensation)' }, async ({ user, params }) => {
    if (!atLeast(await level(user, params.id), 'view')) throw forbidden('No access to compensation data');
    const rows = await db.select().from(compensations).where(eq(compensations.personId, params.id)).orderBy(desc(compensations.validFrom), desc(compensations.createdAt));
    if (user.personId !== params.id) await audit(db, user.userId, 'person', params.id, 'read_sensitive', { categories: ['compensation'] });
    return { items: rows.map(view) };
  });

  route({ method: 'POST', url: '/api/v1/persons/:id/compensations', tag: 'people', summary: 'Add a compensation (requires edit on compensation)', body: compensationBody }, async ({ user, params, body }, reply) => {
    if (!atLeast(await level(user, params.id), 'edit')) throw forbidden('No edit access to compensation data');
    const [row] = await db.transaction(async (tx) => {
      const r = await tx
        .insert(compensations)
        .values({ personId: params.id, type: body.type, amountEnc: cipher.encrypt(body.amount), currency: body.currency, interval: body.type === 'ONE_TIME' ? null : (body.interval ?? null), validFrom: body.validFrom, comment: body.comment ?? null, createdByUserId: user.userId })
        .returning();
      // The amount is deliberately not written to the audit log.
      await audit(tx, user.userId, 'person', params.id, 'compensation_add', { type: body.type, validFrom: body.validFrom });
      await emit(tx, 'compensation.created', { personId: params.id, compensationId: r[0].id });
      return r;
    });
    reply.code(201);
    return view(row);
  });

  route({ method: 'DELETE', url: '/api/v1/persons/:id/compensations/:cid', tag: 'people', summary: 'Remove a compensation entry' }, async ({ user, params }) => {
    if (!atLeast(await level(user, params.id), 'edit')) throw forbidden('No edit access to compensation data');
    const res = await db.delete(compensations).where(and(eq(compensations.id, params.cid), eq(compensations.personId, params.id))).returning();
    if (!res.length) throw notFound();
    await audit(db, user.userId, 'person', params.id, 'compensation_delete', { compensationId: params.cid });
  });
}
