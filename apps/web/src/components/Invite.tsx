import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Mail } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { cx } from './ui';

export interface Invitation {
  status: 'pending' | 'expired' | 'accepted';
  sentAt: string;
}

/** Whether OpenPers can send mail (admins only; others get `undefined`). */
export function useMailStatus() {
  const { can } = useAuth();
  return useQuery({ queryKey: ['mail-status'], queryFn: () => api.get<{ configured: boolean; transport: 'smtp' | 'log'; server: string; from: string | null }>('/mail/status'), enabled: can('settings.manage'), staleTime: 300_000 }).data;
}

export function InvitationBadge({ invitation }: { invitation: Invitation | null | undefined }) {
  const { t } = useTranslation();
  if (!invitation) return null;
  const tone = invitation.status === 'accepted' ? 'text-grant' : invitation.status === 'pending' ? 'text-wait' : 'text-refuse';
  return (
    <span className={cx('stamp inline-flex items-center gap-1', tone)} title={t('invite.sentOn', { date: fmtDate(invitation.sentAt) })}>
      <Mail size={12} aria-hidden /> {t(`invite.status.${invitation.status}`)}
    </span>
  );
}

/** Invitation link for admins to pass on when no mail server is configured. */
export function InviteLinkBox({ url }: { url: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-md border border-wait/50 bg-sheet p-3 text-sm">
      <p className="mb-2 text-ink-soft">{t('invite.noMailServer')}</p>
      <div className="flex gap-2">
        <input readOnly value={url} aria-label={t('invite.link')} onFocus={(e) => e.target.select()} className="min-w-0 flex-1 rounded-[var(--radius-ctl)] border border-rule bg-paper px-2 py-1.5 font-mono text-xs" />
        <button
          type="button"
          onClick={() => navigator.clipboard.writeText(url).then(() => (setCopied(true), setTimeout(() => setCopied(false), 2000)))}
          className="flex items-center gap-1 rounded-[var(--radius-ctl)] border border-rule px-2.5 font-semibold hover:bg-rule-soft"
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />} {copied ? t('invite.copied') : t('invite.copy')}
        </button>
      </div>
    </div>
  );
}
