import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, ChevronRight, Copy, Eraser, TriangleAlert } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { fmtMinutes, parseISO, toISO, todayISO } from '../lib/format';
import { Button, cx, Swatch, useErrorText, useToast } from './ui';

export interface MonthDay {
  date: string;
  weekend: boolean;
  holiday: string | null;
  absence: { typeName: string; color: string; fraction: number } | null;
  targetMinutes: number;
  start: string | null;
  end: string | null;
  breakMinutes: number;
  workedMinutes: number;
  diffMinutes: number;
  location: string | null;
  projectId: string | null;
  status: 'pending' | 'approved' | null;
  running: boolean;
  periodCount: number;
  warnings: { code: string }[];
}

interface Draft {
  start: string;
  end: string;
  breakMinutes: string;
  location: string;
  projectId: string;
}

const draftOf = (d: MonthDay): Draft => ({ start: d.start ?? '', end: d.end ?? '', breakMinutes: d.start ? String(d.breakMinutes) : '', location: d.location ?? '', projectId: d.projectId ?? '' });
const sameDraft = (a: Draft, b: Draft) => a.start === b.start && a.end === b.end && (a.breakMinutes || '0') === (b.breakMinutes || '0') && a.location === b.location && a.projectId === b.projectId;

/** Live preview of worked minutes for a draft (handles shifts past midnight). */
function draftMinutes(d: Draft): number | null {
  if (!/^\d{2}:\d{2}$/.test(d.start) || !/^\d{2}:\d{2}$/.test(d.end)) return null;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  let span = toMin(d.end) - toMin(d.start);
  if (span <= 0) span += 24 * 60;
  return Math.max(0, span - (Number(d.breakMinutes) || 0));
}

/** Lenient time entry: '8' → 08:00, '830' → 08:30, '8.30' / '8,30' / '8:3' → 08:30. Invalid input is kept for correction. */
export function normalizeTime(raw: string): string {
  const v = raw.trim().replace(/[.,h]/g, ':');
  if (!v) return '';
  let h: number;
  let m: number;
  if (v.includes(':')) {
    const [a, b = '0'] = v.split(':');
    h = Number(a);
    m = Number(b.padEnd(2, '0').slice(0, 2));
  } else if (/^\d{1,2}$/.test(v)) {
    h = Number(v);
    m = 0;
  } else if (/^\d{3,4}$/.test(v)) {
    h = Number(v.slice(0, -2));
    m = Number(v.slice(-2));
  } else return raw;
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return raw;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const cell = 'h-9 rounded-[var(--radius-ctl)] border border-transparent bg-transparent px-1.5 text-ink hover:border-rule focus:border-stamp focus:bg-sheet focus:outline-none focus:ring-2 focus:ring-stamp/20 disabled:hover:border-transparent';

function Row({ day, previous, editable, personId, projects, month }: { day: MonthDay; previous: MonthDay | undefined; editable: boolean; personId: string; projects: { id: string; name: string; code: string | null }[]; month: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [draft, setDraft] = useState<Draft>(() => draftOf(day));
  const [saved, setSaved] = useState(false);
  const rowRef = useRef<HTMLTableRowElement>(null);
  /** Last draft sent to the server, so Enter + the following blur do not save twice. */
  const lastSent = useRef<Draft | null>(null);
  // Re-sync when the server data for this day changes (e.g. after a save elsewhere).
  useEffect(() => {
    setDraft(draftOf(day));
    lastSent.current = null;
  }, [day.start, day.end, day.breakMinutes, day.location, day.projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['attendance-month', personId, month] });
    qc.invalidateQueries({ queryKey: ['time-balance'] });
    qc.invalidateQueries({ queryKey: ['attendance'] });
  };
  const flash = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const save = useMutation({
    mutationFn: (d: Draft) =>
      api.put('/attendance/day', { personId, date: day.date, start: d.start, end: d.end, breakMinutes: Number(d.breakMinutes) || 0, location: d.location || null, projectId: d.projectId || null }),
    onSuccess: (res: any) => {
      if (res.breakAdjusted) toast(t('time.breakAdjusted', { count: res.breakMinutes }));
      for (const w of res.warnings ?? []) toast(t(`time.warnings.${w.code}`), 'error');
      flash();
      refresh();
    },
    onError: (e) => {
      toast(e instanceof ApiError && e.status === 409 ? t('time.overlap') : errText(e), 'error');
      lastSent.current = null;
      setDraft(draftOf(day));
    },
  });
  const clear = useMutation({
    mutationFn: () => api.delete(`/attendance/day?personId=${personId}&date=${day.date}`),
    onSuccess: () => {
      flash();
      refresh();
    },
    onError: (e) => toast(errText(e), 'error'),
  });

  const commit = (raw = draft) => {
    const d = { ...raw, start: normalizeTime(raw.start), end: normalizeTime(raw.end) };
    if (sameDraft(d, draftOf(day)) || (lastSent.current && sameDraft(d, lastSent.current))) return;
    const valid = (v: string) => /^\d{2}:\d{2}$/.test(v);
    if ((d.start && !valid(d.start)) || (d.end && !valid(d.end))) {
      toast(t('time.invalidTime'), 'error');
      return;
    }
    if (!d.start && !d.end) {
      if (day.periodCount) {
        lastSent.current = d;
        clear.mutate();
      }
      return;
    }
    if (d.start && d.end) {
      lastSent.current = d;
      save.mutate(d);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
      // Jump to the next day's start field for fast entry.
      const next = rowRef.current?.nextElementSibling?.querySelector<HTMLInputElement>('input[data-field=start]');
      next?.focus();
    }
    if (e.key === 'Escape') setDraft(draftOf(day));
  };

  const offDay = day.weekend || !!day.holiday;
  const today = day.date === todayISO();
  const live = draftMinutes(draft);
  const worked = sameDraft(draft, draftOf(day)) ? day.workedMinutes : (live ?? 0);
  const diff = worked - day.targetMinutes;
  const disabled = !editable || day.running;
  const dateObj = parseISO(day.date);
  const locale = i18n.language === 'en' ? 'en-GB' : 'de-DE';

  return (
    <tr
      ref={rowRef}
      onBlur={(e) => {
        // Save when focus leaves the row, not when moving between its cells.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) commit();
      }}
      onKeyDown={onKeyDown}
      className={cx('group border-b border-rule-soft last:border-0', offDay && 'bg-paper/70 text-ink-faint', today && 'bg-stamp-wash/50')}
    >
      <th scope="row" className={cx('w-28 py-1 pr-2 pl-3 text-left font-semibold whitespace-nowrap', today && 'text-stamp')}>
        <span className="tnum inline-block w-6 text-right">{dateObj.getDate()}.</span> <span className="text-ink-soft">{dateObj.toLocaleDateString(locale, { weekday: 'short' })}</span>
      </th>
      <td className="py-1 text-sm">
        {day.holiday ? (
          <span className="text-ink-soft">{day.holiday}</span>
        ) : day.absence ? (
          <span className="flex items-center gap-1.5">
            <Swatch color={day.absence.color} />
            {day.absence.typeName}
            {day.absence.fraction < 1 ? ' ½' : ''}
          </span>
        ) : null}
      </td>
      <td className="tnum py-1 text-right text-ink-soft">{day.targetMinutes ? fmtMinutes(day.targetMinutes) : ''}</td>
      <td className="py-1 pl-3">
        <input aria-label={t('time.start')} data-field="start" type="text" inputMode="numeric" autoComplete="off" maxLength={5} placeholder="––:––" className={cx(cell, 'tnum w-[4.5rem] text-center placeholder:text-rule')} disabled={disabled} value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value })} onBlur={(e) => setDraft((d) => ({ ...d, start: normalizeTime(e.target.value) }))} />
      </td>
      <td className="py-1">
        <input aria-label={t('time.end')} type="text" inputMode="numeric" autoComplete="off" maxLength={5} className={cx(cell, 'tnum w-[4.5rem] text-center placeholder:text-rule')} disabled={disabled} value={day.running ? '' : draft.end} placeholder={day.running ? t('time.running') : '––:––'} onChange={(e) => setDraft({ ...draft, end: e.target.value })} onBlur={(e) => setDraft((d) => ({ ...d, end: normalizeTime(e.target.value) }))} />
      </td>
      <td className="py-1">
        <input aria-label={t('time.breaks')} type="number" inputMode="numeric" min={0} max={720} step={5} className={cx(cell, 'tnum w-16 text-right placeholder:text-rule')} disabled={disabled} value={draft.breakMinutes} placeholder="–" onChange={(e) => setDraft({ ...draft, breakMinutes: e.target.value })} />
      </td>
      <td className="tnum py-1 text-right font-semibold">{worked ? fmtMinutes(worked) : day.running ? <span className="text-grant">{t('time.running')}</span> : ''}</td>
      <td className={cx('tnum py-1 pr-3 text-right', worked || day.targetMinutes ? (diff < 0 ? 'text-refuse' : diff > 0 ? 'text-grant' : 'text-ink-soft') : '')}>{worked || (day.targetMinutes && day.date < todayISO()) ? fmtMinutes(diff, true) : ''}</td>
      <td className="py-1">
        <select aria-label={t('time.location')} className={cx(cell, 'w-28 text-sm')} disabled={disabled} value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })}>
          <option value="">–</option>
          {(['office', 'remote', 'on_site'] as const).map((l) => (
            <option key={l} value={l}>
              {t(`time.locations.${l}`)}
            </option>
          ))}
        </select>
      </td>
      {projects.length > 0 && (
        <td className="py-1">
          <select aria-label={t('time.project')} className={cx(cell, 'w-36 text-sm')} disabled={disabled} value={draft.projectId} onChange={(e) => setDraft({ ...draft, projectId: e.target.value })}>
            <option value="">–</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code ? `${p.code} · ` : ''}
                {p.name}
              </option>
            ))}
          </select>
        </td>
      )}
      <td className="w-24 py-1 pr-3 text-right whitespace-nowrap">
        <span className="inline-flex items-center gap-0.5">
          {day.warnings.length > 0 && (
            <span title={day.warnings.map((w) => t(`time.warnings.${w.code}`)).join('\n')} className="text-wait" aria-label={day.warnings.map((w) => t(`time.warnings.${w.code}`)).join(', ')}>
              <TriangleAlert size={15} />
            </span>
          )}
          {day.status === 'pending' && <span className="stamp text-wait">{t('status.pending')}</span>}
          {day.periodCount > 1 && <span className="text-xs text-ink-faint" title={t('time.mergedHint', { count: day.periodCount })}>×{day.periodCount}</span>}
          {saved && <Check size={15} className="text-grant" aria-label={t('common.saved')} />}
          {!disabled && (
            <span className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
              {previous && !draft.start && (
                <button
                  type="button"
                  title={t('time.copyPrevious')}
                  aria-label={t('time.copyPrevious')}
                  className="rounded p-1 text-ink-faint hover:bg-rule-soft hover:text-ink"
                  onClick={() => {
                    const d = draftOf(previous);
                    setDraft(d);
                    commit(d);
                  }}
                >
                  <Copy size={14} />
                </button>
              )}
              {day.periodCount > 0 && (
                <button type="button" title={t('time.clearDay')} aria-label={t('time.clearDay')} className="rounded p-1 text-ink-faint hover:bg-refuse-wash hover:text-refuse" onClick={() => clear.mutate()}>
                  <Eraser size={14} />
                </button>
              )}
            </span>
          )}
        </span>
      </td>
    </tr>
  );
}

/** Month list in the style of a time sheet: one row per day, edited inline. */
export function AttendanceList({ personId, editable }: { personId: string; editable: boolean }) {
  const { t, i18n } = useTranslation();
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const q = useQuery({ queryKey: ['attendance-month', personId, month], queryFn: () => api.get<{ days: MonthDay[]; totals: { targetMinutes: number; workedMinutes: number; diffMinutes: number } }>(`/attendance/month?personId=${personId}&month=${month}`) });
  const balance = useQuery({ queryKey: ['time-balance', personId], queryFn: () => api.get(`/persons/${personId}/time-balance`) });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.get('/projects'), select: (d: any) => d.items.filter((p: any) => p.status === 'ACTIVE') });
  const shift = (n: number) => {
    const d = parseISO(`${month}-01`);
    d.setMonth(d.getMonth() + n);
    setMonth(toISO(d).slice(0, 7));
  };
  const label = parseISO(`${month}-01`).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric' });
  const days = q.data?.days ?? [];
  // For "same as previous day": the latest earlier day that has times.
  const previousOf = useMemo(() => {
    const map = new Map<string, MonthDay | undefined>();
    let last: MonthDay | undefined;
    for (const d of days) {
      map.set(d.date, last);
      if (d.start && d.end) last = d;
    }
    return map;
  }, [days]);
  const totals = q.data?.totals;
  const hasProjects = (projects.data ?? []).length > 0;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" aria-label={t('common.previous')} onClick={() => shift(-1)}>
          <ChevronLeft size={18} />
        </Button>
        <h2 className="min-w-40 text-center text-lg font-bold">{label}</h2>
        <Button size="sm" variant="ghost" aria-label={t('common.next')} onClick={() => shift(1)}>
          <ChevronRight size={18} />
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMonth(todayISO().slice(0, 7))}>
          {t('common.today')}
        </Button>
        {totals && (
          <dl className="tnum ml-auto flex flex-wrap gap-x-6 gap-y-1 text-sm">
            <div>
              <dt className="inline text-ink-soft">{t('time.target')}: </dt>
              <dd className="inline font-semibold">{fmtMinutes(totals.targetMinutes)}</dd>
            </div>
            <div>
              <dt className="inline text-ink-soft">{t('time.worked')}: </dt>
              <dd className="inline font-semibold">{fmtMinutes(totals.workedMinutes)}</dd>
            </div>
            {balance.data && (
              <div>
                <dt className="inline text-ink-soft">{t('time.balance')}: </dt>
                <dd className={cx('inline font-bold', balance.data.balanceMinutes < 0 ? 'text-refuse' : 'text-grant')}>{fmtMinutes(balance.data.balanceMinutes, true)}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border border-rule bg-sheet">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-rule text-sm text-ink-soft">
              <th className="py-2 pl-3 font-semibold">{t('common.date')}</th>
              <th className="py-2 font-semibold" />
              <th className="py-2 text-right font-semibold">{t('time.target')}</th>
              <th className="py-2 pl-4 font-semibold">{t('time.start')}</th>
              <th className="py-2 pl-1.5 font-semibold">{t('time.end')}</th>
              <th className="py-2 pl-1.5 font-semibold">{t('time.breakShort')}</th>
              <th className="py-2 text-right font-semibold">{t('time.worked')}</th>
              <th className="py-2 pr-3 text-right font-semibold">{t('time.diff')}</th>
              <th className="py-2 pl-1.5 font-semibold">{t('time.location')}</th>
              {hasProjects && <th className="py-2 pl-1.5 font-semibold">{t('time.project')}</th>}
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <Row key={d.date} day={d} previous={previousOf.get(d.date)} editable={editable} personId={personId} projects={projects.data ?? []} month={month} />
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="tnum border-t-2 border-ink font-bold">
                <td className="py-2 pl-3" colSpan={2}>
                  {t('time.monthTotal')}
                </td>
                <td className="py-2 text-right">{fmtMinutes(totals.targetMinutes)}</td>
                <td colSpan={3} />
                <td className="py-2 text-right">{fmtMinutes(totals.workedMinutes)}</td>
                <td className={cx('py-2 pr-3 text-right', totals.diffMinutes < 0 ? 'text-refuse' : 'text-grant')}>{fmtMinutes(totals.diffMinutes, true)}</td>
                <td colSpan={hasProjects ? 3 : 2} />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="mt-2 text-sm text-ink-faint">{t('time.listHint')}</p>
    </div>
  );
}
