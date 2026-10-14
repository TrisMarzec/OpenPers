import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtNumber, fmtRange, fullName, parseISO, toISO, todayISO } from '../lib/format';
import { AbsenceDialog } from '../components/AbsenceDialog';
import { Button, cx, Empty, PageHeader, Spinner, Stamp, Swatch, Table, Tabs, useErrorText, useToast } from '../components/ui';

export function BalanceTable({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const year = new Date().getFullYear();
  const q = useQuery({ queryKey: ['balances', personId, year], queryFn: () => api.get(`/persons/${personId}/balances?year=${year}`) });
  if (!q.data?.items.length) return null;
  return (
    <Table head={[t('absence.type'), t('absence.entitlement'), t('absence.carryover'), t('absence.expired'), t('absence.taken'), t('absence.pendingLabel'), t('absence.available')]} className="mb-5">
      {q.data.items.map((b: any) => (
        <tr key={b.typeId} className="tnum">
          <td className="font-semibold">
            {b.typeName} {year}
          </td>
          <td>{fmtNumber(b.entitlement)}</td>
          <td>{fmtNumber(b.carryover)}</td>
          <td>{fmtNumber(b.carryoverExpired)}</td>
          <td>{fmtNumber(b.taken)}</td>
          <td>{fmtNumber(b.pending)}</td>
          <td className="font-bold">{fmtNumber(b.available)}</td>
        </tr>
      ))}
    </Table>
  );
}

export function AbsenceList({ personId, canManage }: { personId: string; canManage?: boolean }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['absences', personId], queryFn: () => api.get(`/absence-periods?personId=${personId}`) });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/absence-periods/${id}/cancel`),
    onSuccess: () => {
      toast(t('absence.cancelledMsg'));
      qc.invalidateQueries({ queryKey: ['absences'] });
      qc.invalidateQueries({ queryKey: ['balances'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.items.length) return <Empty>{t('absence.empty')}</Empty>;
  const today = todayISO();
  return (
    <Table head={[t('absence.type'), t('common.date'), t('absence.days'), t('common.status'), '']}>
      {q.data.items.map((a: any) => {
        const cancellable = ['pending', 'approved'].includes(a.status) && (canManage || (a.personId === me?.personId && (a.status === 'pending' || a.startDate > today)));
        return (
          <tr key={a.id}>
            <td>
              <span className="flex items-center gap-2 font-semibold">
                <Swatch color={a.typeColor} /> {a.typeName}
              </span>
              {a.comment && <span className="block text-sm text-ink-faint">{a.comment}</span>}
            </td>
            <td className="tnum">{fmtRange(a.startDate, a.endDate)}</td>
            <td className="tnum">{fmtNumber(a.days)}</td>
            <td>
              <Stamp status={a.status} />
            </td>
            <td className="text-right">
              {cancellable && (
                <Button size="sm" variant="ghost" onClick={() => cancel.mutate(a.id)}>
                  {t('absence.cancelRequest')}
                </Button>
              )}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

export function ApprovalList({ emptyText, compact }: { emptyText?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['absence-approvals'], queryFn: () => api.get('/absence-approvals') });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => api.post(`/absence-periods/${id}/${action}`),
    onSuccess: (_d, v) => {
      toast(v.action === 'approve' ? t('absence.approved') : t('absence.rejected'));
      qc.invalidateQueries({ queryKey: ['absence-approvals'] });
      qc.invalidateQueries({ queryKey: ['absence-calendar'] });
      qc.invalidateQueries({ queryKey: ['absences'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.items.length) return <p className="text-ink-soft">{emptyText ?? t('absence.noApprovals')}</p>;
  return (
    <ul className="grid gap-0">
      {q.data.items.map((a: any) => (
        <li key={a.id} className={cx('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule-soft py-2.5 last:border-0', !compact && 'px-1')}>
          <div className="min-w-48 flex-1">
            <div className="font-semibold">{fullName(a.person)}</div>
            <div className="flex items-center gap-2 text-sm text-ink-soft">
              <Swatch color={a.typeColor} /> {a.typeName} · <span className="tnum">{fmtRange(a.startDate, a.endDate)}</span> · {t('common.days', { count: a.days })}
            </div>
            {a.comment && <div className="text-sm text-ink-faint">„{a.comment}“</div>}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" onClick={() => decide.mutate({ id: a.id, action: 'reject' })}>
              {t('absence.reject')}
            </Button>
            <Button size="sm" variant="primary" onClick={() => decide.mutate({ id: a.id, action: 'approve' })}>
              {t('absence.approve')}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Month grid: one row per person, one column per day; absences are inked into the cells. */
export function TeamCalendar() {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const first = `${month}-01`;
  const days = useMemo(() => {
    const d = parseISO(first);
    const out: string[] = [];
    while (toISO(d).startsWith(month)) {
      out.push(toISO(d));
      d.setDate(d.getDate() + 1);
    }
    return out;
  }, [month, first]);
  const last = days[days.length - 1];
  const year = Number(month.slice(0, 4));
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get('/directory') });
  const cal = useQuery({ queryKey: ['absence-calendar', first, last], queryFn: () => api.get(`/absence-calendar?from=${first}&to=${last}`) });
  const hol = useQuery({ queryKey: ['holidays', year], queryFn: () => api.get(`/holidays?year=${year}`) });
  const holidays = new Map<string, string>((hol.data?.items ?? []).map((h: any) => [h.date, h.name]));
  const today = todayISO();
  const shift = (n: number) => {
    const d = parseISO(first);
    d.setMonth(d.getMonth() + n);
    setMonth(toISO(d).slice(0, 7));
  };
  const label = parseISO(first).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric' });
  const people = dir.data?.items ?? [];

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Button size="sm" variant="ghost" aria-label={t('common.previous')} onClick={() => shift(-1)}>
          <ChevronLeft size={18} />
        </Button>
        <h2 className="min-w-40 text-center text-lg font-bold">{label}</h2>
        <Button size="sm" variant="ghost" aria-label={t('common.next')} onClick={() => shift(1)}>
          <ChevronRight size={18} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMonth(today.slice(0, 7))}>
          {t('common.today')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-rule bg-sheet">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 min-w-44 border-b border-rule bg-sheet px-3 py-2 text-left font-semibold text-ink-soft">{t('absence.person')}</th>
              {days.map((d) => {
                const wd = parseISO(d).getDay();
                const off = wd === 0 || wd === 6 || holidays.has(d);
                return (
                  <th key={d} title={holidays.get(d)} className={cx('tnum w-8 min-w-8 border-b border-l border-rule-soft py-1 text-center font-semibold', off ? 'bg-paper text-ink-faint' : 'text-ink-soft', d === today && 'text-stamp')}>
                    <div>{Number(d.slice(8))}</div>
                    <div className="text-[10px] font-normal">{parseISO(d).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { weekday: 'narrow' })}</div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {people.map((p: any) => {
              const entries = (cal.data?.items ?? []).filter((a: any) => a.personId === p.id);
              return (
                <tr key={p.id}>
                  <td className="sticky left-0 z-10 border-b border-rule-soft bg-sheet px-3 py-1.5 font-semibold whitespace-nowrap">{fullName(p)}</td>
                  {days.map((d) => {
                    const wd = parseISO(d).getDay();
                    const off = wd === 0 || wd === 6 || holidays.has(d);
                    const a = entries.find((e: any) => e.startDate <= d && (!e.endDate || e.endDate >= d));
                    const half = a && ((a.startHalf && a.startDate === d) || (a.endHalf && a.endDate === d));
                    return (
                      <td key={d} className={cx('relative h-9 border-b border-l border-rule-soft p-0', off && 'bg-paper')} title={a ? `${a.typeName}${a.status === 'pending' ? ` (${t('status.pending')})` : ''}` : holidays.get(d)}>
                        {a && !off && (
                          <span
                            className="absolute inset-y-1.5 left-0.5 right-0.5 rounded-[2px]"
                            style={{
                              background: a.status === 'pending' ? `repeating-linear-gradient(135deg, ${a.color}55 0 3px, transparent 3px 6px)` : a.color,
                              border: `1.5px solid ${a.color}`,
                              ...(half ? { right: '50%' } : {}),
                            }}
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 flex items-center gap-2 text-sm text-ink-faint">
        <span className="inline-block h-3 w-5 rounded-[2px] border border-ink-faint" style={{ background: 'repeating-linear-gradient(135deg, #7a849a55 0 3px, transparent 3px 6px)' }} /> {t('status.pending')}
      </p>
    </div>
  );
}

export function AbsencesPage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const [tab, setTab] = useState<'mine' | 'calendar' | 'approvals'>(me?.personId ? 'mine' : 'calendar');
  const [requesting, setRequesting] = useState(false);
  return (
    <div>
      <PageHeader
        title={t('absence.title')}
        actions={
          me?.personId && (
            <Button variant="primary" onClick={() => setRequesting(true)}>
              {t('absence.request')}
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'mine', label: t('absence.tabs.mine'), hidden: !me?.personId },
          { value: 'calendar', label: t('absence.tabs.calendar') },
          { value: 'approvals', label: t('absence.tabs.approvals'), hidden: !can('absence.approve') },
        ]}
      />
      {tab === 'mine' && me?.personId && (
        <>
          <BalanceTable personId={me.personId} />
          <AbsenceList personId={me.personId} />
        </>
      )}
      {tab === 'calendar' && <TeamCalendar />}
      {tab === 'approvals' && <ApprovalList />}
      {me?.personId && <AbsenceDialog open={requesting} onClose={() => setRequesting(false)} />}
    </div>
  );
}
