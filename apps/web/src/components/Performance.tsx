import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Heart, Lock, MessageSquare } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtNumber, fullName } from '../lib/format';
import { Button, cx, Dialog, Empty, Field, Input, Section, Select, Spinner, Textarea, useErrorText, useToast } from './ui';

export interface Question {
  id: string;
  type: 'rating' | 'text';
  text: string;
  required: boolean;
}

/** 1–5 rating as a radio group with labelled ends. */
export function RatingInput({ value, onChange, disabled, label }: { value?: number; onChange: (v: number) => void; disabled?: boolean; label: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="flex gap-1.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            disabled={disabled}
            title={t(`performance.scale.${n}`)}
            onClick={() => onChange(n)}
            className={cx('tnum size-10 rounded-[var(--radius-ctl)] border font-bold', value === n ? 'border-stamp bg-stamp text-on-stamp' : 'border-rule bg-sheet text-ink-soft hover:border-ink-faint', disabled && 'opacity-60')}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="mt-1 flex max-w-[15rem] justify-between text-xs text-ink-faint">
        <span>{t('performance.scale.1')}</span>
        <span>{t('performance.scale.5')}</span>
      </div>
    </div>
  );
}

export function ReviewDialog({ review, onClose }: { review: any; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [answers, setAnswers] = useState<Record<string, unknown>>(review.answers ?? {});
  const locked = review.status === 'submitted' || review.cycle.status !== 'active';
  const save = useMutation({
    mutationFn: (submit: boolean) => api.put(`/reviews/${review.id}`, { answers, submit }),
    onSuccess: (_r, submit) => {
      toast(submit ? t('performance.submitted') : t('performance.draftSaved'));
      qc.invalidateQueries({ queryKey: ['reviews-mine'] });
      if (submit) onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const title = review.type === 'self' ? t('performance.selfReview') : `${t(`performance.types.${review.type}`)}: ${fullName(review.reviewee)}`;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={title}
      footer={
        !locked && (
          <>
            <Button onClick={() => save.mutate(false)} busy={save.isPending}>
              {t('performance.saveDraft')}
            </Button>
            <Button variant="primary" busy={save.isPending} onClick={() => confirm(t('performance.submitConfirm')) && save.mutate(true)}>
              {t('performance.submit')}
            </Button>
          </>
        )
      }
    >
      <p className="mb-4 text-sm text-ink-soft">
        {review.cycle.name}
        {review.cycle.dueDate && ` · ${t('performance.dueBy', { date: fmtDate(review.cycle.dueDate) })}`}
        {review.type === 'peer' && (
          <span className="mt-1 flex items-center gap-1.5">
            <Lock size={13} aria-hidden /> {t('performance.peerAnonymous')}
          </span>
        )}
      </p>
      <ol className="grid gap-5">
        {review.cycle.questions.map((q: Question, i: number) => (
          <li key={q.id}>
            <p className="mb-2 font-semibold">
              {i + 1}. {q.text}
              {q.required && <span className="text-refuse"> *</span>}
            </p>
            {q.type === 'rating' ? (
              <RatingInput label={q.text} value={answers[q.id] as number | undefined} disabled={locked} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />
            ) : (
              <Textarea aria-label={q.text} rows={3} value={(answers[q.id] as string) ?? ''} disabled={locked} onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))} />
            )}
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

function AnswerBlock({ title, questions, answers, empty }: { title: string; questions: Question[]; answers: Record<string, any> | null | undefined; empty: string }) {
  return (
    <div className="rounded-md border border-rule p-3">
      <h4 className="mb-2 font-bold">{title}</h4>
      {!answers || !Object.keys(answers).length ? (
        <p className="text-sm text-ink-soft">{empty}</p>
      ) : (
        <dl className="grid gap-2 text-sm">
          {questions.map((q) => (
            <div key={q.id}>
              <dt className="text-ink-soft">{q.text}</dt>
              <dd className="font-semibold whitespace-pre-wrap">{q.type === 'rating' ? (answers[q.id] ? `${answers[q.id]} / 5` : '–') : (answers[q.id] ?? '–')}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/** Self / manager / anonymous peer results side by side, with release for managers. */
export function ReviewResults({ cycleId, personId }: { cycleId: string; personId: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['review-results', cycleId, personId], queryFn: () => api.get(`/reviews/results?cycleId=${cycleId}&personId=${personId}`) });
  const person = useQuery({ queryKey: ['person', personId], queryFn: () => api.get(`/persons/${personId}`) });
  const release = useMutation({
    mutationFn: () => api.post(`/review-cycles/${cycleId}/release`, { personId }),
    onSuccess: () => {
      toast(t('performance.releasedMsg'));
      qc.invalidateQueries({ queryKey: ['review-results', cycleId, personId] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <p className="text-refuse">{t('common.forbidden')}</p>;
  const r = q.data;
  const qs: Question[] = r.cycle.questions;
  const self = personId === me?.personId;
  const canRelease = !self && person.data?.access?.performance === 'edit';
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className={cx('stamp', r.released ? 'text-grant' : 'text-wait')}>{r.released ? t('performance.released') : t('performance.notReleased')}</span>
        {canRelease && !r.released && (
          <Button variant="primary" size="sm" busy={release.isPending} onClick={() => release.mutate()}>
            {t('performance.release')}
          </Button>
        )}
      </div>
      {self && !r.released && <p className="text-sm text-ink-soft">{t('performance.waitForRelease')}</p>}
      <div className="grid gap-3 lg:grid-cols-3">
        <AnswerBlock title={t('performance.types.self')} questions={qs} answers={r.self?.answers} empty={t('performance.notSubmitted')} />
        {r.manager !== null && <AnswerBlock title={t('performance.types.manager')} questions={qs} answers={r.manager?.status === 'submitted' ? r.manager.answers : null} empty={t('performance.notSubmitted')} />}
        {r.peers && (
          <div className="rounded-md border border-rule p-3">
            <h4 className="mb-2 flex items-center gap-1.5 font-bold">
              {t('performance.types.peer')} <Lock size={13} className="text-ink-faint" aria-label={t('performance.peerAnonymous')} />
            </h4>
            <p className="mb-2 text-xs text-ink-faint">{t('performance.peerCount', { submitted: r.peers.submitted, total: r.peers.total })}</p>
            {!r.peers.visible ? (
              <p className="text-sm text-ink-soft">{t('performance.peerHidden')}</p>
            ) : (
              <dl className="grid gap-2 text-sm">
                {qs.map((qq) => (
                  <div key={qq.id}>
                    <dt className="text-ink-soft">{qq.text}</dt>
                    <dd>{qq.type === 'rating' ? <span className="font-semibold">Ø {fmtNumber(r.peers.answers[qq.id].average)} / 5</span> : <ul className="list-disc pl-4">{r.peers.answers[qq.id].texts.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function GoalsSection({ personId, editable }: { personId: string; editable: boolean }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['goals', personId], queryFn: () => api.get(`/persons/${personId}/goals`) });
  const [form, setForm] = useState<{ title: string; dueDate: string } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['goals', personId] });
  const add = useMutation({ mutationFn: () => api.post(`/persons/${personId}/goals`, { title: form!.title, dueDate: form!.dueDate || null }), onSuccess: () => (setForm(null), refresh()), onError: (e) => toast(errText(e), 'error') });
  const update = useMutation({ mutationFn: ({ id, body }: { id: string; body: any }) => api.patch(`/goals/${id}`, body), onSuccess: refresh, onError: (e) => toast(errText(e), 'error') });
  const own = personId === me?.personId;
  return (
    <Section
      title={t('performance.goals')}
      actions={
        (editable || own) && (
          <Button size="sm" onClick={() => setForm({ title: '', dueDate: '' })}>
            {t('common.add')}
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <Empty>{t('performance.noGoals')}</Empty>
      ) : (
        <ul className="grid gap-3">
          {q.data.items.map((g: any) => (
            <li key={g.id} className="rounded-md border border-rule p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cx('font-semibold', g.status === 'dropped' && 'text-ink-faint line-through')}>{g.title}</span>
                <span className="flex items-center gap-2 text-sm">
                  {g.dueDate && <span className="text-ink-faint">{t('checklists.due', { date: fmtDate(g.dueDate) })}</span>}
                  <Select className="h-8 w-36" aria-label={t('common.status')} disabled={!editable && !own} value={g.status} onChange={(e) => update.mutate({ id: g.id, body: { status: e.target.value, ...(e.target.value === 'achieved' ? { progress: 100 } : {}) } })}>
                    {['open', 'achieved', 'dropped'].map((s) => (
                      <option key={s} value={s}>
                        {t(`performance.goalStatus.${s}`)}
                      </option>
                    ))}
                  </Select>
                </span>
              </div>
              <label className="mt-2 flex items-center gap-3 text-sm">
                <span className="text-ink-soft">{t('performance.progress')}</span>
                <input type="range" min={0} max={100} step={10} className="flex-1 accent-[var(--color-grant)]" disabled={!editable && !own} defaultValue={g.progress} onMouseUp={(e) => update.mutate({ id: g.id, body: { progress: Number((e.target as HTMLInputElement).value) } })} onKeyUp={(e) => update.mutate({ id: g.id, body: { progress: Number((e.target as HTMLInputElement).value) } })} />
                <span className="tnum w-10 text-right font-semibold">{g.progress} %</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={t('performance.newGoal')}
        footer={
          <Button variant="primary" busy={add.isPending} disabled={!form?.title} onClick={() => add.mutate()}>
            {t('common.save')}
          </Button>
        }
      >
        {form && (
          <div className="grid gap-4">
            <Field label={t('performance.goalTitle')}>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
            <Field label={`${t('performance.goalDue')} (${t('common.optional')})`}>
              <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </Section>
  );
}

/** Give praise or confidential feedback; without `personId` a colleague is picked first. */
export function GiveFeedbackDialog({ personId, onClose }: { personId?: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [target, setTarget] = useState(personId ?? '');
  const [form, setForm] = useState<{ kind: 'praise' | 'private'; text: string }>({ kind: 'praise', text: '' });
  const people = useQuery({ queryKey: ['persons', 'peer-pick'], queryFn: () => api.get('/persons?limit=200'), enabled: !personId });
  const give = useMutation({
    mutationFn: () => api.post(`/persons/${target}/feedback`, form),
    onSuccess: () => {
      toast(t('performance.feedbackSent'));
      qc.invalidateQueries({ queryKey: ['feedback', target] });
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('performance.giveFeedback')}
      footer={
        <Button variant="primary" busy={give.isPending} disabled={!target || !form.text.trim()} onClick={() => give.mutate()}>
          {t('performance.send')}
        </Button>
      }
    >
      <div className="grid gap-4">
        {!personId && (
          <Field label={t('performance.pickPerson')}>
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">–</option>
              {(people.data?.items ?? [])
                .filter((p: any) => p.id !== me?.personId)
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={t('performance.feedbackKind')}>
          <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as 'praise' | 'private' })}>
            <option value="praise">{t('performance.feedbackKinds.praise')}</option>
            <option value="private">{t('performance.feedbackKinds.private')}</option>
          </Select>
        </Field>
        <p className="text-sm text-ink-soft">{t(`performance.feedbackKindHint.${form.kind}`)}</p>
        <Field label={t('performance.feedbackText')}>
          <Textarea rows={4} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function FeedbackSection({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const own = personId === me?.personId;
  const q = useQuery({ queryKey: ['feedback', personId], queryFn: () => api.get(`/persons/${personId}/feedback`) });
  const [giving, setGiving] = useState(false);
  return (
    <Section
      title={t('performance.feedback')}
      actions={
        <Button size="sm" onClick={() => setGiving(true)}>
          {t('performance.giveFeedback')}
        </Button>
      }
    >
      {!q.data?.items.length ? (
        <Empty>{t('performance.noFeedback')}</Empty>
      ) : (
        <ul className="grid gap-3">
          {q.data.items.map((f: any) => (
            <li key={f.id} className="border-l-2 border-rule pl-3">
              <div className="flex items-center gap-2 text-xs text-ink-faint">
                {f.kind === 'praise' ? <Heart size={13} className="text-refuse" aria-hidden /> : <MessageSquare size={13} aria-hidden />}
                {t(`performance.feedbackLabels.${f.kind}`)} · {f.author ? fullName(f.author) : '–'} · {fmtDate(f.createdAt)}
              </div>
              <p className="whitespace-pre-wrap">{f.text}</p>
            </li>
          ))}
        </ul>
      )}
      {giving && <GiveFeedbackDialog personId={own ? undefined : personId} onClose={() => setGiving(false)} />}
    </Section>
  );
}

/** Performance tab in a profile: goals, feedback and results per cycle. */
export function PersonPerformance({ person }: { person: any }) {
  const { t } = useTranslation();
  const cycles = useQuery({ queryKey: ['person-cycles', person.id], queryFn: () => api.get(`/persons/${person.id}/review-cycles`) });
  const [cycleId, setCycleId] = useState<string>('');
  const [peers, setPeers] = useState(false);
  const { me } = useAuth();
  const selected = cycleId || cycles.data?.items[0]?.id;
  const cycle = cycles.data?.items.find((c: any) => c.id === selected);
  const canAssign = cycle?.status === 'active' && cycle.peerReview && person.id !== me?.personId && person.access?.performance === 'edit';
  return (
    <div className="grid gap-5">
      <Section
        title={t('performance.reviews')}
        actions={
          <span className="flex flex-wrap gap-2">
            {canAssign && (
              <Button size="sm" onClick={() => setPeers(true)}>
                {t('performance.assignPeers')}
              </Button>
            )}
            {(cycles.data?.items ?? []).length > 1 && (
              <Select className="h-8 w-56" value={selected} aria-label={t('performance.cycle')} onChange={(e) => setCycleId(e.target.value)}>
                {cycles.data.items.map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </span>
        }
      >
        {selected ? <ReviewResults cycleId={selected} personId={person.id} /> : <Empty>{t('performance.noCycles')}</Empty>}
        {peers && selected && <AssignPeersDialog cycleId={selected} reviewee={person} onClose={() => setPeers(false)} />}
      </Section>
      <div className="grid gap-5 lg:grid-cols-2">
        <GoalsSection personId={person.id} editable={person.access?.performance === 'edit'} />
        <FeedbackSection personId={person.id} />
      </div>
    </div>
  );
}

/** Pick colleagues as peer reviewers for one reviewee. */
export function AssignPeersDialog({ cycleId, reviewee, onClose }: { cycleId: string; reviewee: { id: string; firstName: string; lastName: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const people = useQuery({ queryKey: ['persons', 'peer-pick'], queryFn: () => api.get('/persons?limit=200') });
  const save = useMutation({
    mutationFn: () => api.post<{ added: number }>(`/review-cycles/${cycleId}/peers`, { revieweeId: reviewee.id, reviewerPersonIds: picked }),
    onSuccess: (r) => {
      toast(t('performance.peersAdded', { count: r.added }));
      qc.invalidateQueries({ queryKey: ['review-cycle', cycleId] });
      qc.invalidateQueries({ queryKey: ['review-results', cycleId, reviewee.id] });
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const list = (people.data?.items ?? []).filter((p: any) => p.id !== reviewee.id && fullName(p).toLowerCase().includes(search.toLowerCase()));
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('performance.assignPeersFor', { name: fullName(reviewee) })}
      footer={
        <Button variant="primary" disabled={!picked.length} busy={save.isPending} onClick={() => save.mutate()}>
          {t('performance.assignPeers')} ({picked.length})
        </Button>
      }
    >
      <Input type="search" placeholder={t('common.search')} aria-label={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3" />
      <p className="mb-2 flex items-center gap-1.5 text-sm text-ink-soft">
        <Lock size={13} aria-hidden /> {t('performance.peerHidden')}
      </p>
      <ul className="grid max-h-72 gap-1 overflow-y-auto">
        {list.map((p: any) => (
          <li key={p.id}>
            <label className="flex items-center gap-2 rounded px-1 py-1 hover:bg-rule-soft">
              <input type="checkbox" className="size-4 accent-stamp" checked={picked.includes(p.id)} disabled={!picked.includes(p.id) && picked.length >= 10} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
              {fullName(p)}
            </label>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
