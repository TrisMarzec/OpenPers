import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDate, fmtMinutes, fmtTime, todayISO } from '../lib/format';
import { Button, useErrorText, useToast } from './ui';

interface Period {
  id: string;
  type: 'WORK' | 'BREAK';
  startAt: string;
  endAt: string | null;
}

const minutesOf = (p: Period, now: Date) => {
  const start = new Date(p.startAt).getTime();
  const end = p.endAt ? new Date(p.endAt).getTime() : now.getTime();
  return Math.max(0, (end - start) / 60_000);
};

/**
 * The clock widget, drawn as a punched time card: every stamp of the day is a printed line,
 * and the running period ticks live.
 */
export function PunchCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const today = todayISO();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const status = useQuery({ queryKey: ['clock-status'], queryFn: () => api.get<{ open: Period | null }>('/attendance/status') });
  const day = useQuery({ queryKey: ['attendance', 'me', today, today], queryFn: () => api.get<{ items: Period[] }>(`/attendance?from=${today}&to=${today}`) });

  const toggle = useMutation({
    mutationFn: () => api.post(status.data?.open ? '/attendance/clock-out' : '/attendance/clock-in'),
    onSuccess: () => {
      toast(status.data?.open ? t('clock.clockedOut') : t('clock.clockedIn'));
      qc.invalidateQueries({ queryKey: ['clock-status'] });
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });

  const open = status.data?.open;
  const work = (day.data?.items ?? []).filter((p) => p.type === 'WORK');
  const total = work.reduce((s, p) => s + minutesOf(p, now), 0);

  return (
    <section className="perforated relative overflow-hidden rounded-md border border-rule bg-sheet pl-6" aria-label={t('clock.title')}>
      <div className="border-l border-dashed border-rule p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-bold">{t('clock.title')}</h2>
            <p className={open ? 'font-semibold text-grant' : 'text-ink-soft'}>{open ? t('clock.running', { time: fmtTime(open.startAt) }) : t('clock.stopped')}</p>
          </div>
          <Button variant={open ? 'secondary' : 'primary'} busy={toggle.isPending} onClick={() => toggle.mutate()}>
            {open ? t('clock.clockOut') : t('clock.clockIn')}
          </Button>
        </div>
        <ol className="mt-4 grid gap-0 text-sm">
          {work.map((p) => (
            <li key={p.id} className="tnum flex items-center justify-between border-b border-rule-soft py-1.5 last:border-0">
              <span>
                {fmtTime(p.startAt)} – {p.endAt ? fmtTime(p.endAt) : <span className="font-semibold text-grant">{t('time.running')}</span>}
              </span>
              <span className="text-ink-soft">{fmtMinutes(minutesOf(p, now))}</span>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex items-baseline justify-between border-t-2 border-ink pt-2">
          <span className="font-semibold">{t('clock.today')}</span>
          <span className="tnum text-xl font-bold">{fmtMinutes(total)}</span>
        </div>
      </div>
    </section>
  );
}

/** Flextime balance with the date tracking started; a hint instead of 0:00 before the first entry. */
export function BalanceFigure({ balance }: { balance: { balanceMinutes: number; trackingSince: string | null } }) {
  const { t } = useTranslation();
  if (!balance.trackingSince) return <p className="text-sm text-ink-soft">{t('time.noTracking')}</p>;
  return (
    <>
      <p className={`tnum text-2xl font-bold ${balance.balanceMinutes < 0 ? 'text-refuse' : ''}`}>{fmtMinutes(balance.balanceMinutes, true)}</p>
      <p className="text-xs text-ink-faint">{t('time.balanceSince', { date: fmtDate(balance.trackingSince) })}</p>
    </>
  );
}
