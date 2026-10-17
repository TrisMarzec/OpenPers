import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { userTokens } from '../src/db/schema';
import type { MailMessage, MailTransport } from '../src/lib/mailer';
import { client, createEmployee, createTestApp, setupCompany, type Client } from './helpers';

/** Collects mails instead of sending them; `fail` makes the next sends throw. */
function captureTransport() {
  const sent: MailMessage[] = [];
  const t: MailTransport & { sent: MailMessage[]; fail: number } = {
    kind: 'smtp',
    description: 'capture',
    sent,
    fail: 0,
    async send(m) {
      if (t.fail > 0) {
        t.fail--;
        throw new Error('SMTP down');
      }
      sent.push(m);
    },
  };
  return t;
}

const tokenFrom = (m: MailMessage, path: string) => m.text.match(new RegExp(`${path}/([A-Za-z0-9_-]{20,})`))?.[1];

describe('invitations, password reset and mail delivery', () => {
  let app: FastifyInstance;
  let admin: Client;
  let mail: ReturnType<typeof captureTransport>;
  const flush = () => (app as any).ctx.mailer.flush();
  const pub = () => client(app);

  beforeAll(async () => {
    mail = captureTransport();
    app = await createTestApp({ mailTransport: mail, appUrl: 'https://hr.example.com' });
    admin = await setupCompany(app);
  });
  afterAll(() => app.close());

  let invitedPersonId: string;
  let inviteToken: string;
  let invitedUserId: string;

  it('invites a person by e-mail instead of setting a password', async () => {
    const p = await admin.post('/api/v1/persons', { firstName: 'Ina', lastName: 'Neu', email: 'ina@example.com', employment: { startDate: '2026-01-01' } });
    invitedPersonId = p.body.id;
    const res = await admin.post('/api/v1/users', { email: 'ina@example.com', roles: ['employee'], personId: invitedPersonId, invite: true });
    expect(res.status).toBe(201);
    expect(res.body.invitation).toMatchObject({ status: 'pending' });
    expect(res.body.inviteUrl).toBeUndefined(); // mail is configured, the link is not handed out
    invitedUserId = res.body.id;
    await flush();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe('ina@example.com');
    expect(mail.sent[0].subject).toContain('Acme GmbH');
    expect(mail.sent[0].html).toContain('https://hr.example.com/invite/');
    inviteToken = tokenFrom(mail.sent[0], 'https://hr.example.com/invite')!;
    expect(inviteToken).toBeTruthy();
    // Without password and before accepting, the account cannot sign in.
    expect((await pub().post('/api/v1/auth/login', { email: 'ina@example.com', password: 'whatever-123456' })).status).toBe(401);
  });

  it('accepts the invitation with a self-chosen password and signs in', async () => {
    const info = await pub().get(`/api/v1/public/invitations/${inviteToken}`);
    expect(info.body).toMatchObject({ email: 'ina@example.com', firstName: 'Ina', company: 'Acme GmbH', kind: 'invite' });
    expect((await pub().post(`/api/v1/public/invitations/${inviteToken}/accept`, { password: 'kurz' })).status).toBe(422);
    const res = await app.inject({ method: 'POST', url: `/api/v1/public/invitations/${inviteToken}/accept`, payload: { password: 'ina-sicheres-passwort' }, headers: { 'x-requested-with': 'openpers' } });
    expect(res.statusCode).toBe(200);
    const cookie = String(res.headers['set-cookie']).split(';')[0];
    expect((await client(app, { cookie }).get('/api/v1/auth/me')).body.email).toBe('ina@example.com');
    expect((await pub().post(`/api/v1/public/invitations/${inviteToken}/accept`, { password: 'nochmal-passwort-1' })).status).toBe(410);
    expect((await pub().post('/api/v1/auth/login', { email: 'ina@example.com', password: 'ina-sicheres-passwort' })).status).toBe(200);
    const users = (await admin.get('/api/v1/users')).body.items;
    expect(users.find((u: any) => u.id === invitedUserId).invitation).toMatchObject({ status: 'accepted' });
  });

  it('resends invitations and rejects old or expired links', async () => {
    const emp = await admin.post('/api/v1/persons', { firstName: 'Otto', lastName: 'Offen', email: 'otto@example.com', employment: { startDate: '2026-01-01' } });
    const u = await admin.post('/api/v1/users', { email: 'otto@example.com', roles: ['employee'], personId: emp.body.id, invite: true });
    await flush();
    const first = tokenFrom(mail.sent.at(-1)!, 'https://hr.example.com/invite')!;
    expect((await admin.post(`/api/v1/users/${u.body.id}/invite`)).status).toBe(200);
    await flush();
    const second = tokenFrom(mail.sent.at(-1)!, 'https://hr.example.com/invite')!;
    expect(second).not.toBe(first);
    expect((await pub().get(`/api/v1/public/invitations/${first}`)).status).toBe(410);
    await (app as any).ctx.db.update(userTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(userTokens.userId, u.body.id));
    expect((await pub().get(`/api/v1/public/invitations/${second}`)).status).toBe(410);
    expect((await admin.get('/api/v1/users')).body.items.find((x: any) => x.id === u.body.id).invitation.status).toBe('expired');
    // Accepted accounts cannot be re-invited (they use "forgot password").
    expect((await admin.post(`/api/v1/users/${invitedUserId}/invite`)).status).toBe(409);
  });

  it('resets forgotten passwords without revealing whether an account exists', async () => {
    const before = mail.sent.length;
    expect((await pub().post('/api/v1/auth/password-reset', { email: 'niemand@example.com' })).status).toBe(204);
    expect((await pub().post('/api/v1/auth/password-reset', { email: 'ina@example.com' })).status).toBe(204);
    await flush();
    expect(mail.sent.length).toBe(before + 1);
    const token = tokenFrom(mail.sent.at(-1)!, 'https://hr.example.com/reset-password')!;
    const session = await client(app).post('/api/v1/auth/login', { email: 'ina@example.com', password: 'ina-sicheres-passwort' });
    expect(session.status).toBe(200);
    const res = await pub().post(`/api/v1/public/password-reset/${token}`, { password: 'ina-neues-passwort-2' });
    expect(res.status).toBe(200);
    expect((await pub().post('/api/v1/auth/login', { email: 'ina@example.com', password: 'ina-sicheres-passwort' })).status).toBe(401);
    expect((await pub().post('/api/v1/auth/login', { email: 'ina@example.com', password: 'ina-neues-passwort-2' })).status).toBe(200);
    expect((await pub().post(`/api/v1/public/password-reset/${token}`, { password: 'dritter-versuch-3' })).status).toBe(410);
  });

  it('retries failed deliveries and reports mail status to admins', async () => {
    mail.fail = 1;
    expect((await admin.post('/api/v1/mail/test', { to: 'admin@example.com' })).status).toBe(202);
    await flush();
    let log = (await admin.get('/api/v1/mail/log')).body.items;
    expect(log[0]).toMatchObject({ to: 'admin@example.com', status: 'pending', attempts: 1, lastError: 'SMTP down' });
    await (app as any).ctx.mailer.flush({ ignoreBackoff: true });
    log = (await admin.get('/api/v1/mail/log')).body.items;
    expect(log[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await admin.get('/api/v1/mail/status')).body).toMatchObject({ configured: true, transport: 'smtp' });
    const emp = await createEmployee(app, admin, { firstName: 'Neugier' });
    expect((await emp.client.get('/api/v1/mail/log')).status).toBe(403);
  });
});

describe('invitations without SMTP', () => {
  let app: FastifyInstance;
  let admin: Client;
  beforeAll(async () => {
    app = await createTestApp();
    admin = await setupCompany(app);
  });
  afterAll(() => app.close());

  it('hands the invitation link to the admin when no mail server is configured', async () => {
    expect((await admin.get('/api/v1/mail/status')).body).toMatchObject({ configured: false, transport: 'log' });
    const p = await admin.post('/api/v1/persons', { firstName: 'Lou', lastName: 'Link', email: 'lou@example.com', employment: { startDate: '2026-01-01' } });
    const res = await admin.post('/api/v1/users', { email: 'lou@example.com', roles: ['employee'], personId: p.body.id, invite: true });
    expect(res.status).toBe(201);
    expect(res.body.inviteUrl).toMatch(/\/invite\/[A-Za-z0-9_-]{20,}$/);
    expect((await admin.post('/api/v1/users', { email: 'x@example.com', roles: ['employee'] })).status).toBe(422);
  });
});
