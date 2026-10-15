import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import { buildReportingTree, buildUnitTree, countDescendants, type ReportingNode, type UnitNode } from '@openpers/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fullName, initials } from '../lib/format';
import { Avatar, Button, cx, Empty, Input, PageHeader, Spinner, Tabs } from '../components/ui';

interface DirPerson {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  photoUrl: string | null;
  email: string;
  positionTitle: string | null;
  supervisorPersonId: string | null;
  orgUnits: { id: string; name: string; type: string }[];
  orgUnitIds: string[];
  workplace: string | null;
}

interface Unit {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  headPersonId: string | null;
}

const matches = (p: DirPerson, q: string) => `${p.firstName} ${p.lastName} ${p.preferredName ?? ''} ${p.positionTitle ?? ''} ${p.orgUnits.map((o) => o.name).join(' ')}`.toLowerCase().includes(q);

function PersonCard({ person, linkable, highlight, reports, open, onToggle }: { person: DirPerson; linkable: boolean; highlight: boolean; reports: number; open: boolean; onToggle?: () => void }) {
  const { t } = useTranslation();
  const name = fullName(person);
  return (
    <div className={cx('w-56 rounded-md border bg-sheet text-left', highlight ? 'border-stamp ring-2 ring-stamp/40' : 'border-rule')}>
      <div className="flex items-center gap-2.5 p-2.5">
        <Avatar name={initials(person)} size={36} src={person.photoUrl} />
        <div className="min-w-0">
          {linkable ? (
            <Link to={`/people/${person.id}`} className="block truncate font-bold text-ink hover:text-stamp hover:underline">
              {name}
            </Link>
          ) : (
            <span className="block truncate font-bold">{name}</span>
          )}
          <span className="block truncate text-sm text-ink-soft">{person.positionTitle ?? '–'}</span>
          {person.orgUnits[0] && <span className="block truncate text-xs text-ink-faint">{person.orgUnits.map((o) => o.name).join(', ')}</span>}
        </div>
      </div>
      {reports > 0 && (
        <button type="button" onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-1 border-t border-rule-soft px-2.5 py-1 text-xs font-semibold text-ink-soft hover:bg-rule-soft hover:text-ink">
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
          {t('org.reports', { count: reports })}
        </button>
      )}
    </div>
  );
}

function ReportingBranch({ node, state }: { node: ReportingNode<DirPerson>; state: TreeState }) {
  const open = state.isOpen(node.item.id);
  return (
    <li>
      <PersonCard person={node.item} linkable={state.linkable(node.item.id)} highlight={state.highlight.has(node.item.id)} reports={node.children.length} open={open} onToggle={() => state.toggle(node.item.id)} />
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <ReportingBranch key={c.item.id} node={c} state={state} />
          ))}
        </ul>
      )}
    </li>
  );
}

function UnitBranch({ node, state, people }: { node: UnitNode<Unit, DirPerson>; state: TreeState; people: Map<string, DirPerson> }) {
  const { t } = useTranslation();
  const open = state.isOpen(node.unit.id);
  const head = node.unit.headPersonId ? people.get(node.unit.headPersonId) : undefined;
  const hit = node.members.some((m) => state.highlight.has(m.id));
  return (
    <li>
      <div className={cx('w-60 rounded-md border bg-sheet text-left', hit ? 'border-stamp ring-2 ring-stamp/40' : 'border-rule')}>
        <div className="border-b border-rule-soft px-3 py-2">
          <div className="font-bold">{node.unit.name}</div>
          <div className="text-xs text-ink-faint">
            {t(`settings.${node.unit.type === 'team' ? 'team' : 'department'}`)} · {t('org.members', { count: node.members.length })}
            {head ? ` · ${t('org.head')}: ${fullName(head)}` : ''}
          </div>
        </div>
        <div className="flex flex-col gap-1 p-2">
          {node.members.slice(0, open ? undefined : 4).map((m) => (
            <div key={m.id} className="flex items-center gap-2">
              <Avatar name={initials(m)} size={22} src={m.photoUrl} />
              {state.linkable(m.id) ? (
                <Link to={`/people/${m.id}`} className={cx('truncate text-sm hover:text-stamp hover:underline', state.highlight.has(m.id) && 'font-bold text-stamp')}>
                  {fullName(m)}
                </Link>
              ) : (
                <span className={cx('truncate text-sm', state.highlight.has(m.id) && 'font-bold text-stamp')}>{fullName(m)}</span>
              )}
            </div>
          ))}
        </div>
        {(node.members.length > 4 || node.children.length > 0) && (
          <button type="button" onClick={() => state.toggle(node.unit.id)} aria-expanded={open} className="flex w-full items-center gap-1 border-t border-rule-soft px-3 py-1 text-xs font-semibold text-ink-soft hover:bg-rule-soft hover:text-ink">
            {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
            {node.children.length ? t('org.subunits', { count: node.children.length }) : t('org.showAll')}
          </button>
        )}
      </div>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <UnitBranch key={c.unit.id} node={c} state={state} people={people} />
          ))}
        </ul>
      )}
    </li>
  );
}

interface TreeState {
  isOpen: (id: string) => boolean;
  toggle: (id: string) => void;
  highlight: Set<string>;
  linkable: (id: string) => boolean;
}

export function OrgChartPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [view, setView] = useState<'people' | 'units'>('people');
  const [query, setQuery] = useState('');
  /** Explicit open/closed choices; anything else falls back to the default depth. */
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [allOpen, setAllOpen] = useState<boolean | null>(null);
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get<{ items: DirPerson[] }>('/directory') });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get<{ items: Unit[] }>('/org-units') });
  const visible = useQuery({ queryKey: ['persons', ''], queryFn: () => api.get('/persons?limit=200'), enabled: can('people.read') });

  const people = useMemo(() => (dir.data?.items ?? []).map((p) => ({ ...p, orgUnitIds: p.orgUnits.map((o) => o.id) })), [dir.data]);
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const tree = useMemo(() => buildReportingTree(people), [people]);
  const unitTree = useMemo(() => buildUnitTree(units.data?.items ?? [], people), [units.data, people]);
  const visibleIds = new Set<string>((visible.data?.items ?? []).map((p: any) => p.id));

  const q = query.trim().toLowerCase();
  const highlight = useMemo(() => new Set(q.length >= 2 ? people.filter((p) => matches(p, q)).map((p) => p.id) : []), [people, q]);

  // Open the supervisor chain (people view) and unit chain (units view) of every search hit.
  const forcedOpen = useMemo(() => {
    const s = new Set<string>();
    for (const id of highlight) {
      for (let cur = byId.get(id)?.supervisorPersonId; cur && !s.has(cur); cur = byId.get(cur)?.supervisorPersonId) s.add(cur);
      for (const uid of byId.get(id)?.orgUnitIds ?? []) {
        for (let u: Unit | undefined = units.data?.items.find((x) => x.id === uid); u && !s.has(u.id); u = units.data?.items.find((x) => x.id === u!.parentId)) s.add(u.id);
      }
    }
    return s;
  }, [highlight, byId, units.data]);

  const depthOf = useMemo(() => {
    const d = new Map<string, number>();
    const walk = (ns: { children: any[] }[], depth: number, key: (n: any) => string) => ns.forEach((n) => (d.set(key(n), depth), walk(n.children, depth + 1, key)));
    walk(tree, 0, (n) => n.item.id);
    walk(unitTree, 0, (n) => n.unit.id);
    return d;
  }, [tree, unitTree]);

  const state: TreeState = {
    isOpen: (id) => forcedOpen.has(id) || (toggled[id] ?? allOpen ?? (depthOf.get(id) ?? 0) < 2),
    toggle: (id) => setToggled((s) => ({ ...s, [id]: !(s[id] ?? allOpen ?? (depthOf.get(id) ?? 0) < 2) })),
    highlight,
    linkable: (id) => visibleIds.has(id),
  };
  const setAll = (v: boolean) => {
    setToggled({});
    setAllOpen(v);
  };

  const unassigned = people.filter((p) => !p.orgUnitIds.length);
  const largestTeam = tree.reduce((m, n) => Math.max(m, countDescendants(n)), 0);

  return (
    <div>
      <PageHeader title={t('org.title')}>{t('org.summary', { people: people.length, units: units.data?.items.length ?? 0, span: largestTeam })}</PageHeader>
      <Tabs
        value={view}
        onChange={setView}
        items={[
          { value: 'people', label: t('org.byReports') },
          { value: 'units', label: t('org.byUnits') },
        ]}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search size={16} aria-hidden className="pointer-events-none absolute top-3 left-3 text-ink-faint" />
          <Input type="search" className="pl-9" placeholder={t('org.search')} aria-label={t('org.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        {q.length >= 2 && <span className="text-sm text-ink-soft">{t('org.hits', { count: highlight.size })}</span>}
        <span className="ml-auto flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t('org.expandAll')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAll(false)}>
            {t('org.collapseAll')}
          </Button>
        </span>
      </div>

      {dir.isLoading || units.isLoading ? (
        <Spinner />
      ) : view === 'people' ? (
        people.length === 0 ? (
          <Empty>{t('people.empty')}</Empty>
        ) : (
          <div className="overflow-x-auto rounded-md border border-rule bg-paper p-6">
            <div className="orgtree mx-auto w-max">
              <ul>
                {tree.map((n) => (
                  <ReportingBranch key={n.item.id} node={n} state={state} />
                ))}
              </ul>
            </div>
          </div>
        )
      ) : unitTree.length === 0 ? (
        <Empty
          action={
            can('org.manage') && (
              <Link to="/settings/org" className="font-semibold text-stamp hover:underline">
                {t('settings.orgUnits')}
              </Link>
            )
          }
        >
          {t('org.noUnits')}
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border border-rule bg-paper p-6">
          <div className="orgtree mx-auto w-max">
            <ul>
              {unitTree.map((n) => (
                <UnitBranch key={n.unit.id} node={n} state={state} people={byId} />
              ))}
            </ul>
          </div>
          {unassigned.length > 0 && <p className="mt-6 text-sm text-ink-faint">{t('org.unassigned', { count: unassigned.length })}</p>}
        </div>
      )}
    </div>
  );
}
