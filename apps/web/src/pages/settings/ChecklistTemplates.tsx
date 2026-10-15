import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { fullName } from '../../lib/format';
import { Button, Checkbox, Dialog, Field, Input, Section, Select, Table, useErrorText, useToast } from '../../components/ui';

interface TaskDraft {
  title: string;
  description?: string | null;
  assignee: 'hr' | 'manager' | 'employee' | 'person';
  assigneePersonId?: string | null;
  offsetDays: number;
}
interface TemplateDraft {
  id?: string;
  name: string;
  kind: 'onboarding' | 'offboarding';
  orgUnitId?: string | null;
  autoStart: boolean;
  active: boolean;
  tasks: TaskDraft[];
}

/** On-/offboarding templates with an inline task list editor. */
export function ChecklistTemplatesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['checklist-templates'], queryFn: () => api.get('/checklist-templates') });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get('/directory') });
  const [edit, setEdit] = useState<TemplateDraft | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const { id, ...body } = edit!;
      const payload = { ...body, orgUnitId: body.orgUnitId || null, tasks: body.tasks.filter((x) => x.title.trim()).map((x) => ({ ...x, assigneePersonId: x.assignee === 'person' ? x.assigneePersonId : null })) };
      return id ? api.patch(`/checklist-templates/${id}`, payload) : api.post('/checklist-templates', payload);
    },
    onSuccess: () => {
      toast(t('common.saved'));
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['checklist-templates'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/checklist-templates/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['checklist-templates'] }) });

  const setTask = (i: number, patch: Partial<TaskDraft>) => setEdit((e) => e && { ...e, tasks: e.tasks.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const move = (i: number, d: number) =>
    setEdit((e) => {
      if (!e || i + d < 0 || i + d >= e.tasks.length) return e;
      const tasks = [...e.tasks];
      [tasks[i], tasks[i + d]] = [tasks[i + d], tasks[i]];
      return { ...e, tasks };
    });
  const offsetLabel = (n: number) => (n === 0 ? t('checklists.onDay') : n < 0 ? t('checklists.daysBefore', { count: -n }) : t('checklists.daysAfter', { count: n }));

  return (
    <Section
      title={t('checklists.templates')}
      actions={
        <Button size="sm" onClick={() => setEdit({ name: '', kind: 'onboarding', autoStart: false, active: true, tasks: [{ title: '', assignee: 'hr', offsetDays: 0 }] })}>
          {t('common.add')}
        </Button>
      }
    >
      <p className="mb-3 text-sm text-ink-soft">{t('checklists.templatesIntro')}</p>
      <Table head={[t('common.name'), t('checklists.kind'), t('checklists.tasks'), t('checklists.autoStart'), '']}>
        {(q.data?.items ?? []).map((tpl: any) => (
          <tr key={tpl.id}>
            <td className="font-semibold">{tpl.name}</td>
            <td>{t(`checklists.kinds.${tpl.kind}`)}</td>
            <td className="tnum">{tpl.tasks.length}</td>
            <td>{tpl.autoStart ? t('common.yes') : t('common.no')}</td>
            <td className="text-right whitespace-nowrap">
              <Button size="sm" variant="ghost" onClick={() => setEdit(structuredClone(tpl))}>
                {t('common.edit')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => confirm(t('common.confirmDelete')) && del.mutate(tpl.id)}>
                {t('common.delete')}
              </Button>
            </td>
          </tr>
        ))}
      </Table>
      <Dialog
        open={!!edit}
        wide
        onClose={() => setEdit(null)}
        title={edit?.id ? edit.name : t('checklists.newTemplate')}
        footer={
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        }
      >
        {edit && (
          <div className="grid gap-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label={t('common.name')}>
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              </Field>
              <Field label={t('checklists.kind')}>
                <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as TemplateDraft['kind'] })}>
                  <option value="onboarding">{t('checklists.kinds.onboarding')}</option>
                  <option value="offboarding">{t('checklists.kinds.offboarding')}</option>
                </Select>
              </Field>
              <Field label={t('checklists.onlyUnit')}>
                <Select value={edit.orgUnitId ?? ''} onChange={(e) => setEdit({ ...edit, orgUnitId: e.target.value || null })}>
                  <option value="">{t('team.allUnits')}</option>
                  {(units.data?.items ?? []).map((u: any) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Checkbox label={t('checklists.autoStart')} hint={t('checklists.autoStartHint')} checked={edit.autoStart} onChange={(v) => setEdit({ ...edit, autoStart: v })} />
            <div>
              <h3 className="mb-2 font-bold">{t('checklists.tasks')}</h3>
              <ol className="grid gap-2">
                {edit.tasks.map((task, i) => (
                  <li key={i} className="grid gap-2 rounded-md border border-rule p-2 sm:grid-cols-[1fr_9rem_9rem_auto]">
                    <Input aria-label={t('checklists.taskTitle')} placeholder={t('checklists.taskTitle')} value={task.title} onChange={(e) => setTask(i, { title: e.target.value })} />
                    <Select aria-label={t('checklists.assignee')} value={task.assignee} onChange={(e) => setTask(i, { assignee: e.target.value as TaskDraft['assignee'] })}>
                      {(['hr', 'manager', 'employee', 'person'] as const).map((a) => (
                        <option key={a} value={a}>
                          {t(`checklists.assignees.${a}`)}
                        </option>
                      ))}
                    </Select>
                    <label className="flex items-center gap-1.5 text-sm">
                      <Input type="number" className="tnum w-20" aria-label={t('checklists.offset')} value={task.offsetDays} onChange={(e) => setTask(i, { offsetDays: Number(e.target.value) || 0 })} />
                      <span className="text-xs text-ink-faint">{offsetLabel(task.offsetDays)}</span>
                    </label>
                    <span className="flex items-center gap-0.5">
                      <button type="button" aria-label={t('common.previous')} className="rounded p-1 text-ink-faint hover:bg-rule-soft" onClick={() => move(i, -1)}>
                        <ArrowUp size={14} />
                      </button>
                      <button type="button" aria-label={t('common.next')} className="rounded p-1 text-ink-faint hover:bg-rule-soft" onClick={() => move(i, 1)}>
                        <ArrowDown size={14} />
                      </button>
                      <button type="button" aria-label={t('common.delete')} className="rounded p-1 text-ink-faint hover:bg-refuse-wash hover:text-refuse" onClick={() => setEdit({ ...edit, tasks: edit.tasks.filter((_, j) => j !== i) })}>
                        <Trash2 size={14} />
                      </button>
                    </span>
                    {task.assignee === 'person' && (
                      <Select className="sm:col-span-2" aria-label={t('checklists.assigneePerson')} value={task.assigneePersonId ?? ''} onChange={(e) => setTask(i, { assigneePersonId: e.target.value || null })}>
                        <option value="">{t('checklists.assigneePerson')}</option>
                        {(dir.data?.items ?? []).map((p: any) => (
                          <option key={p.id} value={p.id}>
                            {fullName(p)}
                          </option>
                        ))}
                      </Select>
                    )}
                  </li>
                ))}
              </ol>
              <Button size="sm" className="mt-2" onClick={() => setEdit({ ...edit, tasks: [...edit.tasks, { title: '', assignee: 'hr', offsetDays: 0 }] })}>
                {t('checklists.addTask')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </Section>
  );
}
