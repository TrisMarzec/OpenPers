import { and, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ACCESS_LEVELS, BUILTIN_ROLES, DATA_CATEGORIES, PERMISSIONS, REGIONS, SCOPES, type DataCategory, type Scope } from '@openpers/shared';
import { apiTokens, auditLog, company, roleAssignments, roles, sessions, users, persons } from '../../db/schema';
import type { Exec } from '../../db';
import { decodeCursor, makeRoute, page, paginationQuery } from '../../lib/api';
import { audit, diff, type AppContext, type OpenPersModule } from '../../lib/context';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto';
import { conflict, forbidden, HttpError, notFound, unauthorized, unprocessable } from '../../lib/errors';
import { createPersonWithEmployment } from '../people/service';
import { loadPrincipal, resolveFieldAccess, SESSION_COOKIE, SESSION_DAYS } from './principal';
import { registerWebhookRoutes } from './webhooks';
import type { Principal } from '../../lib/authz';

const regionSchema = z.enum(REGIONS as [string, ...string[]]);
const roleRef = z.union([z.string(), z.object({ key: z.string(), scope: z.enum(SCOPES as [Scope, ...Scope[]]) })]);
const password = z.string().min(10, 'Password must have at least 10 characters').max(200);

/** Simple in-memory brute-force protection: max 10 failed logins per email per 15 minutes. */
const failedLogins = new Map<string, { count: number; until: number }>();
function checkRateLimit(email: string) {
  const entry = failedLogins.get(email);
  if (entry && entry.until > Date.now() && entry.count >= 10) throw new HttpError(429, 'Too many failed login attempts, try again later');
}
function recordFailure(email: string) {
  const entry = failedLogins.get(email);
  if (!entry || entry.until < Date.now()) failedLogins.set(email, { count: 1, until: Date.now() + 15 * 60_000 });
  else entry.count++;
}

export async function assignRoles(tx: Exec, userId: string, refs: z.infer<typeof roleRef>[]) {
  await tx.delete(roleAssignments).where(eq(roleAssignments.userId, userId));
  for (const ref of refs) {
    const key = typeof ref === 'string' ? ref : ref.key;
    const [role] = await tx.select().from(roles).where(eq(roles.key, key));
    if (!role) throw unprocessable('Unknown role', [{ path: 'roles', message: `Unknown role ${key}` }]);
    const scope = typeof ref === 'string' ? role.defaultScope : ref.scope;
    await tx.insert(roleAssignments).values({ userId, roleId: role.id, scope });
  }
}

async function userView(db: Exec, id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) throw notFound('User not found');
  const assigned = await db
    .select({ key: roles.key, name: roles.name, scope: roleAssignments.scope })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(eq(roleAssignments.userId, id));
  return { id: u.id, email: u.email, personId: u.personId, locale: u.locale, active: u.active, lastLoginAt: u.lastLoginAt, roles: assigned, createdAt: u.createdAt };
}

export function coreModule(modules: OpenPersModule[]): OpenPersModule {
  return {
    name: 'core',
    register(app, ctx: AppContext) {
      const { db } = ctx;
      const route = makeRoute(app, ctx.registry);
      registerWebhookRoutes(app, ctx);

      // ---------- Setup ----------
      route({ method: 'GET', url: '/api/v1/setup/status', auth: false, tag: 'setup', summary: 'Whether initial setup is required' }, async () => {
        const [{ n }] = await db.select({ n: count() }).from(company);
        return { needsSetup: n === 0 };
      });

      route(
        {
          method: 'POST',
          url: '/api/v1/setup',
          auth: false,
          tag: 'setup',
          summary: 'Initial setup: company and first administrator',
          body: z.object({
            companyName: z.string().trim().min(1).max(200),
            region: regionSchema,
            locale: z.enum(['de', 'en']).default('de'),
            admin: z.object({ email: z.string().trim().toLowerCase().email(), password, firstName: z.string().trim().min(1), lastName: z.string().trim().min(1) }),
          }),
        },
        async ({ body }, reply) => {
          await db.transaction(async (tx) => {
            await tx.execute(sql`LOCK TABLE company IN EXCLUSIVE MODE`);
            const [{ n }] = await tx.select({ n: count() }).from(company);
            if (n > 0) throw conflict('Setup has already been completed');
            await tx.insert(company).values({ name: body.companyName, region: body.region, locale: body.locale });
            for (const r of BUILTIN_ROLES) {
              await tx.insert(roles).values({ key: r.key, name: r.name, permissions: r.permissions, defaultScope: r.defaultScope, fieldAccess: r.fieldAccess, builtin: true });
            }
            const today = new Date().toISOString().slice(0, 10);
            const { personId } = await createPersonWithEmployment(
              tx,
              { firstName: body.admin.firstName, lastName: body.admin.lastName, email: body.admin.email, language: body.locale, employment: { startDate: today, positionTitle: 'Administrator' } },
              null,
            );
            const [user] = await tx.insert(users).values({ email: body.admin.email, passwordHash: await hashPassword(body.admin.password), locale: body.locale, personId }).returning();
            await assignRoles(tx, user.id, ['admin']);
            await audit(tx, user.id, 'company', 'setup', 'create', { name: body.companyName });
            for (const m of modules) await m.seed?.(tx, ctx, { region: body.region, adminUserId: user.id, adminPersonId: personId });
          });
          reply.code(201);
          return { ok: true };
        },
      );

      // ---------- Auth ----------
      route(
        { method: 'POST', url: '/api/v1/auth/login', auth: false, tag: 'auth', summary: 'Log in with email and password', body: z.object({ email: z.string().trim().toLowerCase(), password: z.string() }) },
        async ({ body }, reply) => {
          checkRateLimit(body.email);
          const [user] = await db.select().from(users).where(eq(users.email, body.email));
          if (!user || !user.active || !(await verifyPassword(user.passwordHash, body.password))) {
            recordFailure(body.email);
            throw unauthorized('Invalid email or password');
          }
          failedLogins.delete(body.email);
          const token = randomToken();
          const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
          await db.insert(sessions).values({ tokenHash: sha256(token), userId: user.id, expiresAt });
          await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
          reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure: ctx.config.secureCookies, expires: expiresAt });
          const principal = await loadPrincipal(db, user.id);
          return meView(principal!);
        },
      );

      route({ method: 'POST', url: '/api/v1/auth/logout', tag: 'auth', summary: 'Log out' }, async ({ raw }, reply) => {
        const cookie = raw.cookies[SESSION_COOKIE];
        if (cookie) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(cookie)));
        reply.clearCookie(SESSION_COOKIE, { path: '/' });
        reply.code(204);
      });

      async function meView(p: Principal) {
        const [person] = p.personId ? await db.select({ firstName: persons.firstName, lastName: persons.lastName, preferredName: persons.preferredName }).from(persons).where(eq(persons.id, p.personId)) : [];
        return { id: p.userId, email: p.email, personId: p.personId, locale: p.locale, permissions: p.permissions, person: person ?? null };
      }

      route({ method: 'GET', url: '/api/v1/auth/me', tag: 'auth', summary: 'Current user and permissions' }, ({ user }) => meView(user));

      route(
        { method: 'PATCH', url: '/api/v1/auth/me', tag: 'auth', summary: 'Update own preferences', body: z.object({ locale: z.enum(['de', 'en']).optional() }) },
        async ({ user, body }) => {
          if (body.locale) await db.update(users).set({ locale: body.locale }).where(eq(users.id, user.userId));
          return meView((await loadPrincipal(db, user.userId))!);
        },
      );

      route(
        { method: 'POST', url: '/api/v1/auth/password', tag: 'auth', summary: 'Change own password', body: z.object({ currentPassword: z.string(), newPassword: password }) },
        async ({ user, body }) => {
          const [u] = await db.select().from(users).where(eq(users.id, user.userId));
          if (!(await verifyPassword(u.passwordHash, body.currentPassword))) throw forbidden('Current password is wrong');
          await db.update(users).set({ passwordHash: await hashPassword(body.newPassword) }).where(eq(users.id, user.userId));
          await db.delete(sessions).where(eq(sessions.userId, user.userId));
          await audit(db, user.userId, 'user', user.userId, 'password_change');
        },
      );

      // ---------- Users ----------
      route({ method: 'GET', url: '/api/v1/users', perm: 'users.manage', tag: 'users', summary: 'List users' }, async () => {
        const list = await db.select({ id: users.id }).from(users).orderBy(users.email);
        return { items: await Promise.all(list.map((u) => userView(db, u.id))) };
      });

      route(
        {
          method: 'POST',
          url: '/api/v1/users',
          perm: 'users.manage',
          tag: 'users',
          summary: 'Create a user account',
          body: z.object({
            email: z.string().trim().toLowerCase().email(),
            password,
            roles: z.array(roleRef).min(1),
            personId: z.string().uuid().nullish(),
            locale: z.enum(['de', 'en']).default('de'),
          }),
        },
        async ({ user, body }, reply) => {
          const id = await db.transaction(async (tx) => {
            const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.email));
            if (dup) throw conflict('A user with this email already exists');
            if (body.personId) {
              const [linked] = await tx.select({ id: users.id }).from(users).where(eq(users.personId, body.personId));
              if (linked) throw conflict('This person already has a user account');
            }
            const [created] = await tx.insert(users).values({ email: body.email, passwordHash: await hashPassword(body.password), personId: body.personId ?? null, locale: body.locale }).returning();
            await assignRoles(tx, created.id, body.roles);
            await audit(tx, user.userId, 'user', created.id, 'create', { email: body.email, roles: body.roles });
            return created.id;
          });
          reply.code(201);
          return userView(db, id);
        },
      );

      route(
        {
          method: 'PATCH',
          url: '/api/v1/users/:id',
          perm: 'users.manage',
          tag: 'users',
          summary: 'Update a user account',
          body: z.object({ roles: z.array(roleRef).min(1).optional(), active: z.boolean().optional(), password: password.optional(), personId: z.string().uuid().nullish(), locale: z.enum(['de', 'en']).optional() }),
        },
        async ({ user, body, params }) => {
          await db.transaction(async (tx) => {
            const [u] = await tx.select().from(users).where(eq(users.id, params.id));
            if (!u) throw notFound('User not found');
            if (params.id === user.userId && body.active === false) throw forbidden('You cannot deactivate yourself');
            const patch: Partial<typeof users.$inferInsert> = {};
            if (body.active !== undefined) patch.active = body.active;
            if (body.locale) patch.locale = body.locale;
            if (body.personId !== undefined) patch.personId = body.personId;
            if (body.password) patch.passwordHash = await hashPassword(body.password);
            if (Object.keys(patch).length) await tx.update(users).set(patch).where(eq(users.id, params.id));
            if (body.roles) await assignRoles(tx, params.id, body.roles);
            if (body.active === false || body.password) await tx.delete(sessions).where(eq(sessions.userId, params.id));
            await audit(tx, user.userId, 'user', params.id, 'update', { ...diff(u, { active: body.active, locale: body.locale, personId: body.personId }), ...(body.roles ? { roles: body.roles } : {}), ...(body.password ? { password: 'changed' } : {}) });
          });
          return userView(db, params.id);
        },
      );

      // ---------- Roles ----------
      const level = z.enum(ACCESS_LEVELS);
      const fieldAccessBody = z.record(z.enum(DATA_CATEGORIES), z.object({ self: level, others: level }).partial());
      const roleBody = z.object({
        key: z.string().regex(/^[a-z0-9_-]{2,40}$/),
        name: z.string().min(1).max(100),
        permissions: z.array(z.enum(PERMISSIONS)).min(1),
        defaultScope: z.enum(SCOPES as [Scope, ...Scope[]]).default('self'),
        fieldAccess: fieldAccessBody.optional(),
      });
      const roleView = (r: typeof roles.$inferSelect) => ({ ...r, fieldAccess: resolveFieldAccess(r.key, r.fieldAccess) });
      const mergeAccess = (key: string, current: unknown, patch?: z.infer<typeof fieldAccessBody>) => {
        const base = resolveFieldAccess(key, current);
        if (!patch) return base;
        return Object.fromEntries(Object.entries(base).map(([c, v]) => [c, { ...v, ...(patch[c as DataCategory] ?? {}) }]));
      };
      route({ method: 'GET', url: '/api/v1/roles', perm: 'users.manage', tag: 'users', summary: 'List roles incl. access matrix for sensitive data' }, async () => ({ items: (await db.select().from(roles).orderBy(roles.name)).map(roleView) }));
      route({ method: 'POST', url: '/api/v1/roles', perm: 'users.manage', tag: 'users', summary: 'Create a custom role', body: roleBody }, async ({ user, body }, reply) => {
        const [dup] = await db.select().from(roles).where(eq(roles.key, body.key));
        if (dup) throw conflict('Role key already exists');
        const [r] = await db.insert(roles).values({ ...body, fieldAccess: mergeAccess(body.key, null, body.fieldAccess) }).returning();
        await audit(db, user.userId, 'role', r.id, 'create', body);
        reply.code(201);
        return roleView(r);
      });
      route(
        { method: 'PATCH', url: '/api/v1/roles/:id', perm: 'users.manage', tag: 'users', summary: 'Update a role (built-in roles: only the access matrix, not for admin)', body: roleBody.omit({ key: true }).partial() },
        async ({ user, body, params }) => {
          const [r] = await db.select().from(roles).where(eq(roles.id, params.id));
          if (!r) throw notFound();
          if (r.builtin) {
            const onlyAccess = Object.keys(body).every((k) => k === 'fieldAccess');
            if (!onlyAccess || r.key === 'admin') throw forbidden('Built-in roles: only the access matrix can be changed (not for admin)');
          }
          const { fieldAccess, ...rest } = body;
          const patch = { ...rest, ...(fieldAccess ? { fieldAccess: mergeAccess(r.key, r.fieldAccess, fieldAccess) } : {}) };
          const [u] = await db.update(roles).set(patch).where(eq(roles.id, params.id)).returning();
          await audit(db, user.userId, 'role', r.id, 'update', diff(r, patch));
          return roleView(u);
        },
      );
      route({ method: 'DELETE', url: '/api/v1/roles/:id', perm: 'users.manage', tag: 'users', summary: 'Delete a custom role' }, async ({ user, params }) => {
        const [r] = await db.select().from(roles).where(eq(roles.id, params.id));
        if (!r) throw notFound();
        if (r.builtin) throw forbidden('Built-in roles cannot be deleted');
        await db.delete(roles).where(eq(roles.id, params.id));
        await audit(db, user.userId, 'role', r.id, 'delete');
      });

      // ---------- API tokens ----------
      route({ method: 'GET', url: '/api/v1/api-tokens', tag: 'api-tokens', summary: 'List own API tokens' }, async ({ user }) => ({
        items: await db
          .select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, permissions: apiTokens.permissions, lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt })
          .from(apiTokens)
          .where(eq(apiTokens.userId, user.userId)),
      }));
      route(
        { method: 'POST', url: '/api/v1/api-tokens', tag: 'api-tokens', summary: 'Create an API token (shown once)', body: z.object({ name: z.string().min(1).max(100), permissions: z.array(z.enum(PERMISSIONS)).nullish() }) },
        async ({ user, body }, reply) => {
          if (user.tokenId) throw forbidden('API tokens cannot create API tokens');
          const token = randomToken('opk_');
          const [row] = await db.insert(apiTokens).values({ name: body.name, tokenHash: sha256(token), prefix: token.slice(0, 10), userId: user.userId, permissions: body.permissions ?? null }).returning();
          await audit(db, user.userId, 'api_token', row.id, 'create', { name: body.name });
          reply.code(201);
          return { id: row.id, name: row.name, token };
        },
      );
      route({ method: 'DELETE', url: '/api/v1/api-tokens/:id', tag: 'api-tokens', summary: 'Revoke an API token' }, async ({ user, params }) => {
        const res = await db.delete(apiTokens).where(and(eq(apiTokens.id, params.id), eq(apiTokens.userId, user.userId))).returning();
        if (!res.length) throw notFound();
        await audit(db, user.userId, 'api_token', params.id, 'delete');
      });

      // ---------- Company ----------
      route({ method: 'GET', url: '/api/v1/company', tag: 'company', summary: 'Company settings' }, async () => {
        const [c] = await db.select().from(company).limit(1);
        if (!c) throw notFound('Setup not completed');
        return c;
      });
      route(
        {
          method: 'PATCH',
          url: '/api/v1/company',
          perm: 'settings.manage',
          tag: 'company',
          summary: 'Update company settings',
          body: z.object({ name: z.string().min(1).max(200).optional(), region: regionSchema.optional(), locale: z.enum(['de', 'en']).optional(), timezone: z.string().optional(), settings: z.record(z.unknown()).optional() }),
        },
        async ({ user, body }) => {
          const [c] = await db.select().from(company).limit(1);
          const patch = { ...body, ...(body.settings ? { settings: { ...c.settings, ...body.settings } } : {}) };
          const [u] = await db.update(company).set(patch).where(eq(company.id, c.id)).returning();
          await audit(db, user.userId, 'company', c.id, 'update', diff(c, patch));
          return u;
        },
      );

      // ---------- Audit log ----------
      route(
        { method: 'GET', url: '/api/v1/audit-log', perm: 'settings.manage', tag: 'audit', summary: 'Audit log', query: paginationQuery.extend({ entity: z.string().optional(), entityId: z.string().optional() }) },
        async ({ query }) => {
          const offset = decodeCursor(query.cursor);
          const conds = [query.entity ? eq(auditLog.entity, query.entity) : undefined, query.entityId ? eq(auditLog.entityId, query.entityId) : undefined].filter(Boolean);
          const items = await db
            .select()
            .from(auditLog)
            .where(conds.length ? and(...(conds as any[])) : undefined)
            .orderBy(desc(auditLog.at))
            .limit(query.limit + 1)
            .offset(offset);
          return page(items, offset, query.limit);
        },
      );
    },
  };
}
