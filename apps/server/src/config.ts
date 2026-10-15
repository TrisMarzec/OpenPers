import { resolve } from 'node:path';

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
    ...overrides,
    secretKey,
  };
}
