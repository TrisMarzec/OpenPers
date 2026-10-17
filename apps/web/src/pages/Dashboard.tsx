import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtMinutes, fmtNumber, fmtRange, fullName, initials, todayISO } from '../lib/format';
import { AbsenceDialog } from '../components/AbsenceDialog';
import { PunchCard } from '../components/PunchCard';
import { ApprovalList } from './Absences';
import { Avatar, Button, Section, Stamp, Swatch } from '../components/ui';
import { BalanceFigure } from '../components/PunchCard';
import { PersonAvatar } from '../components/Photo';
import { SetupGuideCard } from './Welcome';

export function DashboardPage() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const [requesting, setRequesting] = useState(false);
  const today = todayISO();
  const year = new Date().getFullYear();
  const personId = me?.personId;

  const balances = useQuery({ queryKey: ['balances', personId, year], queryFn: () => api.get(`/persons/${personId}/balances?year=${year}`), enabled: !!personId });
  const timeBalance = useQuery({ queryKey: ['time-balance', personId], queryFn: () => api.get(`/persons/${personId}/time-balance`), enabled: !!personId && can('time.track') });
  const calendar = useQuery({ queryKey: ['absence-calendar', today, today], queryFn: () => api.get(`/absence-calendar?from=${today}&to=${today}`) });
  const mine = useQuery({ queryKey: ['absences', personId, 'upcoming'], queryFn: () => api.get(`/absence-periods?personId=${personId}&from=${today}`), enabled: !!personId });

  const vacation = balances.data?.items?.[0];
  const upcoming = (mine.data?.items ?? []).filter((a: any) => ['pending', 'approved'].includes(a.status)).sort((a: any, b: any) => a.startDate.localeCompare(b.startDate)).slice(0, 4);

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-3xl font-bold">{t('dashboard.hello', { name: me?.person?.preferredName || me?.person?.firstName || '' })}</h1>
        {personId && (
          <Button variant="primary" onClick={() => setRequesting(true)}>
            {t('dashboard.requestAbsence')}
          </Button>
        )}
      </div>

      {can('settings.manage') && <SetupGuideCard />}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="grid content-start gap-5">
          {personId && can('time.track') && <PunchCard />}
          {vacation && (
            <Section title={t('dashboard.vacationLeft', { year })}>
              <p className="tnum text-4xl font-bold">
                {fmtNumber(vacation.available)} <span className="text-lg font-semibold text-ink-soft">{t('absence.days')}</span>
              </p>
              <p className="mt-1 text-sm text-ink-soft">
                {t('dashboard.vacationDetail', { taken: fmtNumber(vacation.taken), pending: fmtNumber(vacation.pending), entitlement: fmtNumber(vacation.entitlement + vacation.carryover - vacation.carryoverExpired) })}
              </p>
            </Section>
          )}
          {timeBalance.data && (
            <Section title={t('dashboard.overtime')}>
              <BalanceFigure balance={timeBalance.data} />
            </Section>
          )}
        </div>

        <div className="grid content-start gap-5">
          {can('absence.approve') && (
            <Section title={t('dashboard.approvals')}>
              <ApprovalList emptyText={t('dashboard.noApprovals')} compact />
            </Section>
          )}
          <Section title={t('dashboard.absentToday')}>
            {calendar.data?.items.length ? (
              <ul className="grid gap-2">
                {calendar.data.items.map((a: any) => (
                  <li key={a.id} className="flex items-center gap-3">
                    <PersonAvatar person={{ ...a, id: a.personId }} size={28} />
                    <span className="flex-1 font-semibold">{fullName(a)}</span>
                    <span className="flex items-center gap-1.5 text-sm text-ink-soft">
                      <Swatch color={a.color} /> {a.typeName}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-soft">{t('dashboard.nobodyAbsent')}</p>
            )}
          </Section>
          {personId && (
            <Section title={t('dashboard.upcoming')} actions={<Link to="/absences" className="text-sm font-semibold text-stamp hover:underline">{t('nav.absences')}</Link>}>
              {upcoming.length ? (
                <ul className="grid gap-2">
                  {upcoming.map((a: any) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-3">
                      <Swatch color={a.typeColor} />
                      <span className="font-semibold">{a.typeName}</span>
                      <span className="tnum text-ink-soft">{fmtRange(a.startDate, a.endDate)}</span>
                      <span className="ml-auto">
                        <Stamp status={a.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-ink-soft">{t('dashboard.noUpcoming')}</p>
              )}
            </Section>
          )}
        </div>
      </div>
      {personId && <AbsenceDialog open={requesting} onClose={() => setRequesting(false)} />}
    </div>
  );
}
