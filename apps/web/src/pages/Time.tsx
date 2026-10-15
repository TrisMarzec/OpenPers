import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { addDaysISO, fmtDate, fmtDay, fmtMinutes, fmtTime, startOfWeek, todayISO } from '../lib/format';
import { PunchCard } from '../components/PunchCard';
import { AttendanceList } from '../components/AttendanceList';
import { TeamTimes } from '../components/TeamTimes';
import { Button, cx, Dialog, Field, Input, PageHeader, Section, Select, Stamp, Tabs, Textarea, useErrorText, useToast } from '../components/ui';

interface Entry {
  id: string;
  personId: string;
  date: string;
  type: 'WORK' | 'BREAK';
  startAt: string;
  endAt: string | null;
  projectId: string | null;
  comment: string | null;
  status: string;
}

function EntryDialog({ open, onClose, personId, date, entry }: { open: boolean; onClose: () => void; personId: string; date: string; entry?: Entry | null }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get('/projects'), enabled: open });
  const [form, setForm] = useState(() => ({
    date: entry?.date ?? date,
    type: entry?.type ?? 'WORK',
    start: entry ? fmtTime(entry.startAt) : '09:00',
    end: entry?.endAt ? fmtTime(entry.endAt) : '17:00',
    projectId: entry?.projectId ?? '',
    comment: entry?.comment ?? '',
  }));
  const save = useMutation({
    mutationFn: () => {
      const endDate = form.end <= form.start ? addDaysISO(form.date, 1) : form.date;
      const body = { type: form.type, startAt: `${form.date}T${form.start}`, endAt: `${endDate}T${form.end}`, projectId: form.type === 'WORK' && form.projectId ? form.projectId : null, comment: form.comment || null };
      return entry ? api.patch(`/attendance/${entry.id}`, body) : api.post('/attendance', { ...body, personId });
    },
    onSuccess: (res: any) => {
      toast(t('time.saved'));
      for (const w of res.warnings ?? []) toast(t(`time.warnings.${w.code}`), 'error');
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['time-balance'] });
      onClose();
    },
    onError: (e) => toast(e instanceof ApiError && e.status === 409 ? t('time.overlap') : errText(e), 'error'),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('time.addEntry')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('common.date')}>
            <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label={t('time.entryType')}>
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as 'WORK' | 'BREAK' })}>
              <option value="WORK">{t('time.WORK')}</option>
              <option value="BREAK">{t('time.BREAK')}</option>
            </Select>
          </Field>
          <Field label={t('time.start')}>
            <Input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
          </Field>
          <Field label={t('time.end')}>
            <Input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} />
          </Field>
        </div>
        {form.type === 'WORK' && (projects.data?.items ?? []).length > 0 && (
          <Field label={t('time.project')}>
            <Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">{t('time.noProject')}</option>
              {projects.data.items
                .filter((p: any) => p.status === 'ACTIVE')
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {p.code ? `${p.code} – ` : ''}
                    {p.name}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={`${t('common.comment')} (${t('common.optional')})`}>
          <Textarea rows={2} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function TimeWeek({ personId, editable }: { personId: string; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [week, setWeek] = useState(() => startOfWeek(todayISO()));
  const [dialog, setDialog] = useState<{ date: string; entry?: Entry | null } | null>(null);
  const end = addDaysISO(week, 6);
  const q = useQuery({ queryKey: ['attendance', personId, week, end], queryFn: () => api.get<{ items: Entry[]; days: any[] }>(`/attendance?personId=${personId}&from=${week}&to=${end}`) });
  const balance = useQuery({ queryKey: ['time-balance', personId], queryFn: () => api.get(`/persons/${personId}/time-balance`) });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/attendance/${id}`),
    onSuccess: () => {
      toast(t('common.deleted'));
      qc.invalidateQueries({ queryKey: ['attendance'] });
      qc.invalidateQueries({ queryKey: ['time-balance'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(week, i));
  const weekTotal = (q.data?.days ?? []).reduce((s, d) => s + d.workedMinutes, 0);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-label={t('common.previous')} onClick={() => setWeek(addDaysISO(week, -7))}>
          <ChevronLeft size={18} />
        </Button>
        <h2 className="tnum min-w-52 text-center font-bold">
          {fmtDate(week)} – {fmtDate(end)}
        </h2>
        <Button size="sm" variant="ghost" aria-label={t('common.next')} onClick={() => setWeek(addDaysISO(week, 7))}>
          <ChevronRight size={18} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setWeek(startOfWeek(todayISO()))}>
          {t('common.today')}
        </Button>
        <div className="ml-auto flex gap-6 text-sm">
          <span>
            {t('time.weekTotal')}: <strong className="tnum">{fmtMinutes(weekTotal)}</strong>
          </span>
          {balance.data && (
            <span>
              {t('time.balance')}: <strong className={cx('tnum', balance.data.balanceMinutes < 0 && 'text-refuse')}>{fmtMinutes(balance.data.balanceMinutes, true)}</strong>
            </span>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-md border border-rule bg-sheet">
        {days.map((d) => {
          const entries = (q.data?.items ?? []).filter((e) => e.date === d);
          const summary = q.data?.days.find((x) => x.date === d);
          return (
            <div key={d} className={cx('grid gap-2 border-b border-rule-soft px-4 py-3 last:border-0 sm:grid-cols-[9rem_1fr_auto]', d === todayISO() && 'bg-stamp-wash/40')}>
              <div className="font-semibold">{fmtDay(d)}</div>
              <div className="grid gap-1">
                {entries.length === 0 && <span className="text-sm text-ink-faint">–</span>}
                {entries.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={cx('tnum font-semibold', e.type === 'BREAK' && 'text-ink-faint')}>
                      {fmtTime(e.startAt)} – {e.endAt ? fmtTime(e.endAt) : t('time.running')}
                    </span>
                    {e.type === 'BREAK' && <span className="text-ink-faint">{t('time.BREAK')}</span>}
                    {e.comment && <span className="text-ink-faint">{e.comment}</span>}
                    {e.status !== 'approved' && <Stamp status={e.status} />}
                    {editable && e.endAt && (
                      <span className="flex gap-0.5">
                        <button type="button" aria-label={t('common.edit')} className="rounded p-1 text-ink-faint hover:bg-rule-soft hover:text-ink" onClick={() => setDialog({ date: d, entry: e })}>
                          <Pencil size={14} />
                        </button>
                        <button type="button" aria-label={t('common.delete')} className="rounded p-1 text-ink-faint hover:bg-refuse-wash hover:text-refuse" onClick={() => confirm(t('common.confirmDelete')) && del.mutate(e.id)}>
                          <Trash2 size={14} />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
                {summary?.warnings.map((w: any) => (
                  <span key={w.code} className="flex items-center gap-1 text-sm font-semibold text-wait">
                    <TriangleAlert size={14} aria-hidden /> {t(`time.warnings.${w.code}`)}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-3 sm:justify-end">
                {summary && <span className="tnum font-bold">{fmtMinutes(summary.workedMinutes)}</span>}
                {editable && (
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ date: d })}>
                    {t('common.add')}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {dialog && <EntryDialog open onClose={() => setDialog(null)} personId={personId} date={dialog.date} entry={dialog.entry} />}
    </div>
  );
}

function TimeApprovals() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['attendance-approvals'], queryFn: () => api.get('/attendance-approvals') });
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get('/directory') });
  const approve = useMutation({
    mutationFn: (id: string) => api.post(`/attendance/${id}/approve`),
    onSuccess: () => {
      toast(t('status.approved'));
      qc.invalidateQueries({ queryKey: ['attendance-approvals'] });
    },
  });
  if (!q.data?.items.length) return <p className="text-ink-soft">{t('time.noApprovals')}</p>;
  const name = (id: string) => {
    const p = dir.data?.items.find((x: any) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : '–';
  };
  return (
    <Section>
      <ul>
        {q.data.items.map((e: Entry) => (
          <li key={e.id} className="flex flex-wrap items-center gap-3 border-b border-rule-soft py-2 last:border-0">
            <span className="min-w-40 font-semibold">{name(e.personId)}</span>
            <span className="tnum">
              {fmtDay(e.date)} {fmtTime(e.startAt)} – {fmtTime(e.endAt)}
            </span>
            <Button size="sm" variant="primary" className="ml-auto" onClick={() => approve.mutate(e.id)}>
              {t('time.approve')}
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function TimePage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  // The team view is for anyone who may see more than their own times (managers, HR).
  const seesTeam = (me?.permissions['time.read'] ?? []).some((s) => s !== 'self');
  const [tab, setTab] = useState<'list' | 'week' | 'team' | 'approvals'>(me?.personId ? 'list' : seesTeam ? 'team' : 'approvals');
  return (
    <div>
      <PageHeader title={t('time.title')} />
      <Tabs value={tab} onChange={setTab} items={[{ value: 'list', label: t('time.tabs.list'), hidden: !me?.personId }, { value: 'week', label: t('time.tabs.week'), hidden: !me?.personId }, { value: 'team', label: t('time.tabs.team'), hidden: !seesTeam }, { value: 'approvals', label: t('time.tabs.approvals'), hidden: !can('time.approve') }]} />
      {tab === 'week' && me?.personId && (
        <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
          <TimeWeek personId={me.personId} editable={can('time.track')} />
          <div className="order-first xl:order-last">
            <PunchCard />
          </div>
        </div>
      )}
      {tab === 'list' && me?.personId && <AttendanceList personId={me.personId} editable={can('time.track')} />}
      {tab === 'team' && <TeamTimes />}
      {tab === 'approvals' && <TimeApprovals />}
    </div>
  );
}
