import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { schema } from './schema';

export { schema };
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type Exec = DB | Tx;

function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../drizzle'), join(here, '../../drizzle'), resolve('drizzle'), resolve('apps/server/drizzle')];
  const found = candidates.find((c) => existsSync(join(c, 'meta/_journal.json')));
  if (!found) throw new Error(`Migrations folder not found (looked in ${candidates.join(', ')})`);
  return found;
}

export interface DbOptions {
  databaseUrl?: string;
  dataDir?: string;
  inMemory?: boolean;
}

export async function createDb(opts: DbOptions): Promise<{ db: DB; close: () => Promise<void>; kind: 'postgres' | 'pglite' }> {
  const folder = migrationsFolder();
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl });
    const db = drizzlePg(pool, { schema });
    await migratePg(db, { migrationsFolder: folder });
    return { db: db as unknown as DB, close: () => pool.end(), kind: 'postgres' };
  }
  let client: PGlite;
  if (opts.inMemory) client = new PGlite();
  else {
    const dir = resolve(opts.dataDir ?? 'data/db');
    mkdirSync(dir, { recursive: true });
    client = new PGlite(dir);
  }
  const db = drizzlePglite(client, { schema });
  await migratePglite(db, { migrationsFolder: folder });
  return { db: db as unknown as DB, close: () => client.close(), kind: 'pglite' };
}
