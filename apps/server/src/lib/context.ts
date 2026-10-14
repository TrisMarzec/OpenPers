import type { FastifyInstance } from 'fastify';
import type { DB, Exec } from '../db';
import { auditLog, outbox } from '../db/schema';
import type { Authz } from './authz';
import type { FieldCipher } from './crypto';
import type { RouteRecord } from './api';
import type { StorageAdapter } from './storage';
import type { Config } from '../config';

export interface AppContext {
  db: DB;
  config: Config;
  authz: Authz;
  cipher: FieldCipher;
  storage: StorageAdapter;
  registry: RouteRecord[];
  /** Per-module contributions to the DSGVO data export of a person. */
  exporters: Record<string, (db: Exec, personId: string) => Promise<unknown>>;
  /** Per-module hooks that remove personal data when a person is anonymized. */
  anonymizers: Array<(tx: Exec, personId: string) => Promise<void>>;
}

export interface SetupInfo {
  region: string;
  adminUserId: string;
  adminPersonId: string;
}

export interface OpenPersModule {
  name: string;
  register(app: FastifyInstance, ctx: AppContext): void | Promise<void>;
  /** Called inside the setup transaction to create default data. */
  seed?(tx: Exec, ctx: AppContext, info: SetupInfo): Promise<void>;
}

export async function audit(
  tx: Exec,
  actorUserId: string | null,
  entity: string,
  entityId: string,
  action: string,
  changes?: Record<string, unknown>,
): Promise<void> {
  await tx.insert(auditLog).values({ actorUserId, entity, entityId, action, changes: changes ?? null });
}

export async function emit(tx: Exec, event: string, payload: Record<string, unknown>): Promise<void> {
  await tx.insert(outbox).values({ event, payload });
}

/** Returns only the keys whose value changed, as `{ key: { from, to } }`. */
export function diff(before: Record<string, any>, patch: Record<string, any>): Record<string, { from: unknown; to: unknown }> {
  const out: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(v)) out[k] = { from: before[k] ?? null, to: v };
  }
  return out;
}
