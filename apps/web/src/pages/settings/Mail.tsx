import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { Button, cx, Empty, Field, Input, Section, Spinner, Table, useErrorText, useToast } from '../../components/ui';
import { useMailStatus } from '../../components/Invite';

const statusTone: Record<string, string> = { sent: 'text-grant', pending: 'text-wait', failed: 'text-refuse', skipped: 'text-ink-faint' };

export function MailSettings() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const status = useMailStatus();
  const log = useQuery({ queryKey: ['mail-log'], queryFn: () => api.get('/mail/log'), refetchInterval: 5_000 });
  const [to, setTo] = useState(me?.email ?? '');
  const test = useMutation({
    mutationFn: () => api.post('/mail/test', { to }),
    onSuccess: () => {
      toast(t('mail.testQueued', { to }));
      setTimeout(() => qc.invalidateQueries({ queryKey: ['mail-log'] }), 1500);
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const retry = useMutation({ mutationFn: () => api.post('/mail/retry'), onSuccess: () => qc.invalidateQueries({ queryKey: ['mail-log'] }), onError: (e) => toast(errText(e), 'error') });
  if (!status) return <Spinner />;
  const items = log.data?.items ?? [];
  return (
    <div className="grid gap-6">
      <Section title={t('mail.title')}>
        <div className={cx('flex items-start gap-3 rounded-md border p-3', status.configured ? 'border-grant/40' : 'border-wait/50')}>
          {status.configured ? <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-grant" aria-hidden /> : <AlertTriangle size={20} className="mt-0.5 shrink-0 text-wait" aria-hidden />}
          <div className="text-sm">
            <p className="font-semibold">{status.configured ? t('mail.configured', { server: status.server }) : t('mail.notConfigured')}</p>
            <p className="text-ink-soft">{status.configured ? t('mail.from', { from: status.from }) : t('mail.howTo')}</p>
            {!status.configured && <pre className="mt-2 overflow-x-auto rounded bg-paper p-2 font-mono text-xs">{'SMTP_HOST=smtp.example.com\nSMTP_PORT=587\nSMTP_USER=…\nSMTP_PASSWORD=…\nMAIL_FROM="OpenPers <hr@example.com>"'}</pre>}
          </div>
        </div>
        {status.configured && (
          <form
            className="mt-4 flex max-w-lg flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              test.mutate();
            }}
          >
            <Field label={t('mail.testTo')} className="min-w-0 flex-1">
              <Input type="email" value={to} onChange={(e) => setTo(e.target.value)} required />
            </Field>
            <Button type="submit" busy={test.isPending}>
              {t('mail.sendTest')}
            </Button>
          </form>
        )}
      </Section>
      <Section
        title={t('mail.log')}
        actions={
          items.some((m: any) => m.status === 'failed' || m.status === 'pending') && (
            <Button size="sm" busy={retry.isPending} onClick={() => retry.mutate()}>
              {t('mail.retry')}
            </Button>
          )
        }
      >
        {!items.length ? (
          <Empty>{t('mail.empty')}</Empty>
        ) : (
          <Table head={[t('mail.when'), t('mail.to'), t('mail.subject'), t('common.status')]}>
            {items.map((m: any) => (
              <tr key={m.id}>
                <td className="tnum whitespace-nowrap">{new Date(m.createdAt).toLocaleString()}</td>
                <td>{m.to}</td>
                <td>{m.subject}</td>
                <td title={m.lastError ?? undefined}>
                  <span className={cx('stamp', statusTone[m.status])}>{t(`mail.status.${m.status}`)}</span>
                  {m.lastError && m.status !== 'skipped' && <span className="ml-2 text-xs text-ink-faint">{m.lastError}</span>}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
    </div>
  );
}
