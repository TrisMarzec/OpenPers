import { and, eq, gt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { BUILTIN_ROLES, DEFAULT_FIELD_ACCESS, type FieldAccess, type Scope } from '@openpers/shared';
import type { DB } from '../../db';
import { apiTokens, roleAssignments, roles, sessions, users } from '../../db/schema';
import type { Principal } from '../../lib/authz';
import { sha256 } from '../../lib/crypto';
import { forbidden } from '../../lib/errors';

export const SESSION_COOKIE = 'op_session';
export const SESSION_DAYS = 30;

export async function loadPrincipal(db: DB, userId: string, tokenPermissions?: string[] | null, tokenId?: string): Promise<Principal | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || !user.active) return null;
  const assignments = await db
    .select({ key: roles.key, permissions: roles.permissions, fieldAccess: roles.fieldAccess, scope: roleAssignments.scope })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(eq(roleAssignments.userId, userId));
  const permissions: Record<string, Scope[]> = {};
  for (const a of assignments) {
    for (const p of a.permissions) {
      if (tokenPermissions && !tokenPermissions.includes(p)) continue;
      (permissions[p] ??= []);
      if (!permissions[p].includes(a.scope as Scope)) permissions[p].push(a.scope as Scope);
    }
  }
  const grants = assignments.map((a) => ({ scope: a.scope as Scope, fieldAccess: resolveFieldAccess(a.key, a.fieldAccess) }));
  return { userId: user.id, email: user.email, personId: user.personId, locale: user.locale, permissions, grants, tokenId, cache: new Map() };
}

/** Stored matrix, else the built-in default for the role key, else the default for custom roles. */
export function resolveFieldAccess(key: string, stored: unknown): FieldAccess {
  const base = BUILTIN_ROLES.find((r) => r.key === key)?.fieldAccess ?? DEFAULT_FIELD_ACCESS;
  if (!stored || typeof stored !== 'object') return base;
  return Object.fromEntries(Object.entries(base).map(([c, v]) => [c, { ...v, ...((stored as Record<string, object>)[c] ?? {}) }])) as FieldAccess;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Resolves `request.principal` from a session cookie or an API bearer token and enforces CSRF protection. */
export function registerAuthHook(app: FastifyInstance, db: DB) {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    request.principal = null;
    const auth = request.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      const [row] = await db.select().from(apiTokens).where(eq(apiTokens.tokenHash, sha256(token)));
      if (row) {
        request.principal = await loadPrincipal(db, row.userId, row.permissions, row.id);
        await db.update(apiTokens).set({ lastUsedAt: new Date() }).where(eq(apiTokens.id, row.id));
      }
      return;
    }
    const cookie = request.cookies?.[SESSION_COOKIE];
    if (!cookie) return;
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, sha256(cookie)), gt(sessions.expiresAt, new Date())));
    if (!session) return;
    if (!SAFE_METHODS.has(request.method) && request.headers['x-requested-with'] !== 'openpers') {
      throw forbidden('Missing CSRF header X-Requested-With: openpers');
    }
    request.principal = await loadPrincipal(db, session.userId);
  });
}
