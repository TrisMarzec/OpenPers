import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, ClipboardList, Target, CalendarDays, Clock, FileText, ChartColumn, CircleUser, ListChecks, LayoutGrid, LogOut, Network, Menu, Settings, Users, X } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { setLanguage } from '../lib/i18n';
import { fullName, initials } from '../lib/format';
import { Avatar, cx } from './ui';
import { ThemeToggle } from './ThemeToggle';
import { NotificationBell } from './Notifications';
import { useOpenConfirmations } from './CompanyDocs';

export function Layout() {
  const { t, i18n } = useTranslation();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const company = useQuery({ queryKey: ['company'], queryFn: () => api.get('/company') });
  const approvals = useQuery({ queryKey: ['absence-approvals'], queryFn: () => api.get('/absence-approvals'), enabled: can('absence.approve') });
  const pending = approvals.data?.items.length ?? 0;
  const tasks = useQuery({ queryKey: ['tasks-mine'], queryFn: () => api.get('/tasks/mine'), refetchInterval: 120_000 });
  const openTasks = tasks.data?.items.length ?? 0;
  const reviews = useQuery({ queryKey: ['reviews-mine'], queryFn: () => api.get('/reviews/mine'), enabled: !!me?.personId, refetchInterval: 300_000 });
  const openReviews = (reviews.data?.items ?? []).filter((r: any) => r.status === 'pending' && r.cycle.status === 'active').length;
  const surveys = useQuery({ queryKey: ['surveys-open'], queryFn: () => api.get('/surveys/open'), refetchInterval: 300_000 });
  const openSurveys = (surveys.data?.items ?? []).filter((s: any) => !s.answered).length;
  const openConfirmations = useOpenConfirmations();

  const items = [
    { to: '/', label: t('nav.dashboard'), icon: LayoutGrid, show: true, end: true },
    { to: '/me', label: t('nav.profile'), icon: CircleUser, show: !!me?.personId },
    { to: '/tasks', label: t('nav.tasks'), icon: ListChecks, show: true, badge: openTasks },
    { to: '/people', label: t('nav.people'), icon: Users, show: true },
    { to: '/org', label: t('nav.org'), icon: Network, show: true },
    { to: '/absences', label: t('nav.absences'), icon: CalendarDays, show: true, badge: pending },
    { to: '/time', label: t('nav.time'), icon: Clock, show: can('time.track') || can('time.read') },
    { to: '/performance', label: t('nav.performance'), icon: Target, show: !!me?.personId || can('performance.manage'), badge: openReviews },
    { to: '/surveys', label: t('nav.surveys'), icon: ClipboardList, show: true, badge: openSurveys },
    { to: '/documents', label: t('nav.documents'), icon: FileText, show: !!me?.personId || can('documents.manage'), badge: openConfirmations },
    { to: '/recruiting', label: t('nav.recruiting'), icon: Briefcase, show: can('recruiting.read') },
    { to: '/analytics', label: t('nav.analytics'), icon: ChartColumn, show: can('analytics.read') },
    { to: '/settings', label: t('nav.settings'), icon: Settings, show: can('settings.manage') || can('org.manage') || can('absence.manage') || can('users.manage') || can('people.write') },
  ];

  const logout = async () => {
    await api.post('/auth/logout');
    qc.clear();
    navigate('/login');
  };

  const nav = (
    <nav className="flex h-full flex-col gap-1 p-3">
      <div className="mb-4 flex items-center gap-2 px-2 pt-1">
        {company.data?.logoUrl ? (
          <img src={company.data.logoUrl} alt={company.data.name} className="h-8 max-w-[10rem] min-w-0 flex-1 object-contain object-left" />
        ) : (
          <>
            <img src="/favicon.svg" alt="" className="size-7" />
            <div className="min-w-0 flex-1">
              <div className="font-bold leading-tight">OpenPers</div>
              <div className="truncate text-sm text-ink-faint">{company.data?.name}</div>
            </div>
          </>
        )}
        <NotificationBell />
      </div>
      {items
        .filter((i) => i.show)
        .map((i) => (
          <NavLink
            key={i.to}
            to={i.to}
            end={i.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) => cx('flex items-center gap-3 rounded-[var(--radius-ctl)] px-2.5 py-2 font-semibold', isActive ? 'bg-stamp-wash text-stamp' : 'text-ink-soft hover:bg-rule-soft hover:text-ink')}
          >
            <i.icon size={18} aria-hidden />
            <span className="flex-1">{i.label}</span>
            {!!i.badge && <span className="stamp text-wait tnum">{i.badge}</span>}
          </NavLink>
        ))}
      <div className="mt-auto border-t border-rule pt-3">
        <div className="flex items-center gap-2 px-2 pb-2">
          <Avatar name={initials(me?.person ?? { firstName: me?.email ?? '?', lastName: '' })} size={30} src={me?.person?.photoUrl} />
          <div className="min-w-0 text-sm">
            <div className="truncate font-semibold">{me?.person ? fullName(me.person) : me?.email}</div>
            <div className="truncate text-ink-faint">{me?.email}</div>
          </div>
        </div>
        <div className="px-2 pb-2">
          <ThemeToggle />
        </div>
        <div className="flex items-center gap-1 px-1">
          <button
            type="button"
            className="rounded px-2 py-1 text-sm font-semibold text-ink-soft hover:bg-rule-soft"
            onClick={() => {
              const next = i18n.language === 'de' ? 'en' : 'de';
              setLanguage(next);
              api.patch('/auth/me', { locale: next }).catch(() => {});
            }}
            aria-label={t('common.language')}
          >
            {i18n.language === 'de' ? 'English' : 'Deutsch'}
          </button>
          <button type="button" onClick={logout} className="ml-auto flex items-center gap-1.5 rounded px-2 py-1 text-sm font-semibold text-ink-soft hover:bg-rule-soft">
            <LogOut size={15} aria-hidden /> {t('nav.logout')}
          </button>
        </div>
      </div>
    </nav>
  );

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-rule bg-sheet lg:block">{nav}</aside>
      <div className="flex items-center justify-between border-b border-rule bg-sheet px-4 py-2 lg:hidden">
        {company.data?.logoUrl ? <img src={company.data.logoUrl} alt={company.data.name} className="h-7 max-w-[10rem] object-contain object-left" /> : <span className="font-bold">{company.data?.name ?? 'OpenPers'}</span>}
        <button type="button" onClick={() => setOpen(true)} aria-label="Menu" className="rounded p-2 hover:bg-rule-soft">
          <Menu size={20} />
        </button>
      </div>
      {open && (
        <div className="fixed inset-0 z-40 bg-[var(--color-scrim)] lg:hidden" onClick={() => setOpen(false)}>
          <aside className="h-full w-72 bg-sheet" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="absolute top-3 left-60 rounded p-1">
              <X size={18} />
            </button>
            {nav}
          </aside>
        </div>
      )}
      <main className="mx-auto w-full max-w-[1200px] min-w-0 px-4 py-6 lg:px-8 lg:py-8">
        <Outlet />
      </main>
    </div>
  );
}
