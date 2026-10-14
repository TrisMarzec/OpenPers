import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Star } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fullName, todayISO } from '../lib/format';
import { Button, cx, Dialog, Field, Input, PageHeader, Select, Spinner, Stamp, Textarea, useErrorText, useToast } from '../components/ui';
import { JobForm, jobPayload } from './Recruiting';

function ApplicationDialog({ id, stages, onClose }: { id: string; stages: any[]; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const navigate = useNavigate();
  const [note, setNote] = useState('');
  const [hiring, setHiring] = useState(false);
  const [hire, setHire] = useState({ startDate: todayISO(), positionTitle: '' });
  const q = useQuery({ queryKey: ['application', id], queryFn: () => api.get(`/applications/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['application', id] });
    qc.invalidateQueries({ queryKey: ['applications'] });
  };
  const move = useMutation({ mutationFn: (stageId: string) => api.post(`/applications/${id}/move`, { stageId }), onSuccess: refresh, onError: (e) => toast(errText(e), 'error') });
  const rate = useMutation({ mutationFn: (rating: number) => api.patch(`/applications/${id}`, { rating }), onSuccess: refresh });
  const addNote = useMutation({
    mutationFn: () => api.post(`/applications/${id}/notes`, { body: note }),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  const doHire = useMutation({
    mutationFn: () => api.post(`/applications/${id}/hire`, { startDate: hire.startDate, positionTitle: hire.positionTitle || undefined }),
    onSuccess: (r) => {
      toast(t('recruiting.hired'));
      refresh();
      navigate(`/people/${r.hiredPersonId}`);
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const a = q.data;
  const stageName = (sid: string) => stages.find((s) => s.id === sid)?.name ?? '–';
  return (
    <Dialog open onClose={onClose} wide title={a ? fullName(a.candidate) : t('common.loading')}>
      {!a ? (
        <Spinner />
      ) : (
        <div className="grid gap-5">
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('recruiting.moveTo')}>
              <Select value={a.stageId} disabled={!can('recruiting.write')} onChange={(e) => move.mutate(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex gap-0.5 pb-2" aria-label={t('recruiting.rating')}>
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" aria-label={`${n}`} onClick={() => rate.mutate(n)} className="p-0.5">
                  <Star size={18} className={n <= (a.rating ?? 0) ? 'fill-wait text-wait' : 'text-rule'} />
                </button>
              ))}
            </div>
            {can('recruiting.write') && can('people.write') && !a.hiredPersonId && (
              <Button variant="primary" className="ml-auto" onClick={() => setHiring(true)}>
                {t('recruiting.hire')}
              </Button>
            )}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-ink-soft">E-Mail</dt>
            <dd>
              <a href={`mailto:${a.candidate.email}`} className="text-stamp hover:underline">
                {a.candidate.email}
              </a>
            </dd>
            {a.candidate.phone && (
              <>
                <dt className="text-ink-soft">{t('careers.phone')}</dt>
                <dd>{a.candidate.phone}</dd>
              </>
            )}
            <dt className="text-ink-soft">{t('recruiting.channel')}</dt>
            <dd>{a.channel}</dd>
            <dt className="text-ink-soft">{t('common.date')}</dt>
            <dd className="tnum">{fmtDate(a.appliedAt.slice(0, 10))}</dd>
          </dl>
          {a.hasCv && (
            <a href={`/api/v1/applications/${a.id}/cv`} className="inline-flex items-center gap-2 font-semibold text-stamp hover:underline">
              <FileText size={16} /> {t('recruiting.cv')}: {a.cvName}
            </a>
          )}
          {a.coverLetter && (
            <div>
              <h3 className="mb-1 font-bold">{t('recruiting.coverLetter')}</h3>
              <p className="max-w-[72ch] whitespace-pre-wrap text-ink-soft">{a.coverLetter}</p>
            </div>
          )}
          <div>
            <h3 className="mb-2 font-bold">{t('recruiting.notes')}</h3>
            <div className="mb-3 flex gap-2">
              <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="min-h-0" />
              <Button disabled={!note.trim()} onClick={() => addNote.mutate()}>
                {t('recruiting.addNote')}
              </Button>
            </div>
            <ul className="grid gap-2">
              {a.notes.map((n: any) => (
                <li key={n.id} className="border-l-2 border-rule pl-3 text-sm">
                  <span className="text-ink-faint">{new Date(n.createdAt).toLocaleString()}</span>
                  <p className="whitespace-pre-wrap">{n.body}</p>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-bold">{t('recruiting.history')}</h3>
            <ol className="grid gap-1 text-sm">
              {a.transitions.map((tr: any) => (
                <li key={tr.id} className="tnum">
                  {new Date(tr.at).toLocaleString()} – {tr.fromStageId ? `${stageName(tr.fromStageId)} → ` : ''}
                  <strong>{stageName(tr.toStageId)}</strong>
                </li>
              ))}
            </ol>
          </div>
          <Dialog
            open={hiring}
            onClose={() => setHiring(false)}
            title={t('recruiting.hireTitle', { name: fullName(a.candidate) })}
            footer={
              <Button variant="primary" busy={doHire.isPending} onClick={() => doHire.mutate()}>
                {t('recruiting.hire')}
              </Button>
            }
          >
            <div className="grid gap-4">
              <Field label={t('people.startDate')}>
                <Input type="date" value={hire.startDate} onChange={(e) => setHire({ ...hire, startDate: e.target.value })} />
              </Field>
              <Field label={t('people.position')}>
                <Input value={hire.positionTitle} placeholder={a.job.title} onChange={(e) => setHire({ ...hire, positionTitle: e.target.value })} />
              </Field>
            </div>
          </Dialog>
        </div>
      )}
    </Dialog>
  );
}

export function JobPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [editing, setEditing] = useState<any>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const job = useQuery({ queryKey: ['job', id], queryFn: () => api.get(`/jobs/${id}`) });
  const stages = useQuery({ queryKey: ['pipeline-stages'], queryFn: () => api.get('/pipeline-stages') });
  const apps = useQuery({ queryKey: ['applications', id], queryFn: () => api.get(`/applications?jobId=${id}`) });
  const update = useMutation({
    mutationFn: (body: any) => api.patch(`/jobs/${id}`, body),
    onSuccess: () => {
      toast(t('common.saved'));
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['job', id] });
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const move = useMutation({
    mutationFn: ({ appId, stageId }: { appId: string; stageId: string }) => api.post(`/applications/${appId}/move`, { stageId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['applications', id] }),
    onError: (e) => toast(errText(e), 'error'),
  });
  if (job.isLoading || stages.isLoading) return <Spinner />;
  const j = job.data;
  const writable = can('recruiting.write');
  const publicUrl = `${location.origin}/careers/${j.slug}`;

  return (
    <div>
      <PageHeader
        title={j.title}
        actions={
          writable && (
            <>
              <Button onClick={() => setEditing({ ...j, hiringTeamUserIds: (j.hiringTeam ?? []).map((m: any) => m.userId) })}>{t('common.edit')}</Button>
              {j.status !== 'published' ? (
                <Button variant="primary" onClick={() => update.mutate({ status: 'published' })}>
                  {t('recruiting.publish')}
                </Button>
              ) : (
                <Button onClick={() => update.mutate({ status: 'closed' })}>{t('recruiting.close')}</Button>
              )}
            </>
          )
        }
      >
        <span className="flex flex-wrap items-center gap-3">
          <Stamp status={j.status} />
          {j.status === 'published' && (
            <a href={publicUrl} target="_blank" rel="noreferrer" className="text-sm text-stamp hover:underline">
              {publicUrl}
            </a>
          )}
        </span>
      </PageHeader>

      <div className="flex gap-3 overflow-x-auto pb-3">
        {stages.data.items.map((s: any) => {
          const items = (apps.data?.items ?? []).filter((a: any) => a.stageId === s.id);
          return (
            <section
              key={s.id}
              aria-label={s.name}
              onDragOver={(e) => writable && e.preventDefault()}
              onDrop={() => {
                if (dragging) move.mutate({ appId: dragging, stageId: s.id });
                setDragging(null);
              }}
              className={cx('flex w-64 shrink-0 flex-col rounded-md border border-rule bg-paper', s.kind === 'rejected' && 'opacity-80')}
            >
              <h2 className="flex items-center justify-between border-b border-rule px-3 py-2 font-bold">
                {s.name} <span className="tnum text-sm text-ink-faint">{items.length}</span>
              </h2>
              <ul className="grid min-h-24 content-start gap-2 p-2">
                {items.map((a: any) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      draggable={writable}
                      onDragStart={() => setDragging(a.id)}
                      onClick={() => setOpen(a.id)}
                      className="w-full rounded-[var(--radius-ctl)] border border-rule bg-sheet p-2.5 text-left hover:border-stamp"
                    >
                      <div className="font-semibold">{fullName(a.candidate)}</div>
                      <div className="flex items-center justify-between text-sm text-ink-faint">
                        <span className="tnum">{fmtDate(a.appliedAt.slice(0, 10))}</span>
                        {a.rating ? <span className="text-wait">{'★'.repeat(a.rating)}</span> : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {open && <ApplicationDialog id={open} stages={stages.data.items} onClose={() => setOpen(null)} />}
      <Dialog
        open={!!editing}
        wide
        onClose={() => setEditing(null)}
        title={t('common.edit')}
        footer={
          <Button variant="primary" busy={update.isPending} onClick={() => update.mutate(jobPayload(editing))}>
            {t('common.save')}
          </Button>
        }
      >
        {editing && <JobForm value={editing} onChange={setEditing} />}
      </Dialog>
    </div>
  );
}
