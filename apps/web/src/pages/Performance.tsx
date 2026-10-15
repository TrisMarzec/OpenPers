import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fullName } from '../lib/format';
import { AssignPeersDialog, FeedbackSection, GoalsSection, ReviewDialog, ReviewResults, type Question } from '../components/Performance';
import { Button, Checkbox, cx, Dialog, Empty, Field, Input, PageHeader, Section, Select, Spinner, Table, Tabs, useErrorText, useToast } from '../components/ui';

type Tab = 'todo' | 'results' | 'goals' | 'feedback' | 'cycles';

function ToWrite() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['reviews-mine'], queryFn: () => api.get('/reviews/mine') });
  const [open, setOpen] = useState<any>(null);
  if (q.isLoading) return <Spinner />;
  const items = (q.data?.items ?? []).filter((r: any) => r.cycle.status !== 'draft');
  if (!items.length) return <Empty>{t('performance.noTodo')}</Empty>;
  const byCycle = new Map<string, any[]>();
  for (const r of items) byCycle.set(r.cycle.id, [...(byCycle.get(r.cycle.id) ?? []), r]);
  return (
    <div className="grid gap-5">
      {[...byCycle.values()].map((list) => (
        <Section key={list[0].cycle.id} title={`${list[0].cycle.name}${list[0].cycle.dueDate ? ` · ${t('performance.dueBy', { date: fmtDate(list[0].cycle.dueDate) })}` : ''}`}>
          <ul className="divide-y divide-rule">
            {list.map((r) => {
              const writable = r.status === 'pending' && r.cycle.status === 'active';
              return (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                  <span>
                    <span className="font-semibold">{r.type === 'self' ? t('performance.selfReview') : fullName(r.reviewee)}</span>
                    {r.type !== 'self' && <span className="ml-2 text-sm text-ink-faint">{t(`performance.types.${r.type}`)}</span>}
                  </span>
                  <span className="flex items-center gap-3">
                    <span className={cx('stamp', r.status === 'submitted' ? 'text-grant' : 'text-wait')}>{t(`performance.reviewStatus.${r.status}`)}</span>
                    <Button size="sm" variant={writable ? 'primary' : 'secondary'} onClick={() => setOpen(r)}>
                      {writable ? t('performance.write') : t('performance.view')}
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
      {open && <ReviewDialog review={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function MyResults({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const cycles = useQuery({ queryKey: ['person-cycles', personId], queryFn: () => api.get(`/persons/${personId}/review-cycles`) });
  const [cycleId, setCycleId] = useState('');
  if (cycles.isLoading) return <Spinner />;
  const items = cycles.data?.items ?? [];
  if (!items.length) return <Empty>{t('performance.noCycles')}</Empty>;
  const selected = cycleId || items[0].id;
  return (
    <Section
      title={items.find((c: any) => c.id === selected)?.name}
      actions={
        items.length > 1 && (
          <Select className="h-8 w-56" aria-label={t('performance.cycle')} value={selected} onChange={(e) => setCycleId(e.target.value)}>
            {items.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )
      }
    >
      <ReviewResults cycleId={selected} personId={personId} />
    </Section>
  );
}

// ---------- cycle management ----------

const newId = () => Math.random().toString(36).slice(2, 10);

function QuestionBuilder({ value, onChange }: { value: Question[]; onChange: (q: Question[]) => void }) {
  const { t } = useTranslation();
  const set = (i: number, patch: Partial<Question>) => onChange(value.map((q, j) => (j === i ? { ...q, ...patch } : q)));
  const move = (i: number, d: number) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="grid gap-2">
      {value.map((q, i) => (
        <div key={q.id} className="grid gap-2 rounded-md border border-rule p-2 sm:grid-cols-[1fr_9rem_auto]">
          <Input aria-label={`${t('performance.questionText')} ${i + 1}`} value={q.text} onChange={(e) => set(i, { text: e.target.value })} />
          <Select aria-label={t('common.status')} value={q.type} onChange={(e) => set(i, { type: e.target.value as Question['type'] })}>
            <option value="rating">{t('performance.questionTypes.rating')}</option>
            <option value="text">{t('performance.questionTypes.text')}</option>
          </Select>
          <span className="flex items-center gap-1">
            <label className="mr-1 flex items-center gap-1 text-sm">
              <input type="checkbox" className="size-4 accent-stamp" checked={q.required} onChange={(e) => set(i, { required: e.target.checked })} /> {t('performance.required')}
            </label>
            <Button size="sm" variant="ghost" aria-label="↑" disabled={i === 0} onClick={() => move(i, -1)}>
              <ArrowUp size={14} />
            </Button>
            <Button size="sm" variant="ghost" aria-label="↓" disabled={i === value.length - 1} onClick={() => move(i, 1)}>
              <ArrowDown size={14} />
            </Button>
            <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </Button>
          </span>
        </div>
      ))}
      <Button size="sm" className="justify-self-start" onClick={() => onChange([...value, { id: newId(), type: 'rating', text: '', required: true }])}>
        <Plus size={14} /> {t('performance.addQuestion')}
      </Button>
    </div>
  );
}

function CycleForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const defaults = t('performance.defaultQuestions', { returnObjects: true }) as string[];
  const year = new Date().getFullYear();
  const [f, setF] = useState({
    name: `${t('performance.reviews')} ${year}`,
    periodStart: `${year}-01-01`,
    periodEnd: `${year}-12-31`,
    dueDate: '',
    selfReview: true,
    managerReview: true,
    peerReview: false,
    orgUnitId: '',
    questions: defaults.map((text, i) => ({ id: `q${i + 1}`, type: (i === 0 ? 'rating' : 'text') as Question['type'], text, required: i < 2 })),
  });
  const save = useMutation({
    mutationFn: () => api.post('/review-cycles', { ...f, dueDate: f.dueDate || null, orgUnitId: f.orgUnitId || null, questions: f.questions.filter((q) => q.text.trim()) }),
    onSuccess: () => {
      toast(t('common.created'));
      qc.invalidateQueries({ queryKey: ['review-cycles'] });
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('performance.newCycle')}
      footer={
        <Button variant="primary" busy={save.isPending} disabled={!f.name.trim()} onClick={() => save.mutate()}>
          {t('common.create')}
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label={t('performance.cycleName')}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('performance.periodStart')}>
            <Input type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} />
          </Field>
          <Field label={t('performance.periodEnd')}>
            <Input type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} />
          </Field>
          <Field label={`${t('performance.dueDate')} (${t('common.optional')})`}>
            <Input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
          </Field>
        </div>
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-semibold">{t('performance.steps')}</legend>
          <Checkbox label={t('performance.types.self')} checked={f.selfReview} onChange={(v) => setF({ ...f, selfReview: v })} />
          <Checkbox label={t('performance.types.manager')} checked={f.managerReview} onChange={(v) => setF({ ...f, managerReview: v })} />
          <Checkbox label={t('performance.types.peer')} hint={t('performance.peerHidden')} checked={f.peerReview} onChange={(v) => setF({ ...f, peerReview: v })} />
        </fieldset>
        <Field label={t('performance.participants')}>
          <Select value={f.orgUnitId} onChange={(e) => setF({ ...f, orgUnitId: e.target.value })}>
            <option value="">{t('performance.allEmployees')}</option>
            {(units.data?.items ?? []).map((u: any) => (
              <option key={u.id} value={u.id}>
                {t('performance.orgUnit')}: {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <p className="mb-2 text-sm font-semibold">{t('performance.questions')}</p>
          <QuestionBuilder value={f.questions} onChange={(questions) => setF({ ...f, questions })} />
        </div>
      </div>
    </Dialog>
  );
}

const statusTone = (s: string | null) => (s === 'submitted' ? 'text-grant' : s === 'pending' ? 'text-wait' : 'text-ink-faint');

function CycleDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['review-cycle', id], queryFn: () => api.get(`/review-cycles/${id}`) });
  const [results, setResults] = useState<any>(null);
  const [peers, setPeers] = useState<any>(null);
  const act = useMutation({
    mutationFn: (action: 'start' | 'close') => api.post(`/review-cycles/${id}/${action}`),
    onSuccess: (_r, action) => {
      toast(action === 'start' ? t('performance.started') : t('common.saved'));
      qc.invalidateQueries({ queryKey: ['review-cycle', id] });
      qc.invalidateQueries({ queryKey: ['review-cycles'] });
      qc.invalidateQueries({ queryKey: ['reviews-mine'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (q.isLoading) return <Spinner />;
  const c = q.data;
  const pct = c.progress.total ? Math.round((c.progress.submitted / c.progress.total) * 100) : 0;
  const cell = (s: string | null) => (s ? <span className={cx('stamp', statusTone(s))}>{t(`performance.reviewStatus.${s}`)}</span> : <span className="text-ink-faint">–</span>);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button variant="ghost" onClick={onBack}>
          ← {t('common.back')}
        </Button>
        <span className="flex gap-2">
          {c.status === 'draft' && (
            <Button variant="primary" busy={act.isPending} onClick={() => confirm(t('performance.startConfirm')) && act.mutate('start')}>
              {t('performance.start')}
            </Button>
          )}
          {c.status === 'active' && (
            <Button busy={act.isPending} onClick={() => confirm(t('performance.closeConfirm')) && act.mutate('close')}>
              {t('performance.close')}
            </Button>
          )}
        </span>
      </div>
      <Section title={c.name}>
        <dl className="grid gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-soft">{t('common.status')}</dt>
            <dd className="font-semibold">{t(`performance.statuses.${c.status}`)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('performance.periodStart')}</dt>
            <dd className="font-semibold">
              {fmtDate(c.periodStart)} – {fmtDate(c.periodEnd)}
            </dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('performance.dueDate')}</dt>
            <dd className="font-semibold">{fmtDate(c.dueDate)}</dd>
          </div>
          <div>
            <dt className="text-ink-soft">{t('performance.progress')}</dt>
            <dd className="tnum font-semibold">
              {c.progress.submitted} / {c.progress.total} ({pct} %)
            </dd>
            <div className="mt-1 h-1.5 rounded-full bg-rule-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('performance.progress')}>
              <div className="h-1.5 rounded-full bg-grant" style={{ width: `${pct}%` }} />
            </div>
          </div>
        </dl>
      </Section>
      {c.status === 'draft' ? (
        <Section title={t('performance.questions')}>
          <ol className="list-decimal pl-5">
            {c.questions.map((qq: Question) => (
              <li key={qq.id}>
                {qq.text} <span className="text-sm text-ink-faint">({t(`performance.questionTypes.${qq.type}`)})</span>
              </li>
            ))}
          </ol>
        </Section>
      ) : (
        <Section title={t('performance.participants')}>
          <Table head={[t('common.name'), t('performance.types.self'), t('performance.types.manager'), t('performance.types.peer'), t('performance.released'), '']}>
            {c.participants.map((p: any) => (
              <tr key={p.person.id}>
                <td className="font-semibold">{fullName(p.person)}</td>
                <td>{cell(p.self)}</td>
                <td>{cell(p.manager)}</td>
                <td className="tnum">{c.peerReview ? `${p.peers.submitted} / ${p.peers.total}` : '–'}</td>
                <td>{p.released ? <span className="stamp text-grant">{t('common.yes')}</span> : <span className="text-ink-faint">{t('common.no')}</span>}</td>
                <td className="text-right whitespace-nowrap">
                  {c.peerReview && c.status === 'active' && (
                    <Button size="sm" variant="ghost" onClick={() => setPeers(p.person)}>
                      {t('performance.assignPeers')}
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setResults(p.person)}>
                    {t('performance.results')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
      {results && (
        <Dialog open wide onClose={() => setResults(null)} title={`${t('performance.results')}: ${fullName(results)}`}>
          <ReviewResults cycleId={id} personId={results.id} />
        </Dialog>
      )}
      {peers && <AssignPeersDialog cycleId={id} reviewee={peers} onClose={() => setPeers(null)} />}
    </div>
  );
}

function Cycles() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['review-cycles'], queryFn: () => api.get('/review-cycles') });
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  if (detail) return <CycleDetail id={detail} onBack={() => setDetail(null)} />;
  return (
    <Section
      title={t('performance.tabs.cycles')}
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} /> {t('performance.newCycle')}
        </Button>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <Empty>{t('performance.noCyclesAdmin')}</Empty>
      ) : (
        <Table head={[t('common.name'), t('performance.periodStart'), t('performance.dueDate'), t('common.status')]}>
          {q.data.items.map((c: any) => (
            <tr key={c.id} className="cursor-pointer hover:bg-rule-soft" onClick={() => setDetail(c.id)}>
              <td>
                <button type="button" className="font-semibold text-stamp hover:underline" onClick={() => setDetail(c.id)}>
                  {c.name}
                </button>
              </td>
              <td className="tnum">
                {fmtDate(c.periodStart)} – {fmtDate(c.periodEnd)}
              </td>
              <td className="tnum">{fmtDate(c.dueDate)}</td>
              <td>
                <span className={cx('stamp', c.status === 'active' ? 'text-wait' : c.status === 'closed' ? 'text-grant' : 'text-ink-faint')}>{t(`performance.statuses.${c.status}`)}</span>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {creating && <CycleForm onClose={() => setCreating(false)} />}
    </Section>
  );
}

export function PerformancePage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const [params, setParams] = useSearchParams();
  const manage = can('performance.manage');
  const tab = (params.get('tab') as Tab) ?? (me?.personId ? 'todo' : 'cycles');
  const setTab = (v: Tab) => setParams({ tab: v }, { replace: true });
  const personal = !!me?.personId;
  return (
    <>
      <PageHeader title={t('performance.title')} />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'todo', label: t('performance.tabs.todo'), hidden: !personal },
          { value: 'results', label: t('performance.tabs.results'), hidden: !personal },
          { value: 'goals', label: t('performance.tabs.goals'), hidden: !personal },
          { value: 'feedback', label: t('performance.tabs.feedback'), hidden: !personal },
          { value: 'cycles', label: t('performance.tabs.cycles'), hidden: !manage },
        ]}
      />
      <div className="mt-5">
        {tab === 'todo' && personal && <ToWrite />}
        {tab === 'results' && personal && <MyResults personId={me!.personId!} />}
        {tab === 'goals' && personal && <GoalsSection personId={me!.personId!} editable={false} />}
        {tab === 'feedback' && personal && <FeedbackSection personId={me!.personId!} />}
        {tab === 'cycles' && manage && <Cycles />}
      </div>
    </>
  );
}
