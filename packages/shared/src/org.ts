export interface OrgPerson {
  id: string;
  supervisorPersonId: string | null;
  orgUnitIds?: string[];
}

export interface ReportingNode<T extends OrgPerson> {
  item: T;
  children: ReportingNode<T>[];
}

export interface OrgUnitLike {
  id: string;
  parentId: string | null;
}

export interface UnitNode<U extends OrgUnitLike, P extends OrgPerson> {
  unit: U;
  members: P[];
  children: UnitNode<U, P>[];
}

/**
 * Resolves each id's parent for a forest. Unknown parents make an id a root. In a parent cycle,
 * the member that comes first in `ids` becomes the root, so every id appears exactly once.
 */
function resolveParents(ids: string[], rawParent: (id: string) => string | null): Map<string, string | null> {
  const known = new Set(ids);
  const order = new Map(ids.map((id, i) => [id, i]));
  const parentOf = (id: string) => {
    const p = rawParent(id);
    return p && p !== id && known.has(p) ? p : null;
  };
  const result = new Map<string, string | null>();
  for (const id of ids) {
    const chain = [id];
    let cur = parentOf(id);
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = parentOf(cur);
    }
    if (cur === id) {
      // `id` is part of a cycle: cut it at the earliest member.
      const first = chain.reduce((a, b) => (order.get(a)! <= order.get(b)! ? a : b));
      result.set(id, id === first ? null : parentOf(id));
    } else {
      result.set(id, parentOf(id));
    }
  }
  return result;
}

/** Reporting-line forest built from supervisor links. */
export function buildReportingTree<T extends OrgPerson>(people: T[]): ReportingNode<T>[] {
  const nodes = new Map(people.map((p) => [p.id, { item: p, children: [] as ReportingNode<T>[] }]));
  const byId = new Map(people.map((p) => [p.id, p]));
  const parents = resolveParents(people.map((p) => p.id), (id) => byId.get(id)?.supervisorPersonId ?? null);
  const roots: ReportingNode<T>[] = [];
  for (const p of people) {
    const parent = parents.get(p.id);
    (parent ? nodes.get(parent)!.children : roots).push(nodes.get(p.id)!);
  }
  return roots;
}

export function countDescendants(node: { children: unknown[] }): number {
  return (node.children as { children: unknown[] }[]).reduce((s, c) => s + 1 + countDescendants(c), 0);
}

/** Largest number of direct reports of any person (span of control), e.g. for "largest team". */
export function largestSpan(nodes: { children: unknown[] }[]): number {
  return nodes.reduce((m, n) => Math.max(m, n.children.length, largestSpan(n.children as { children: unknown[] }[])), 0);
}

/** Org-unit forest with each person attached to the units of their employment. */
export function buildUnitTree<U extends OrgUnitLike, P extends OrgPerson>(units: U[], people: P[]): UnitNode<U, P>[] {
  const nodes = new Map(units.map((u) => [u.id, { unit: u, members: people.filter((p) => p.orgUnitIds?.includes(u.id)), children: [] as UnitNode<U, P>[] }]));
  const byId = new Map(units.map((u) => [u.id, u]));
  const parents = resolveParents(units.map((u) => u.id), (id) => byId.get(id)?.parentId ?? null);
  const roots: UnitNode<U, P>[] = [];
  for (const u of units) {
    const parent = parents.get(u.id);
    (parent ? nodes.get(parent)!.children : roots).push(nodes.get(u.id)!);
  }
  return roots;
}
