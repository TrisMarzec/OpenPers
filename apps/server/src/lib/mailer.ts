import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { DB, Exec } from '../db';
import { emails } from '../db/schema';
import type { SmtpConfig } from '../config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailTransport {
  /** `log`: no mail server configured – mails are recorded as skipped, nothing leaves the server. */
  kind: 'smtp' | 'log';
  /** Shown to admins, e.g. "smtp.example.com:587". */
  description: string;
  send(message: MailMessage): Promise<void>;
}

export const MAX_MAIL_ATTEMPTS = 5;
const BACKOFF_MS = 60_000;

export function createTransport(smtp: SmtpConfig | undefined): MailTransport {
  if (!smtp) return { kind: 'log', description: 'not configured', send: async () => {} };
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    kind: 'smtp',
    description: `${smtp.host}:${smtp.port}`,
    send: async (m) => {
      await transporter.sendMail({ from: smtp.from, to: m.to, subject: m.subject, text: m.text, html: m.html });
    },
  };
}

/**
 * Queue-backed mailer. Mails are written in the caller's transaction (so a rolled-back invite
 * sends nothing) and delivered by `flush`, which the worker calls every few seconds.
 */
export class Mailer {
  private flushing: Promise<number> | null = null;

  constructor(
    private db: DB,
    readonly transport: MailTransport,
  ) {}

  async enqueue(tx: Exec, kind: string, message: MailMessage) {
    const [row] = await tx.insert(emails).values({ ...message, kind, status: 'pending' }).returning({ id: emails.id });
    return row.id;
  }

  /** Sends due mails; concurrent calls share one run. `ignoreBackoff` retries immediately (tests, "retry now"). */
  flush(opts: { ignoreBackoff?: boolean } = {}): Promise<number> {
    if (!this.flushing) this.flushing = this.run(opts).finally(() => (this.flushing = null));
    return this.flushing;
  }

  /** Fire-and-forget delivery right after a request committed its mails. */
  kick() {
    setImmediate(() => void this.flush().catch(() => undefined));
  }

  private async run({ ignoreBackoff }: { ignoreBackoff?: boolean }) {
    const due = await this.db
      .select()
      .from(emails)
      .where(ignoreBackoff ? eq(emails.status, 'pending') : and(eq(emails.status, 'pending'), lte(emails.nextAttemptAt, new Date())))
      .orderBy(asc(emails.createdAt))
      .limit(50);
    if (this.transport.kind === 'log') {
      if (due.length) await this.db.update(emails).set({ status: 'skipped', lastError: 'No mail server configured (SMTP_HOST)' }).where(inArray(emails.id, due.map((m) => m.id)));
      return 0;
    }
    let sent = 0;
    for (const m of due) {
      const attempts = m.attempts + 1;
      try {
        await this.transport.send({ to: m.to, subject: m.subject, text: m.text, html: m.html });
        await this.db.update(emails).set({ status: 'sent', attempts, sentAt: new Date(), lastError: null }).where(eq(emails.id, m.id));
        sent++;
      } catch (err) {
        const failed = attempts >= MAX_MAIL_ATTEMPTS;
        await this.db
          .update(emails)
          .set({ status: failed ? 'failed' : 'pending', attempts, lastError: (err as Error).message.slice(0, 500), nextAttemptAt: new Date(Date.now() + BACKOFF_MS * 2 ** (attempts - 1)) })
          .where(eq(emails.id, m.id));
      }
    }
    return sent;
  }
}
