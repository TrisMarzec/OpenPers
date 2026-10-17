import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Exec } from '../../db';
import { company, emails, persons, sessions, userTokens, users } from '../../db/schema';
import { makeRoute } from '../../lib/api';
import { audit, type AppContext } from '../../lib/context';
import { hashPassword, randomToken, sha256 } from '../../lib/crypto';
import { conflict, HttpError, notFound } from '../../lib/errors';
import { inviteMail, resetMail, testMail } from '../../lib/mail-templates';
import { SESSION_COOKIE, SESSION_DAYS } from './principal';

const INVITE_DAYS = 7;
const RESET_MINUTES = 60;
/** Per address: at most this many reset mails per hour (against mail bombing). */
const RESET_LIMIT = 3;
const resetRequests = new Map<string, number[]>();

export const passwordSchema = z.string().min(10, 'Password must have at least 10 characters').max(200);
const gone = () => new HttpError(410, 'This link is no longer valid. Ask for a new one.');

/** Creates a session cookie for the user (login, accepted invitation, password reset). */
export async function startSession(db: Exec, reply: FastifyReply, userId: string, secure: boolean) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ tokenHash: sha256(token), userId, expiresAt });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
  reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, expires: expiresAt });
}

export type InvitationStatus = { status: 'pending' | 'expired' | 'accepted'; sentAt: Date } | null;

/** Invitation state of an account: null when it was created with a password and never invited. */
export async function invitationOf(db: Exec, userId: string): Promise<InvitationStatus> {
  const [t] = await db.select().from(userTokens).where(and(eq(userTokens.userId, userId), eq(userTokens.kind, 'invite'))).orderBy(desc(userTokens.createdAt)).limit(1);
  if (!t) return null;
  return { status: t.usedAt ? 'accepted' : t.expiresAt < new Date() ? 'expired' : 'pending', sentAt: t.createdAt };
}

async function companyName(db: Exec) {
  const [c] = await db.select({ name: company.name }).from(company).limit(1);
  return c?.name ?? 'OpenPers';
}

async function personOf(db: Exec, personId: string | null) {
  if (!personId) return null;
  const [p] = await db.select({ firstName: persons.firstName, lastName: persons.lastName }).from(persons).where(eq(persons.id, personId));
  return p ?? null;
}

/**
 * Issues a fresh invitation (older open ones stop working) and queues the mail.
 * Returns the link so admins can pass it on themselves when no mail server is configured.
 */
export async function issueInvite(tx: Exec, ctx: AppContext, userId: string, actorUserId: string): Promise<string> {
  const [u] = await tx.select().from(users).where(eq(users.id, userId));
  if (!u) throw notFound('User not found');
  // Superseded invitations expire (marking them used would read as "accepted").
  await tx.update(userTokens).set({ expiresAt: new Date(0) }).where(and(eq(userTokens.userId, userId), eq(userTokens.kind, 'invite'), isNull(userTokens.usedAt)));
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 86_400_000);
  await tx.insert(userTokens).values({ userId, kind: 'invite', tokenHash: sha256(token), expiresAt, createdByUserId: actorUserId });
  const url = `${ctx.config.appUrl.replace(/\/$/, '')}/invite/${token}`;
  const [actor] = await tx.select({ personId: users.personId, email: users.email }).from(users).where(eq(users.id, actorUserId));
  const inviter = await personOf(tx, actor?.personId ?? null);
  const person = await personOf(tx, u.personId);
  await ctx.mailer.enqueue(
    tx,
    'invite',
    inviteMail({ locale: u.locale === 'en' ? 'en' : 'de', to: u.email, firstName: person?.firstName ?? null, company: await companyName(tx), inviter: inviter ? `${inviter.firstName} ${inviter.lastName}` : null, url, expiresAt }),
  );
  await audit(tx, actorUserId, 'user', userId, 'invite_sent', { email: u.email });
  return url;
}

export function registerInvitationRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const route = makeRoute(app, ctx.registry);

  async function loadToken(token: string, kind: 'invite' | 'reset') {
    const [t] = await db.select().from(userTokens).where(eq(userTokens.tokenHash, sha256(token)));
    if (!t || t.kind !== kind) throw notFound('Unknown link');
    if (t.usedAt || t.expiresAt < new Date()) throw gone();
    const [u] = await db.select().from(users).where(eq(users.id, t.userId));
    if (!u || !u.active) throw gone();
    return { t, u };
  }

  /** Sets the password, consumes the link and signs the user in; ends all other sessions. */
  async function redeem(token: string, kind: 'invite' | 'reset', password: string, reply: FastifyReply) {
    const { t, u } = await loadToken(token, kind);
    await db.transaction(async (tx) => {
      const [consumed] = await tx.update(userTokens).set({ usedAt: new Date() }).where(and(eq(userTokens.id, t.id), isNull(userTokens.usedAt))).returning();
      if (!consumed) throw gone(); // used concurrently
      await tx.update(users).set({ passwordHash: await hashPassword(password) }).where(eq(users.id, u.id));
      await tx.delete(sessions).where(eq(sessions.userId, u.id));
      await audit(tx, u.id, 'user', u.id, kind === 'invite' ? 'invite_accepted' : 'password_reset');
    });
    await startSession(db, reply, u.id, ctx.config.secureCookies);
    return { ok: true };
  }

  route({ method: 'POST', url: '/api/v1/users/:id/invite', perm: 'users.manage', tag: 'users', summary: 'Send (or resend) the invitation e-mail' }, async ({ user, params }) => {
    const inv = await invitationOf(db, params.id);
    const [u] = await db.select().from(users).where(eq(users.id, params.id));
    if (!u) throw notFound('User not found');
    if (inv?.status === 'accepted' || (!inv && u.passwordHash)) throw conflict('This account is already active – use "forgot password" instead');
    const url = await db.transaction((tx) => issueInvite(tx, ctx, params.id, user.userId));
    ctx.mailer.kick();
    return { invitation: await invitationOf(db, params.id), ...(ctx.mailer.transport.kind === 'log' ? { inviteUrl: url } : {}) };
  });

  route({ method: 'GET', url: '/api/v1/public/invitations/:token', auth: false, tag: 'auth', summary: 'Who an invitation is for (to greet the person)' }, async ({ params }) => {
    const { t, u } = await loadToken(params.token, 'invite');
    const p = await personOf(db, u.personId);
    return { kind: 'invite', email: u.email, firstName: p?.firstName ?? null, company: await companyName(db), expiresAt: t.expiresAt, locale: u.locale };
  });

  route(
    { method: 'POST', url: '/api/v1/public/invitations/:token/accept', auth: false, tag: 'auth', summary: 'Accept an invitation: choose a password and sign in', body: z.object({ password: passwordSchema }) },
    async ({ params, body }, reply) => redeem(params.token, 'invite', body.password, reply),
  );

  route(
    { method: 'POST', url: '/api/v1/auth/password-reset', auth: false, tag: 'auth', summary: 'Request a password reset link (always 204, so it does not reveal which addresses exist)', body: z.object({ email: z.string().trim().toLowerCase().max(320) }) },
    async ({ body }, reply) => {
      const now = Date.now();
      const recent = (resetRequests.get(body.email) ?? []).filter((ts) => now - ts < 3_600_000);
      if (recent.length < RESET_LIMIT) {
        resetRequests.set(body.email, [...recent, now]);
        const [u] = await db.select().from(users).where(eq(users.email, body.email));
        // Only active accounts that already have a password; invited people use their invitation.
        if (u?.active && u.passwordHash) {
          await db.transaction(async (tx) => {
            await tx.update(userTokens).set({ expiresAt: new Date(0) }).where(and(eq(userTokens.userId, u.id), eq(userTokens.kind, 'reset'), isNull(userTokens.usedAt)));
            const token = randomToken();
            await tx.insert(userTokens).values({ userId: u.id, kind: 'reset', tokenHash: sha256(token), expiresAt: new Date(now + RESET_MINUTES * 60_000) });
            const p = await personOf(tx, u.personId);
            const url = `${ctx.config.appUrl.replace(/\/$/, '')}/reset-password/${token}`;
            await ctx.mailer.enqueue(tx, 'reset', resetMail({ locale: u.locale === 'en' ? 'en' : 'de', to: u.email, firstName: p?.firstName ?? null, company: await companyName(tx), url }));
            await audit(tx, null, 'user', u.id, 'password_reset_requested');
          });
          ctx.mailer.kick();
        }
      }
      reply.code(204);
    },
  );

  route({ method: 'GET', url: '/api/v1/public/password-reset/:token', auth: false, tag: 'auth', summary: 'Check a password reset link' }, async ({ params }) => {
    const { t, u } = await loadToken(params.token, 'reset');
    return { kind: 'reset', email: u.email, company: await companyName(db), expiresAt: t.expiresAt, locale: u.locale };
  });

  route(
    { method: 'POST', url: '/api/v1/public/password-reset/:token', auth: false, tag: 'auth', summary: 'Set a new password with a reset link and sign in', body: z.object({ password: passwordSchema }) },
    async ({ params, body }, reply) => redeem(params.token, 'reset', body.password, reply),
  );

  // ---------- Mail administration ----------
  route({ method: 'GET', url: '/api/v1/mail/status', perm: 'settings.manage', tag: 'mail', summary: 'Mail delivery configuration' }, async () => ({
    configured: ctx.mailer.transport.kind === 'smtp',
    transport: ctx.mailer.transport.kind,
    server: ctx.mailer.transport.description,
    from: ctx.config.smtp?.from ?? null,
  }));

  route({ method: 'POST', url: '/api/v1/mail/test', perm: 'settings.manage', tag: 'mail', summary: 'Queue a test e-mail', body: z.object({ to: z.string().trim().email() }) }, async ({ user, body }, reply) => {
    const [me] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, user.userId));
    await ctx.mailer.enqueue(db, 'test', testMail({ locale: me?.locale === 'en' ? 'en' : 'de', to: body.to, company: await companyName(db), url: ctx.config.appUrl }));
    ctx.mailer.kick();
    reply.code(202);
    return { queued: true };
  });

  route({ method: 'GET', url: '/api/v1/mail/log', perm: 'settings.manage', tag: 'mail', summary: 'Recently queued e-mails (without content)' }, async () => ({
    items: await db
      .select({ id: emails.id, to: emails.to, subject: emails.subject, kind: emails.kind, status: emails.status, attempts: emails.attempts, lastError: emails.lastError, createdAt: emails.createdAt, sentAt: emails.sentAt })
      .from(emails)
      .orderBy(desc(emails.createdAt))
      .limit(50),
  }));

  route({ method: 'POST', url: '/api/v1/mail/retry', perm: 'settings.manage', tag: 'mail', summary: 'Retry pending and failed e-mails now' }, async () => {
    await db.update(emails).set({ status: 'pending', nextAttemptAt: new Date() }).where(eq(emails.status, 'failed'));
    return { sent: await ctx.mailer.flush({ ignoreBackoff: true }) };
  });
}
