import { resolve } from 'node:path';
import type { MailTransport } from './lib/mailer';

/** Injected from the root package.json at build time (tsup `define`); "dev" when run from source. */
declare const __OPENPERS_VERSION__: string | undefined;
const VERSION = typeof __OPENPERS_VERSION__ === 'string' ? __OPENPERS_VERSION__ : 'dev';

export interface Config {
  port: number;
  host: string;
  appUrl: string;
  databaseUrl?: string;
  dataDir: string;
  inMemory: boolean;
  secretKey: string;
  storageDir: string;
  webDistDir?: string;
  logger: boolean;
  startWorker: boolean;
  secureCookies: boolean;
  version: string;
  /** Outgoing mail; without SMTP_HOST mails are only recorded (and invitation links shown to admins). */
  smtp?: SmtpConfig;
  /** Replaces the SMTP transport, e.g. in tests. */
  mailTransport?: MailTransport;
}

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS from the start (port 465); otherwise STARTTLS is used when the server offers it. */
  secure: boolean;
  user?: string;
  password?: string;
  from: string;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const appUrl = overrides.appUrl ?? env.APP_URL ?? `http://localhost:${env.PORT ?? 3000}`;
  const secretKey = overrides.secretKey ?? env.SECRET_KEY;
  if (!secretKey || secretKey.length < 32) {
    throw new Error('SECRET_KEY must be set and at least 32 characters long (e.g. `openssl rand -hex 32`).');
  }
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    appUrl,
    databaseUrl: env.DATABASE_URL || undefined,
    dataDir: resolve(env.DATA_DIR ?? 'data'),
    inMemory: false,
    storageDir: resolve(env.STORAGE_DIR ?? `${env.DATA_DIR ?? 'data'}/files`),
    webDistDir: env.WEB_DIST_DIR,
    logger: env.LOG_LEVEL !== 'silent',
    startWorker: true,
    secureCookies: appUrl.startsWith('https://'),
    version: VERSION,
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: Number(env.SMTP_PORT ?? 587),
          secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : Number(env.SMTP_PORT) === 465,
          user: env.SMTP_USER || undefined,
          password: env.SMTP_PASSWORD || undefined,
          from: env.MAIL_FROM ?? `OpenPers <no-reply@${new URL(appUrl).hostname}>`,
        }
      : undefined,
    ...overrides,
    secretKey,
  };
}
