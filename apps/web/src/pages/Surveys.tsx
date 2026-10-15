import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Lock, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtNumber } from '../lib/format';
import { BarList, ChartCard, ColumnChart } from '../components/Charts';
import { Button, Checkbox, cx, Dialog, Empty, Field, Input, PageHeader, Section, Select, Spinner, Table, Tabs, Textarea, useErrorText, useToast } from '../components/ui';

type QType = 'scale' | 'enps' | 'choice' | 'text';
interface SurveyQuestion {
  id: string;
  type: QType;
  text: string;
  options?: string[];
  required: boolean;
}

const MIN_GROUP = 3;

function ScaleButtons({ min, max, value, onChange, low, high, label }: { min: number; max: number; value?: number; onChange: (v: number) => void; low: string; high: string; label: string }) {
  const steps = Array.from({ length: max - min + 1 }, (_, i) => min + i);
  return (
    <div className="max-w-xl">
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
        {steps.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            onClick={() => onChange(n)}
            className={cx('tnum h-10 min-w-10 flex-1 rounded-[var(--radius-ctl)] border font-bold', value === n ? 'border-stamp bg-stamp text-on-stamp' : 'border-rule bg-sheet text-ink-soft hover:border-ink-faint')}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-ink-faint">
        <span>{low}</span>
        <span>{high}</span>
      </div>
    </div>
  );
}

// ---------- answering ----------

export function SurveyAnswerPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['survey-form', id], queryFn: () => api.get(`/surveys/${id}/form`) });
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const send = useMutation({
    mutationFn: () => api.post(`/surveys/${id}/responses`, { answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v !== '' && v !== undefined)) }),
    onSuccess: () => {
      toast(t('surveys.thanks'));
      qc.invalidateQueries({ queryKey: ['surveys-open'] });
      qc.invalidateQueries({ queryKey: ['survey-form', id] });
      navigate('/surveys');
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <Empty>{t('common.forbidden')}</Empty>;
  const s = q.data;
  const qs: SurveyQuestion[] = s.questions;
  const missing = qs.some((x) => x.required && (answers[x.id] === undefined || answers[x.id] === ''));
  const set = (k: string, v: unknown) => setAnswers((a) => ({ ...a, [k]: v }));
  return (
    <>
      <Link to="/surveys" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-stamp hover:underline">
        <ArrowLeft size={14} aria-hidden /> {t('surveys.title')}
      </Link>
      <PageHeader title={s.title}>{s.closesAt && <span className="text-ink-soft">{t('surveys.closesOn', { date: fmtDate(s.closesAt) })}</span>}</PageHeader>
      <div className="mx-auto grid max-w-3xl gap-5">
        {s.intro && <p className="whitespace-pre-wrap">{s.intro}</p>}
        <p className="flex items-start gap-2 rounded-md border border-rule bg-sheet p-3 text-sm text-ink-soft">
          <Lock size={15} className="mt-0.5 shrink-0" aria-hidden /> {s.anonymous ? t('surveys.anonymousNote') : t('surveys.notAnonymous')}
        </p>
        {s.answered ? (
          <Empty>{t('surveys.alreadyAnswered')}</Empty>
        ) : s.status !== 'open' ? (
          <Empty>{t('surveys.notOpen')}</Empty>
        ) : (
          <>
            <ol className="grid gap-4">
              {qs.map((x, i) => (
                <li key={x.id} className="rounded-md border border-rule bg-sheet p-4">
                  <p className="mb-3 font-semibold">
                    {i + 1}. {x.text}
                    {x.required && <span className="text-refuse"> *</span>}
                  </p>
                  {x.type === 'scale' && <ScaleButtons label={x.text} min={1} max={5} low={t('surveys.scaleLow')} high={t('surveys.scaleHigh')} value={answers[x.id] as number} onChange={(v) => set(x.id, v)} />}
                  {x.type === 'enps' && <ScaleButtons label={x.text} min={0} max={10} low={t('surveys.enpsLow')} high={t('surveys.enpsHigh')} value={answers[x.id] as number} onChange={(v) => set(x.id, v)} />}
                  {x.type === 'choice' && (
                    <div role="radiogroup" aria-label={x.text} className="grid gap-1.5">
                      {(x.options ?? []).map((o) => (
                        <label key={o} className="flex items-center gap-2">
                          <input type="radio" name={x.id} className="size-4 accent-stamp" checked={answers[x.id] === o} onChange={() => set(x.id, o)} /> {o}
                        </label>
                      ))}
                    </div>
                  )}
                  {x.type === 'text' && <Textarea aria-label={x.text} rows={3} maxLength={2000} value={(answers[x.id] as string) ?? ''} onChange={(e) => set(x.id, e.target.value)} />}
                </li>
              ))}
            </ol>
            <Button variant="primary" className="justify-self-end" disabled={missing} busy={send.isPending} onClick={() => send.mutate()}>
              {t('surveys.send')}
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function OpenSurveys() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['surveys-open'], queryFn: () => api.get('/surveys/open') });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.items.length) return <Empty>{t('surveys.noOpen')}</Empty>;
  return (
    <Section>
      <ul className="divide-y divide-rule">
        {q.data.items.map((s: any) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span>
              <span className="font-semibold">{s.title}</span>
              {s.closesAt && <span className="ml-2 text-sm text-ink-faint">{t('surveys.closesOn', { date: fmtDate(s.closesAt) })}</span>}
            </span>
            {s.answered ? (
              <span className="stamp text-grant">{t('surveys.answered')}</span>
            ) : (
              <Link to={`/surveys/${s.id}`} className="rounded-[var(--radius-ctl)] bg-stamp px-3 py-1.5 text-sm font-semibold text-on-stamp">
                {t('surveys.answer')}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---------- management ----------

const newId = () => Math.random().toString(36).slice(2, 10);

function templateOf(t: (k: string, o?: any) => any, key: string) {
  if (key === 'blank') return { title: '', intro: '', questions: [] as SurveyQuestion[] };
  const tpl = t(`surveys.tpl.${key}`, { returnObjects: true }) as { title: string; intro: string; q: string[]; options?: string[] };
  const types: Record<string, QType[]> = { pulse: ['scale', 'scale', 'scale', 'scale', 'text'], enps: ['enps', 'text'], onboarding: ['scale', 'scale', 'choice', 'text'] };
  return {
    title: tpl.title,
    intro: tpl.intro,
    questions: tpl.q.map((text, i) => {
      const type = types[key][i];
      return { id: `q${i + 1}`, type, text, required: type !== 'text', ...(type === 'choice' ? { options: tpl.options } : {}) };
    }),
  };
}

function SurveyForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const [tpl, setTpl] = useState('pulse');
  const [f, setF] = useState({ ...templateOf(t, 'pulse'), anonymous: true, orgUnitId: '', closesAt: '' });
  const setQ = (i: number, patch: Partial<SurveyQuestion>) => setF({ ...f, questions: f.questions.map((q, j) => (j === i ? { ...q, ...patch } : q)) });
  const save = useMutation({
    mutationFn: () =>
      api.post('/surveys', {
        title: f.title,
        intro: f.intro || null,
        anonymous: f.anonymous,
        orgUnitId: f.orgUnitId || null,
        closesAt: f.closesAt || null,
        questions: f.questions.filter((q) => q.text.trim()).map((q) => (q.type === 'choice' ? { ...q, options: (q.options ?? []).filter(Boolean) } : { ...q, options: undefined })),
      }),
    onSuccess: () => {
      toast(t('common.created'));
      qc.invalidateQueries({ queryKey: ['surveys'] });
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('surveys.newSurvey')}
      footer={
        <Button variant="primary" busy={save.isPending} disabled={!f.title.trim() || !f.questions.length} onClick={() => save.mutate()}>
          {t('common.create')}
        </Button>
      }
    >
      <div className="grid gap-4">
        <Field label={t('surveys.fromTemplate')}>
          <Select
            value={tpl}
            onChange={(e) => {
              setTpl(e.target.value);
              setF({ ...f, ...templateOf(t, e.target.value) });
            }}
          >
            {['pulse', 'enps', 'onboarding', 'blank'].map((k) => (
              <option key={k} value={k}>
                {t(`surveys.templates.${k}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('surveys.surveyTitle')}>
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label={`${t('surveys.intro')} (${t('common.optional')})`}>
          <Textarea rows={2} value={f.intro} onChange={(e) => setF({ ...f, intro: e.target.value })} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('surveys.audience')}>
            <Select value={f.orgUnitId} onChange={(e) => setF({ ...f, orgUnitId: e.target.value })}>
              <option value="">{t('surveys.everyone')}</option>
              {(units.data?.items ?? []).map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`${t('surveys.closesAt')} (${t('common.optional')})`}>
            <Input type="date" value={f.closesAt} onChange={(e) => setF({ ...f, closesAt: e.target.value })} />
          </Field>
        </div>
        <Checkbox label={t('surveys.anonymous')} hint={t('surveys.anonymousNote')} checked={f.anonymous} onChange={(v) => setF({ ...f, anonymous: v })} />
        <div>
          <p className="mb-2 text-sm font-semibold">{t('performance.questions')}</p>
          <div className="grid gap-2">
            {f.questions.map((q, i) => (
              <div key={q.id} className="grid gap-2 rounded-md border border-rule p-2">
                <div className="grid gap-2 sm:grid-cols-[1fr_13rem_auto]">
                  <Input aria-label={`${t('performance.questionText')} ${i + 1}`} value={q.text} onChange={(e) => setQ(i, { text: e.target.value })} />
                  <Select aria-label={t('performance.questionText')} value={q.type} onChange={(e) => setQ(i, { type: e.target.value as QType, options: e.target.value === 'choice' ? (q.options ?? ['', '']) : undefined })}>
                    {(['scale', 'enps', 'choice', 'text'] as QType[]).map((k) => (
                      <option key={k} value={k}>
                        {t(`surveys.questionTypes.${k}`)}
                      </option>
                    ))}
                  </Select>
                  <span className="flex items-center gap-1">
                    <label className="mr-1 flex items-center gap-1 text-sm">
                      <input type="checkbox" className="size-4 accent-stamp" checked={q.required} onChange={(e) => setQ(i, { required: e.target.checked })} /> {t('performance.required')}
                    </label>
                    <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => setF({ ...f, questions: f.questions.filter((_, j) => j !== i) })}>
                      <Trash2 size={14} />
                    </Button>
                  </span>
                </div>
                {q.type === 'choice' && (
                  <Field label={t('surveys.options')}>
                    <Textarea rows={3} value={(q.options ?? []).join('\n')} onChange={(e) => setQ(i, { options: e.target.value.split('\n') })} />
                  </Field>
                )}
              </div>
            ))}
            <Button size="sm" className="justify-self-start" onClick={() => setF({ ...f, questions: [...f.questions, { id: newId(), type: 'scale', text: '', required: true }] })}>
              <Plus size={14} /> {t('performance.addQuestion')}
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}

const SERIES = 'var(--color-series-1)';

/** Sequential single-hue wash for heatmap cells; text stays in ink for contrast. */
function heatCell(value: number, min: number, max: number) {
  const share = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return { background: `color-mix(in oklab, ${SERIES} ${Math.round(8 + share * 42)}%, transparent)` };
}

function SurveyResults({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['survey-results', id], queryFn: () => api.get(`/surveys/${id}/results`) });
  if (q.isLoading) return <Spinner />;
  const r = q.data;
  const slug = r.survey.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const numeric = r.questions.filter((x: any) => x.type === 'scale' || x.type === 'enps');
  return (
    <div className="grid gap-5">
      <Button variant="ghost" className="justify-self-start" onClick={onBack}>
        ← {t('common.back')}
      </Button>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          [t('surveys.responses'), r.responses],
          [t('surveys.responseRate'), `${r.responseRate} %`],
          [t('common.status'), t(`surveys.statuses.${r.survey.status}`)],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-md border border-rule bg-sheet p-4">
            <div className="text-sm text-ink-soft">{label}</div>
            <div className="tnum text-2xl font-bold">{value}</div>
          </div>
        ))}
      </div>
      {r.suppressed ? (
        <Empty>{t('surveys.suppressed', { min: r.minGroup })}</Empty>
      ) : (
        <>
          {r.questions.map((x: any) => {
            if (x.type === 'scale') {
              const labels = ['1', '2', '3', '4', '5'];
              return (
                <ChartCard key={x.id} title={`${x.text} · ${t('surveys.average', { value: fmtNumber(x.summary.average) })}`} csv={`${slug}-${x.id}.csv`} table={{ head: [x.text, t('surveys.count')], rows: labels.map((l, i) => [l, x.summary.distribution[i]]) }}>
                  <ColumnChart labels={labels} series={[{ key: x.id, label: t('surveys.count'), color: SERIES, values: x.summary.distribution }]} height={160} />
                </ChartCard>
              );
            }
            if (x.type === 'enps') {
              const groups = [
                [t('surveys.promoters'), x.enps.promoters],
                [t('surveys.passives'), x.enps.passives],
                [t('surveys.detractors'), x.enps.detractors],
              ] as [string, number][];
              return (
                <ChartCard key={x.id} title={x.text} csv={`${slug}-enps.csv`} table={{ head: ['', t('surveys.count')], rows: [...groups, [t('surveys.enpsScore'), x.enps.score]] }}>
                  <div className="grid items-center gap-5 sm:grid-cols-[10rem_1fr]">
                    <div>
                      <div className="text-sm text-ink-soft">{t('surveys.enpsScore')}</div>
                      <div className="tnum text-4xl font-bold">{x.enps.score > 0 ? `+${x.enps.score}` : x.enps.score}</div>
                      <div className="text-xs text-ink-faint">−100 … +100</div>
                    </div>
                    <BarList items={groups.map(([label, value]) => ({ label, value }))} />
                  </div>
                </ChartCard>
              );
            }
            if (x.type === 'choice')
              return (
                <ChartCard key={x.id} title={x.text} csv={`${slug}-${x.id}.csv`} table={{ head: [x.text, t('surveys.count')], rows: x.choices.map((c: any) => [c.option, c.count]) }}>
                  <BarList items={x.choices.map((c: any) => ({ label: c.option, value: c.count }))} />
                </ChartCard>
              );
            return (
              <Section key={x.id} title={x.text}>
                {x.texts.length ? (
                  <>
                    <p className="mb-2 text-xs text-ink-faint">{t('surveys.textAnswers', { count: x.texts.length })}</p>
                    <ul className="grid gap-2">
                      {x.texts.map((txt: string, i: number) => (
                        <li key={i} className="border-l-2 border-rule pl-3 whitespace-pre-wrap">
                          {txt}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-sm text-ink-soft">{t('surveys.noTexts')}</p>
                )}
              </Section>
            );
          })}
          {numeric.length > 0 && (
            <Section title={t('surveys.heatmap')}>
              <p className="mb-3 text-sm text-ink-soft">{t('surveys.heatmapHint', { min: MIN_GROUP })}</p>
              {!r.heatmap.length ? (
                <Empty>{t('surveys.noHeatmap')}</Empty>
              ) : (
                <div className="overflow-x-auto">
                  <Table head={[t('surveys.unit'), t('surveys.responses'), ...numeric.map((x: any) => x.text)]}>
                    {r.heatmap.map((row: any) => (
                      <tr key={row.unit}>
                        <td className="font-semibold">{row.unit}</td>
                        <td className="tnum">{row.responses}</td>
                        {numeric.map((x: any) => {
                          const v = row.values[x.id];
                          return (
                            <td key={x.id} className="tnum text-center font-semibold" style={x.type === 'enps' ? heatCell(v, -100, 100) : heatCell(v, 1, 5)} title={`${row.unit} · ${x.text}: ${v}`}>
                              {x.type === 'enps' ? (v > 0 ? `+${v}` : v) : fmtNumber(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </Table>
                </div>
              )}
            </Section>
          )}
        </>
      )}
    </div>
  );
}

function ManageSurveys() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['surveys'], queryFn: () => api.get('/surveys') });
  const [creating, setCreating] = useState(false);
  const [results, setResults] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'open' | 'close' | 'delete' }) => (action === 'delete' ? api.delete(`/surveys/${id}`) : api.post(`/surveys/${id}/${action}`)),
    onSuccess: (_r, v) => {
      toast(v.action === 'open' ? t('surveys.opened') : v.action === 'delete' ? t('common.deleted') : t('common.saved'));
      qc.invalidateQueries({ queryKey: ['surveys'] });
      qc.invalidateQueries({ queryKey: ['surveys-open'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (results) return <SurveyResults id={results} onBack={() => setResults(null)} />;
  return (
    <Section
      title={t('surveys.tabs.manage')}
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus size={14} /> {t('surveys.newSurvey')}
        </Button>
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <Empty>{t('surveys.noSurveys')}</Empty>
      ) : (
        <Table head={[t('surveys.surveyTitle'), t('common.status'), t('surveys.closesAt'), t('surveys.responses'), '']}>
          {q.data.items.map((s: any) => (
            <tr key={s.id}>
              <td className="font-semibold">
                {s.title} {s.anonymous && <Lock size={12} className="inline text-ink-faint" aria-label={t('surveys.anonymous')} />}
              </td>
              <td>
                <span className={cx('stamp', s.status === 'open' ? 'text-wait' : s.status === 'closed' ? 'text-grant' : 'text-ink-faint')}>{t(`surveys.statuses.${s.status}`)}</span>
              </td>
              <td className="tnum">{fmtDate(s.closesAt)}</td>
              <td className="tnum">{s.audience ? `${s.responses} / ${s.audience}` : s.responses}</td>
              <td className="text-right whitespace-nowrap">
                {s.status === 'draft' && (
                  <Button size="sm" variant="primary" onClick={() => confirm(t('surveys.openConfirm')) && act.mutate({ id: s.id, action: 'open' })}>
                    {t('surveys.open')}
                  </Button>
                )}
                {s.status === 'open' && (
                  <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: s.id, action: 'close' })}>
                    {t('surveys.close')}
                  </Button>
                )}
                {s.status !== 'draft' && (
                  <Button size="sm" variant="ghost" onClick={() => setResults(s.id)}>
                    {t('surveys.results')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => confirm(t('common.confirmDelete')) && act.mutate({ id: s.id, action: 'delete' })}>
                  <Trash2 size={14} />
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {creating && <SurveyForm onClose={() => setCreating(false)} />}
    </Section>
  );
}

export function SurveysPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const manage = can('surveys.manage');
  const tab = (params.get('tab') as 'open' | 'manage') ?? 'open';
  return (
    <>
      <PageHeader title={t('surveys.title')} />
      <Tabs
        value={tab}
        onChange={(v) => setParams({ tab: v }, { replace: true })}
        items={[
          { value: 'open', label: t('surveys.tabs.open') },
          { value: 'manage', label: t('surveys.tabs.manage'), hidden: !manage },
        ]}
      />
      <div className="mt-5">{tab === 'manage' && manage ? <ManageSurveys /> : <OpenSurveys />}</div>
    </>
  );
}
