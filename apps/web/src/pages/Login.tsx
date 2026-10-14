import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';
import { AuthShell } from './Setup';

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      await qc.invalidateQueries();
      navigate((location.state as { from?: string } | null)?.from ?? '/');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? err.message : t('login.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title={t('login.title')}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={t('login.email')}>
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />
        </Field>
        <Field label={t('login.password')}>
          <Input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </Field>
        {error && (
          <p role="alert" className="text-refuse">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" busy={busy}>
          {t('login.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
