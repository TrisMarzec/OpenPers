import { sql } from 'drizzle-orm';
import type { Permission, Scope } from '@openpers/shared';
import type { DB } from '../db';
import { forbidden } from './errors';

export interface Principal {
  userId: string;
  email: string;
  personId: string | null;
  locale: string;
  /** Permission → scopes granted by the user's role assignments. */
  permissions: Record<string, Scope[]>;
  tokenId?: string;
  /** Per-request memo for scope lookups. */
  cache: Map<string, Set<string>>;
}

export type Visible = 'all' | Set<string>;

const rows = <T>(res: unknown): T[] => ((res as { rows?: T[] }).rows ?? (res as T[]));

export class Authz {
  constructor(private db: DB) {}

  has(p: Principal | null, perm: Permission): boolean {
    return !!p && (p.permissions[perm]?.length ?? 0) > 0;
  }

  /** Persons the principal may access with `perm`. */
  async visiblePersonIds(p: Principal, perm: Permission): Promise<Visible> {
    const scopes = p.permissions[perm] ?? [];
    if (scopes.includes('all')) return 'all';
    const out = new Set<string>();
    if (!p.personId) return out;
    if (scopes.includes('self')) out.add(p.personId);
    if (scopes.includes('reports')) for (const id of await this.reportsOf(p)) out.add(id);
    if (scopes.includes('org_unit')) for (const id of await this.orgUnitMembers(p)) out.add(id);
    return out;
  }

  async can(p: Principal | null, perm: Permission, targetPersonId?: string | null): Promise<boolean> {
    if (!p || !this.has(p, perm)) return false;
    if (!targetPersonId) return true;
    const visible = await this.visiblePersonIds(p, perm);
    return visible === 'all' || visible.has(targetPersonId);
  }

  async assert(p: Principal | null, perm: Permission, targetPersonId?: string | null): Promise<void> {
    if (!(await this.can(p, perm, targetPersonId))) throw forbidden(`Missing permission ${perm}`);
  }

  /** Direct and indirect reports via active employments' supervisor links. */
  async reportsOf(p: Principal): Promise<Set<string>> {
    const key = 'reports';
    const cached = p.cache.get(key);
    if (cached) return cached;
    const res = await this.db.execute(sql`
      WITH RECURSIVE r(person_id) AS (
        SELECT e.person_id FROM employments e
          WHERE e.supervisor_person_id = ${p.personId} AND (e.end_date IS NULL OR e.end_date >= CURRENT_DATE)
        UNION
        SELECT e.person_id FROM employments e JOIN r ON e.supervisor_person_id = r.person_id
          WHERE e.end_date IS NULL OR e.end_date >= CURRENT_DATE
      )
      SELECT person_id FROM r`);
    const set = new Set(rows<{ person_id: string }>(res).map((r) => r.person_id));
    set.delete(p.personId!);
    p.cache.set(key, set);
    return set;
  }

  /** Persons in any org unit (incl. sub-units) the principal's employment belongs to. */
  async orgUnitMembers(p: Principal): Promise<Set<string>> {
    const key = 'org_unit';
    const cached = p.cache.get(key);
    if (cached) return cached;
    const res = await this.db.execute(sql`
      WITH RECURSIVE units(id) AS (
        SELECT eou.org_unit_id FROM employment_org_units eou
          JOIN employments e ON e.id = eou.employment_id
          WHERE e.person_id = ${p.personId}
        UNION
        SELECT o.id FROM org_units o JOIN units u ON o.parent_id = u.id
      )
      SELECT DISTINCT e.person_id FROM employments e
        JOIN employment_org_units eou ON eou.employment_id = e.id
        WHERE eou.org_unit_id IN (SELECT id FROM units)`);
    const set = new Set(rows<{ person_id: string }>(res).map((r) => r.person_id));
    p.cache.set(key, set);
    return set;
  }
}
