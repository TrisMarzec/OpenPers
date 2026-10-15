import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { cx } from './ui';

export interface Notification {
  id: string;
  kind: string;
  params: Record<string, any>;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** Renders a notification in the viewer's language from its kind and parameters. */
export function useNotificationText() {
  const { t } = useTranslation();
  return (n: Notification) => {
    const p = { ...n.params };
    if (p.startDate) p.startDate = fmtDate(p.startDate);
    if (p.endDate) p.endDate = fmtDate(p.endDate);
    if (p.dueDate) p.dueDate = fmtDate(p.dueDate);
    if (p.kind) p.kindLabel = t(`checklists.kinds.${p.kind}`);
    return t(`notifications.kinds.${n.kind}`, { ...p, defaultValue: n.kind });
  };
}

const ago = (iso: string, lng: string) => {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  const rtf = new Intl.RelativeTimeFormat(lng === 'en' ? 'en' : 'de', { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  if (minutes < 60 * 24) return rtf.format(-Math.round(minutes / 60), 'hour');
  return rtf.format(-Math.round(minutes / 1440), 'day');
};

/** Bell with unread count and a dropdown of the latest notifications. */
export function NotificationBell() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const text = useNotificationText();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const count = useQuery({ queryKey: ['notifications-count'], queryFn: () => api.get<{ unread: number }>('/notifications/count'), refetchInterval: 60_000 });
  const list = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ items: Notification[] }>('/notifications?limit=30'), enabled: open });
  const markRead = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => api.post('/notifications/read', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['notifications-count'] });
    },
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const unread = count.data?.unread ?? 0;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={t('notifications.title') + (unread ? ` (${unread})` : '')}
        className="relative rounded-[var(--radius-ctl)] p-2 text-ink-soft hover:bg-rule-soft hover:text-ink"
      >
        <Bell size={18} aria-hidden />
        {unread > 0 && <span className="tnum absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-refuse px-1 text-center text-[10px] leading-4 font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute top-full left-0 z-50 mt-1 w-80 rounded-md border border-rule bg-sheet shadow-xl" role="dialog" aria-label={t('notifications.title')}>
          <div className="flex items-center justify-between border-b border-rule-soft px-3 py-2">
            <span className="font-bold">{t('notifications.title')}</span>
            {unread > 0 && (
              <button type="button" className="text-sm font-semibold text-stamp hover:underline" onClick={() => markRead.mutate({ all: true })}>
                {t('notifications.markAll')}
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {(list.data?.items ?? []).length === 0 && <li className="px-3 py-4 text-sm text-ink-soft">{t('notifications.empty')}</li>}
            {(list.data?.items ?? []).map((n) => (
              <li key={n.id}>
                <button
                  type="button"
                  className={cx('flex w-full gap-2 border-b border-rule-soft px-3 py-2.5 text-left text-sm last:border-0 hover:bg-paper', !n.readAt && 'bg-stamp-wash/40')}
                  onClick={() => {
                    if (!n.readAt) markRead.mutate({ ids: [n.id] });
                    setOpen(false);
                    if (n.link) navigate(n.link);
                  }}
                >
                  <span aria-hidden className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-stamp')} />
                  <span className="min-w-0">
                    <span className={cx('block', !n.readAt && 'font-semibold')}>{text(n)}</span>
                    <span className="block text-xs text-ink-faint">{ago(n.createdAt, i18n.language)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
