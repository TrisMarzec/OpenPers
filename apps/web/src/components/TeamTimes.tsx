import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMinutes, fmtTime, fullName, initials, parseISO, toISO, todayISO } from '../lib/format';
import { AttendanceList } from './AttendanceList';
import { Avatar, Button, cx, Empty, Input, Select, Spinner } from './ui';

interface TeamRow {
  person: { id: string; firstName: string; lastName: string; preferredName: string | null; positionTitle: string | null };
  targetMinutes: number;
  workedMinutes: number;
  diffMinutes: number;
  balanceMinutes: number;
  clockedInSince: string | null;
  absentToday: string | null;
  warningDays: number;
  pendingCount: number;
  lastEntryDate: string | null;
}

/** Working times of everyone the viewer may see, with a drill-down into each person's month list. */
export function TeamTimes() {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  const [month, setMonth] = useState(() => todayISO().slice(0, 7));
  const [orgUnitId, setOrgUnitId] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const q = useQuery({ queryKey: ['attendance-team', month, orgUnitId], queryFn: () => api.get<{ items: TeamRow[] }>(`/attendance/team?month=${month}${orgUnitId ? `&orgUnitId=${orgUnitId}` : ''}`) });
  const shift = (n: number) => {
    const d = parseISO(`${month}-01`);
    d.setMonth(d.getMonth() + n);
    setMonth(toISO(d).slice(0, 7));
  };
  const label = parseISO(`${month}-01`).toLocaleDateString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { month: 'long', year: 'numeric' });
  const rows = (q.data?.items ?? []).filter((r) => !search || `${r.person.firstName} ${r.person.lastName}`.toLowerCase().includes(search.toLowerCase()));
  const clockedIn = rows.filter((r) => r.clockedInSince).length;
  const editable = can('time.manage');

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
        <Input type="search" className="ml-2 h-9 max-w-52" placeholder={t('people.searchPlaceholder')} aria-label={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
        {(units.data?.items ?? []).length > 0 && (
          <Select className="h-9 max-w-52" aria-label={t('person.orgUnits')} value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)}>
            <option value="">{t('team.allUnits')}</option>
            {units.data.items.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        )}
        <span className="ml-auto text-sm text-ink-soft">{t('team.clockedInNow', { count: clockedIn })}</span>
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : !rows.length ? (
        <Empty>{t('team.empty')}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-md border border-rule bg-sheet">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-rule text-sm text-ink-soft">
                <th className="py-2 pl-3 font-semibold">{t('absence.person')}</th>
                <th className="py-2 font-semibold">{t('team.today')}</th>
                <th className="py-2 text-right font-semibold">{t('time.target')}</th>
                <th className="py-2 text-right font-semibold">{t('time.worked')}</th>
                <th className="py-2 text-right font-semibold">{t('time.diff')}</th>
                <th className="py-2 text-right font-semibold">{t('team.balance')}</th>
                <th className="py-2 pr-3 text-right font-semibold">{t('team.notes')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const expanded = open === r.person.id;
                return (
                  <Fragment key={r.person.id}>
                    <tr className={cx('border-b border-rule-soft hover:bg-paper/60', expanded && 'bg-stamp-wash/40')}>
                      <td className="py-2 pl-3">
                        <button type="button" onClick={() => setOpen(expanded ? null : r.person.id)} aria-expanded={expanded} className="flex items-center gap-2.5 text-left">
                          {expanded ? <ChevronDown size={16} className="text-ink-faint" aria-hidden /> : <ChevronRight size={16} className="text-ink-faint" aria-hidden />}
                          <Avatar name={initials(r.person)} size={28} />
                          <span>
                            <span className="block font-semibold">{fullName(r.person)}</span>
                            <span className="block text-xs text-ink-faint">{r.person.positionTitle ?? ''}</span>
                          </span>
                        </button>
                      </td>
                      <td className="py-2 text-sm">
                        {r.clockedInSince ? (
                          <span className="font-semibold text-grant">{t('team.since', { time: fmtTime(r.clockedInSince) })}</span>
                        ) : r.absentToday ? (
                          <span className="text-ink-soft">{r.absentToday}</span>
                        ) : r.lastEntryDate ? (
                          <span className="text-ink-faint">{t('team.lastEntry', { date: fmtDate(r.lastEntryDate, { day: '2-digit', month: '2-digit' }) })}</span>
                        ) : (
                          <span className="text-ink-faint">–</span>
                        )}
                      </td>
                      <td className="tnum py-2 text-right text-ink-soft">{fmtMinutes(r.targetMinutes)}</td>
                      <td className="tnum py-2 text-right font-semibold">{fmtMinutes(r.workedMinutes)}</td>
                      <td className={cx('tnum py-2 text-right', r.diffMinutes < 0 ? 'text-refuse' : r.diffMinutes > 0 ? 'text-grant' : 'text-ink-soft')}>{fmtMinutes(r.diffMinutes, true)}</td>
                      <td className={cx('tnum py-2 text-right font-bold', r.balanceMinutes < 0 ? 'text-refuse' : 'text-grant')}>{fmtMinutes(r.balanceMinutes, true)}</td>
                      <td className="py-2 pr-3 text-right text-sm whitespace-nowrap">
                        {r.warningDays > 0 && (
                          <span className="inline-flex items-center gap-1 text-wait" title={t('team.warningDays', { count: r.warningDays })}>
                            <TriangleAlert size={14} aria-hidden /> {r.warningDays}
                          </span>
                        )}
                        {r.pendingCount > 0 && <span className="stamp ml-2 text-wait">{t('team.pending', { count: r.pendingCount })}</span>}
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="border-b border-rule">
                        <td colSpan={7} className="bg-paper p-3">
                          <div className="mb-2 flex justify-end">
                            <Link to={`/people/${r.person.id}`} className="text-sm font-semibold text-stamp hover:underline">
                              {t('team.openProfile')}
                            </Link>
                          </div>
                          <AttendanceList personId={r.person.id} editable={editable} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
