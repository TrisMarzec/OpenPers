import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDaysISO, fmtDate, todayISO } from '../lib/format';
import { ChecklistCard, Progress, TaskRow, type Checklist, type ChecklistTask } from '../components/Checklists';
import { Empty, PageHeader, Section, Select, Spinner, Tabs } from '../components/ui';

type MyTask = ChecklistTask & { checklistName: string; kind: string; personId: string; personName: string };

function MyTasks() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const person = params.get('person');
  const q = useQuery({ queryKey: ['tasks-mine'], queryFn: () => api.get<{ items: MyTask[] }>('/tasks/mine') });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['tasks-mine'] });
    qc.invalidateQueries({ queryKey: ['checklists'] });
  };
  if (q.isLoading) return <Spinner />;
  const items = (q.data?.items ?? []).filter((x) => !person || x.personId === person);
  if (!items.length) return <Empty>{t('tasks.empty')}</Empty>;
  const today = todayISO();
  const soon = addDaysISO(today, 7);
  const groups = [
    { key: 'overdue', items: items.filter((x) => x.dueDate < today) },
    { key: 'today', items: items.filter((x) => x.dueDate === today) },
    { key: 'week', items: items.filter((x) => x.dueDate > today && x.dueDate <= soon) },
    { key: 'later', items: items.filter((x) => x.dueDate > soon) },
  ].filter((g) => g.items.length);
  return (
    <div className="grid gap-5">
      {person && (
        <p className="text-sm text-ink-soft">
          {t('tasks.filteredFor', { name: items[0]?.personName ?? '' })}{' '}
          <Link to="/tasks" className="font-semibold text-stamp hover:underline">
            {t('tasks.showAll')}
          </Link>
        </p>
      )}
      {groups.map((g) => (
        <Section key={g.key} title={`${t(`tasks.groups.${g.key}`)} (${g.items.length})`}>
          <ul>
            {g.items.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggled={refresh}
                extra={
                  <>
                    {' · '}
                    <Link to={`/people/${task.personId}`} className="text-stamp hover:underline">
                      {task.personName}
                    </Link>{' '}
                    ({task.checklistName})
                  </>
                }
              />
            ))}
          </ul>
        </Section>
      ))}
    </div>
  );
}

function Overview() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'open' | 'done'>('open');
  const [open, setOpen] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['checklists', 'all', status], queryFn: () => api.get<{ items: Checklist[] }>(`/checklists?status=${status}`) });
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Select className="h-9 max-w-48" value={status} onChange={(e) => setStatus(e.target.value as 'open' | 'done')} aria-label={t('common.status')}>
          <option value="open">{t('checklists.statusOpen')}</option>
          <option value="done">{t('checklists.done')}</option>
        </Select>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <Empty>{t('checklists.emptyAll')}</Empty>
      ) : (
        <div className="overflow-hidden rounded-md border border-rule bg-sheet">
          {q.data.items.map((c) => (
            <div key={c.id} className="border-b border-rule-soft last:border-0">
              <button type="button" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-paper">
                {open === c.id ? <ChevronDown size={16} className="text-ink-faint" aria-hidden /> : <ChevronRight size={16} className="text-ink-faint" aria-hidden />}
                <span className="min-w-48 flex-1">
                  <span className="block font-semibold">{c.personName}</span>
                  <span className="block text-sm text-ink-soft">
                    {c.name} · {fmtDate(c.referenceDate)}
                  </span>
                </span>
                {!!c.overdue && <span className="stamp text-refuse">{t('checklists.overdueCount', { count: c.overdue })}</span>}
                <Progress {...c.progress} />
              </button>
              {open === c.id && (
                <div className="bg-paper p-3">
                  <ChecklistCard checklist={c} onChanged={() => qc.invalidateQueries({ queryKey: ['checklists'] })} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TasksPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [tab, setTab] = useState<'mine' | 'overview'>('mine');
  return (
    <div>
      <PageHeader title={t('tasks.title')} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'mine', label: t('tasks.mine') },
          { value: 'overview', label: t('tasks.overview'), hidden: !can('checklists.manage') },
        ]}
      />
      {tab === 'mine' ? <MyTasks /> : <Overview />}
    </div>
  );
}
