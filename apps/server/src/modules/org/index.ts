import { asc, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { z, type ZodObject, type ZodRawShape } from 'zod';
import { REGIONS } from '@openpers/shared';
import { costCenters, legalEntities, orgUnits, workplaces } from '../../db/schema';
import { makeRoute, type RouteFn } from '../../lib/api';
import { audit, diff, type AppContext, type OpenPersModule } from '../../lib/context';
import { notFound, unprocessable } from '../../lib/errors';

const region = z.enum(REGIONS as [string, ...string[]]);

function crud<S extends ZodRawShape>(route: RouteFn, ctx: AppContext, path: string, entity: string, table: PgTable & { id: any; createdAt: any }, body: ZodObject<S>, order: any, validate?: (id: string | null, data: any) => Promise<void>) {
  const { db } = ctx;
  route({ method: 'GET', url: `/api/v1/${path}`, tag: 'org', summary: `List ${path}` }, async () => ({ items: await db.select().from(table as any).orderBy(asc(order)) }));
  route({ method: 'POST', url: `/api/v1/${path}`, perm: 'org.manage', tag: 'org', summary: `Create ${entity}`, body }, async ({ user, body: data }, reply) => {
    await validate?.(null, data);
    const [row] = await db.insert(table).values(data as any).returning();
    await audit(db, user.userId, entity, (row as any).id, 'create', data as Record<string, unknown>);
    reply.code(201);
    return row;
  });
  route({ method: 'PATCH', url: `/api/v1/${path}/:id`, perm: 'org.manage', tag: 'org', summary: `Update ${entity}`, body: body.partial() }, async ({ user, body: data, params }) => {
    const [before] = await db.select().from(table as any).where(eq(table.id, params.id));
    if (!before) throw notFound();
    await validate?.(params.id, data);
    const [row] = await db.update(table).set(data as any).where(eq(table.id, params.id)).returning();
    await audit(db, user.userId, entity, params.id, 'update', diff(before, data as Record<string, unknown>));
    return row;
  });
  route({ method: 'DELETE', url: `/api/v1/${path}/:id`, perm: 'org.manage', tag: 'org', summary: `Delete ${entity}` }, async ({ user, params }) => {
    const res = await db.delete(table).where(eq(table.id, params.id)).returning();
    if (!res.length) throw notFound();
    await audit(db, user.userId, entity, params.id, 'delete');
  });
}

export const orgModule: OpenPersModule = {
  name: 'org',
  register(app, ctx) {
    const route = makeRoute(app, ctx.registry);
    crud(route, ctx, 'legal-entities', 'legal_entity', legalEntities, z.object({ name: z.string().min(1).max(200), country: z.string().length(2).default('DE'), region, address: z.string().max(500).nullish() }), legalEntities.name);
    crud(route, ctx, 'workplaces', 'workplace', workplaces, z.object({ name: z.string().min(1).max(200), region, address: z.string().max(500).nullish() }), workplaces.name);
    crud(route, ctx, 'cost-centers', 'cost_center', costCenters, z.object({ code: z.string().min(1).max(50), name: z.string().min(1).max(200) }), costCenters.code);
    crud(
      route,
      ctx,
      'org-units',
      'org_unit',
      orgUnits,
      z.object({ name: z.string().min(1).max(200), type: z.enum(['department', 'team']).default('department'), parentId: z.string().uuid().nullish(), headPersonId: z.string().uuid().nullish() }),
      orgUnits.name,
      async (id, data) => {
        if (!id || !data.parentId) return;
        // Prevent cycles: the new parent must not be the unit itself or one of its descendants.
        const res = await ctx.db.execute(sql`
          WITH RECURSIVE sub(id) AS (SELECT ${id}::uuid UNION SELECT o.id FROM org_units o JOIN sub ON o.parent_id = sub.id)
          SELECT 1 FROM sub WHERE id = ${data.parentId}::uuid`);
        const rows = (res as any).rows ?? res;
        if (rows.length) throw unprocessable('Invalid parent', [{ path: 'parentId', message: 'Org unit cannot be nested inside itself' }]);
      },
    );
  },
};
