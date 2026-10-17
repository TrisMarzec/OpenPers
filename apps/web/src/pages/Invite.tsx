import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { setLanguage } from '../lib/i18n';
import { Button, Field, Input, Spinner } from '../components/ui';
import { AuthShell } from './Setup';

interface LinkInfo {
  kind: 'invite' | 'reset';
  email: string;
  firstName?: string | null;
  company: string;
  locale: string;
}

/** Shared form: choose a password via an invitation or reset link, then sign in. */
function ChoosePassword({ kind }: { kind: 'invite' | 'reset' }) {
  const { t } = useTranslation();
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const base = kind === 'invite' ? `/public/invitations/${token}` : `/public/password-reset/${token}`;
  const info = useQuery({
    queryKey: ['link', kind, token],
    queryFn: async () => {
      const r = await api.get<LinkInfo>(base);
      if (r.locale === 'en' || r.locale === 'de') setLanguage(r.locale);
      return r;
    },
    retry: false,
  });
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 10) return setError(t('setup.passwordHint'));
    if (pw !== pw2) return setError(t('invite.mismatch'));
    setBusy(true);
    setError(null);
    try {
      await api.post(kind === 'invite' ? `${base}/accept` : base, { password: pw });
      await qc.invalidateQueries();
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 410 ? t('invite.gone') : t('common.errorGeneric'));
    } finally {
      setBusy(false);
    }
  };
  if (info.isLoading) return <Spinner />;
  if (info.isError) {
    const status = info.error instanceof ApiError ? info.error.status : 0;
    return (
      <AuthShell title={t('invite.invalidTitle')}>
        <p className="text-ink-soft">{status === 410 ? t('invite.gone') : t('invite.unknown')}</p>
        <p className="mt-4">
          <Link to={kind === 'invite' ? '/login' : '/forgot-password'} className="font-semibold text-stamp hover:underline">
            {kind === 'invite' ? t('invite.toLogin') : t('invite.requestNew')}
          </Link>
        </p>
      </AuthShell>
    );
  }
  const d = info.data!;
  return (
    <AuthShell
      title={kind === 'invite' ? t('invite.welcomeTitle', { name: d.firstName ?? '' }).trim() : t('invite.resetTitle')}
      intro={kind === 'invite' ? t('invite.welcomeIntro', { company: d.company }) : t('invite.resetIntro')}
    >
      <form onSubmit={submit} className="grid gap-4">
        <Field label={t('login.email')}>
          <Input value={d.email} readOnly autoComplete="username" />
        </Field>
        <Field label={t('invite.choosePassword')} hint={t('setup.passwordHint')}>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus required minLength={10} />
        </Field>
        <Field label={t('invite.repeatPassword')}>
          <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-refuse">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          {kind === 'invite' ? t('invite.activate') : t('invite.savePassword')}
        </Button>
      </form>
    </AuthShell>
  );
}

export const AcceptInvitePage = () => <ChoosePassword kind="invite" />;
export const ResetPasswordPage = () => <ChoosePassword kind="reset" />;

export function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/auth/password-reset', { email });
    } finally {
      // Same answer whether or not the address exists.
      setSent(true);
      setBusy(false);
    }
  };
  return (
    <AuthShell title={t('invite.forgotTitle')} intro={sent ? undefined : t('invite.forgotIntro')}>
      {sent ? (
        <p className="text-ink-soft">{t('invite.forgotSent', { email })}</p>
      ) : (
        <form onSubmit={submit} className="grid gap-4">
          <Field label={t('login.email')}>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <Button type="submit" variant="primary" busy={busy}>
            {t('invite.sendLink')}
          </Button>
        </form>
      )}
      <p className="mt-4 text-sm">
        <Link to="/login" className="font-semibold text-stamp hover:underline">
          {t('invite.toLogin')}
        </Link>
      </p>
    </AuthShell>
  );
}
