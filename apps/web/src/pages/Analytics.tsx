import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtMinutes, fmtNumber, parseISO, todayISO, toISO } from '../lib/format';
import { BarList, ChartCard, ColumnChart } from '../components/Charts';
import { Empty, PageHeader, Select, Spinner } from '../components/ui';

const shiftMonth = (month: string, n: number) => {
  const d = parseISO(`${month}-01`);
  d.setMonth(d.getMonth() + n);
  return toISO(d).slice(0, 7);
};

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-rule bg-sheet px-4 py-3">
      <div className="text-sm text-ink-soft">{label}</div>
      <div className="tnum mt-0.5 text-2xl font-bold">{value}</div>
      {hint && <div className="text-xs text-ink-faint">{hint}</div>}
    </div>
  );
}

export function AnalyticsPage() {
  const { t, i18n } = useTranslation();
  const [months, setMonths] = useState(12);
  const [orgUnitId, setOrgUnitId] = useState('');
  const [workplaceId, setWorkplaceId] = useState('');
  const to = todayISO().slice(0, 7);
  const from = shiftMonth(to, -(months - 1));
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const wps = useQuery({ queryKey: ['workplaces'], queryFn: () => api.get('/workplaces') });
  const q = useQuery({
    queryKey: ['analytics', from, to, orgUnitId, workplaceId],
    queryFn: () => api.get(`/analytics/overview?from=${from}&to=${to}${orgUnitId ? `&orgUnitId=${orgUnitId}` : ''}${workplaceId ? `&workplaceId=${workplaceId}` : ''}`),
  });
  const locale = i18n.language === 'en' ? 'en-GB' : 'de-DE';
  const monthLabel = (m: string) => parseISO(`${m}-01`).toLocaleDateString(locale, { month: 'short', year: months > 12 ? '2-digit' : undefined });
  const d = q.data;
  const pct = (v: number) => `${fmtNumber(v)} %`;
  const groupLabel = (dim: string, key: string) => (key === 'none' ? t('analytics.none') : key === 'other' ? t('analytics.other') : dim === 'byContractType' ? t(`person.contractTypes.${key}`, key) : dim === 'byTenure' ? t(`analytics.tenure.${key}`) : key);
  const series1 = 'var(--color-series-1)';
  const series2 = 'var(--color-series-2)';

  return (
    <div>
      <PageHeader title={t('analytics.title')}>{t('analytics.subtitle')}</PageHeader>
      <div className="mb-5 flex flex-wrap gap-2">
        <Select className="h-9 max-w-44" value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label={t('analytics.period')}>
          {[6, 12, 24].map((m) => (
            <option key={m} value={m}>
              {t('analytics.lastMonths', { count: m })}
            </option>
          ))}
        </Select>
        <Select className="h-9 max-w-52" value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} aria-label={t('person.orgUnits')}>
          <option value="">{t('team.allUnits')}</option>
          {(units.data?.items ?? []).map((u: any) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </Select>
        <Select className="h-9 max-w-52" value={workplaceId} onChange={(e) => setWorkplaceId(e.target.value)} aria-label={t('person.workplace')}>
          <option value="">{t('analytics.allWorkplaces')}</option>
          {(wps.data?.items ?? []).map((w: any) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      </div>

      {q.isLoading || !d ? (
        <Spinner />
      ) : (
        <div className="grid gap-5">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Kpi label={t('analytics.headcount')} value={String(d.totals.headcount)} />
            <Kpi label={t('analytics.fte')} value={fmtNumber(d.totals.fte)} />
            <Kpi label={t('analytics.hires')} value={String(d.totals.hires)} />
            <Kpi label={t('analytics.exits')} value={String(d.totals.exits)} />
            <Kpi label={t('analytics.turnover')} value={pct(d.totals.turnoverRate)} hint={t('analytics.turnoverHint')} />
            <Kpi label={t('analytics.absenceRate')} value={pct(d.absence.totalRate)} hint={t('analytics.absenceHint', { days: fmtNumber(d.absence.totalDays) })} />
            <Kpi label={t('analytics.overtime')} value={fmtMinutes(d.overtime.totalMinutes, true)} hint={t('analytics.overtimeHint', { over: d.overtime.overThreshold, under: d.overtime.underThreshold })} />
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <ChartCard
              title={t('analytics.headcountChart')}
              csv={`headcount-${from}-${to}.csv`}
              table={{ head: [t('absence.month'), t('analytics.headcount'), t('analytics.fte')], rows: d.months.map((m: any) => [m.month, m.headcount, m.fte]) }}
            >
              <ColumnChart labels={d.months.map((m: any) => monthLabel(m.month))} series={[{ key: 'hc', label: t('analytics.headcount'), color: series1, values: d.months.map((m: any) => m.headcount) }]} integer />
            </ChartCard>
            <ChartCard
              title={t('analytics.movementsChart')}
              csv={`hires-exits-${from}-${to}.csv`}
              legend={[
                { label: t('analytics.hires'), color: series1 },
                { label: t('analytics.exits'), color: series2 },
              ]}
              table={{ head: [t('absence.month'), t('analytics.hires'), t('analytics.exits')], rows: d.months.map((m: any) => [m.month, m.hires, m.exits]) }}
            >
              <ColumnChart
                labels={d.months.map((m: any) => monthLabel(m.month))}
                series={[
                  { key: 'hires', label: t('analytics.hires'), color: series1, values: d.months.map((m: any) => m.hires) },
                  { key: 'exits', label: t('analytics.exits'), color: series2, values: d.months.map((m: any) => m.exits) },
                ]}
                integer
              />
            </ChartCard>
          </div>

          <ChartCard
            title={t('analytics.absenceChart')}
            csv={`absence-${from}-${to}.csv`}
            table={{ head: [t('settings.category'), t('absence.days'), t('analytics.rate')], rows: d.absence.byCategory.map((c: any) => [t(`settings.categories.${c.category}`), c.days, `${d.absence.rates[c.category]} %`]) }}
          >
            {d.absence.suppressed ? (
              <Empty>{t('analytics.suppressed')}</Empty>
            ) : !d.absence.byCategory.length ? (
              <Empty>{t('analytics.noAbsence')}</Empty>
            ) : (
              <BarList
                items={[...d.absence.byCategory].sort((a: any, b: any) => b.days - a.days).map((c: any) => ({ label: `${t(`settings.categories.${c.category}`)} (${pct(d.absence.rates[c.category])})`, value: c.days }))}
                format={(v) => `${fmtNumber(v)} ${t('absence.days')}`}
              />
            )}
          </ChartCard>

          <div className="grid gap-5 lg:grid-cols-2">
            {(['byUnit', 'byWorkplace', 'byContractType', 'byTenure'] as const).map((dim) => (
              <ChartCard key={dim} title={t(`analytics.dims.${dim}`)} csv={`${dim}.csv`} table={{ head: [t('analytics.group'), t('analytics.people')], rows: d.distribution[dim].map((g: any) => [groupLabel(dim, g.key), g.count]) }}>
                {d.distribution[dim].length ? <BarList items={d.distribution[dim].map((g: any) => ({ label: groupLabel(dim, g.key), value: g.count }))} /> : <Empty>{t('analytics.none')}</Empty>}
              </ChartCard>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
