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
  /** Periodic jobs run by the background worker (hourly) and by `runMaintenance`. */
  maintenance: Array<(ctx: AppContext) => Promise<void>>;
  /** Cross-module services, e.g. the time module's balance calculation for analytics. */
  services: Record<string, (...args: any[]) => Promise<any>>;
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
  /** Runs on every start after migrations, e.g. to add defaults to installations set up before a module existed. */
  upgrade?(ctx: AppContext): Promise<void>;
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

export type EventListener = (tx: Exec, payload: Record<string, unknown>, event: string) => Promise<void>;

/**
 * In-process listeners run inside the emitting transaction, so side effects such as
 * notifications commit or roll back together with the change. One app per process:
 * `buildApp` resets the registry before modules register.
 */
const listeners = new Map<string, EventListener[]>();

export function onEvent(event: string, fn: EventListener): void {
  listeners.set(event, [...(listeners.get(event) ?? []), fn]);
}

export function resetEventListeners(): void {
  listeners.clear();
}

export async function emit(tx: Exec, event: string, payload: Record<string, unknown>): Promise<void> {
  await tx.insert(outbox).values({ event, payload });
  for (const fn of listeners.get(event) ?? []) await fn(tx, payload, event);
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
