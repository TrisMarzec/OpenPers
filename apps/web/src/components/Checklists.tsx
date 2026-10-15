import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, todayISO } from '../lib/format';
import { Button, cx, Dialog, Empty, Field, Input, Select, Spinner, useErrorText, useToast } from './ui';

export interface ChecklistTask {
  id: string;
  title: string;
  description: string | null;
  assigneeRole: string;
  assigneeUserId: string | null;
  dueDate: string;
  doneAt: string | null;
}

export interface Checklist {
  id: string;
  personId: string;
  kind: 'onboarding' | 'offboarding';
  name: string;
  referenceDate: string;
  status: 'open' | 'done';
  tasks: ChecklistTask[];
  progress: { done: number; total: number };
  personName?: string;
  overdue?: number;
}

export function Progress({ done, total }: { done: number; total: number }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className="inline-flex items-center gap-2">
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-rule-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span className="block h-full rounded-full bg-grant" style={{ width: `${pct}%` }} />
      </span>
      <span className="tnum text-xs text-ink-soft">
        {done}/{total}
      </span>
    </span>
  );
}

/** One task row with a checkbox; editable by the assignee or HR. */
export function TaskRow({ task, onToggled, extra }: { task: ChecklistTask; onToggled?: () => void; extra?: React.ReactNode }) {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const toast = useToast();
  const errText = useErrorText();
  const editable = task.assigneeUserId === me?.id || can('checklists.manage');
  const toggle = useMutation({
    mutationFn: () => api.patch(`/checklist-tasks/${task.id}`, { done: !task.doneAt }),
    onSuccess: () => onToggled?.(),
    onError: (e) => toast(errText(e), 'error'),
  });
  const overdue = !task.doneAt && task.dueDate < todayISO();
  return (
    <li className="flex items-start gap-3 border-b border-rule-soft py-2 last:border-0">
      <input type="checkbox" className="mt-1 size-4 accent-[var(--color-grant)]" checked={!!task.doneAt} disabled={!editable || toggle.isPending} onChange={() => toggle.mutate()} aria-label={task.title} />
      <div className="min-w-0 flex-1">
        <div className={cx('font-semibold', task.doneAt && 'text-ink-faint line-through')}>{task.title}</div>
        {task.description && <div className="text-sm text-ink-soft">{task.description}</div>}
        <div className="text-xs text-ink-faint">
          {t(`checklists.assignees.${task.assigneeRole}`)} ·{' '}
          <span className={cx(overdue && 'font-semibold text-refuse')}>
            {overdue ? t('checklists.overdueSince', { date: fmtDate(task.dueDate) }) : t('checklists.due', { date: fmtDate(task.dueDate) })}
          </span>
          {extra}
        </div>
      </div>
    </li>
  );
}

export function ChecklistCard({ checklist, onChanged }: { checklist: Checklist; onChanged: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const remove = useMutation({ mutationFn: () => api.delete(`/checklists/${checklist.id}`), onSuccess: onChanged });
  return (
    <section className="rounded-md border border-rule bg-sheet">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-rule-soft px-4 py-3">
        <div>
          <h3 className="font-bold">{checklist.name}</h3>
          <p className="text-sm text-ink-soft">
            {t(`checklists.kinds.${checklist.kind}`)} · {t(checklist.kind === 'onboarding' ? 'checklists.startDate' : 'checklists.endDate', { date: fmtDate(checklist.referenceDate) })}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Progress {...checklist.progress} />
          {checklist.status === 'done' && <span className="stamp text-grant">{t('checklists.done')}</span>}
          {can('checklists.manage') && (
            <Button size="sm" variant="ghost" onClick={() => confirm(t('common.confirmDelete')) && remove.mutate()}>
              {t('common.delete')}
            </Button>
          )}
        </div>
      </header>
      <ul className="px-4 py-1">
        {checklist.tasks.map((task) => (
          <TaskRow key={task.id} task={task} onToggled={onChanged} />
        ))}
      </ul>
    </section>
  );
}

export function StartChecklistDialog({ personId, open, onClose, onStarted }: { personId: string; open: boolean; onClose: () => void; onStarted: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const errText = useErrorText();
  const templates = useQuery({ queryKey: ['checklist-templates'], queryFn: () => api.get('/checklist-templates'), enabled: open });
  const [templateId, setTemplateId] = useState('');
  const [referenceDate, setReferenceDate] = useState('');
  const start = useMutation({
    mutationFn: () => api.post(`/persons/${personId}/checklists`, { templateId: templateId || templates.data?.items[0]?.id, referenceDate: referenceDate || undefined }),
    onSuccess: () => {
      toast(t('checklists.started'));
      onStarted();
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('checklists.start')}
      footer={
        <Button variant="primary" busy={start.isPending} onClick={() => start.mutate()}>
          {t('checklists.start')}
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label={t('checklists.template')}>
          <Select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {(templates.data?.items ?? []).map((tpl: any) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.name} ({t(`checklists.kinds.${tpl.kind}`)})
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('checklists.referenceDate')} hint={t('checklists.referenceHint')}>
          <Input type="date" value={referenceDate} onChange={(e) => setReferenceDate(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** All checklists of one person, e.g. as a tab in the employee profile. */
export function PersonChecklists({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const q = useQuery({ queryKey: ['checklists', personId], queryFn: () => api.get<{ items: Checklist[] }>(`/persons/${personId}/checklists`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['checklists'] });
    qc.invalidateQueries({ queryKey: ['tasks-mine'] });
  };
  return (
    <div className="grid gap-4">
      {can('checklists.manage') && (
        <div className="flex justify-end">
          <Button variant="primary" onClick={() => setStarting(true)}>
            {t('checklists.start')}
          </Button>
        </div>
      )}
      {q.isLoading ? <Spinner /> : !q.data?.items.length ? <Empty>{t('checklists.emptyPerson')}</Empty> : q.data.items.map((c) => <ChecklistCard key={c.id} checklist={c} onChanged={refresh} />)}
      <StartChecklistDialog personId={personId} open={starting} onClose={() => setStarting(false)} onStarted={refresh} />
    </div>
  );
}
