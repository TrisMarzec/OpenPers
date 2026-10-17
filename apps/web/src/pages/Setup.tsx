import { useState, type FormEvent, type ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { REGION_NAMES, REGIONS } from '@openpers/shared';
import { api, ApiError } from '../lib/api';
import { setLanguage } from '../lib/i18n';
import { Button, Field, Input, Select, Spinner } from '../components/ui';
import { ThemeToggle } from '../components/ThemeToggle';
import { BrandMark, useBranding } from '../components/Photo';

export function AuthShell({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  const branding = useBranding();
  return (
    <div className="flex min-h-screen items-start justify-center px-4 py-12 sm:items-center">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center gap-2">
          <BrandMark className="h-8" />
          {!branding?.logoUrl && <span className="text-lg font-bold">{branding?.name ?? 'OpenPers'}</span>}
          <span className="ml-auto">
            <ThemeToggle />
          </span>
        </div>
        <div className="rounded-md border border-rule bg-sheet p-6">
          <h1 className="text-2xl font-bold">{title}</h1>
          {intro && <p className="mt-1 mb-5 text-ink-soft">{intro}</p>}
          {!intro && <div className="mb-5" />}
          {children}
        </div>
      </div>
    </div>
  );
}

export function SetupPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status') });
  const [form, setForm] = useState({ companyName: '', region: 'DE-BE', firstName: '', lastName: '', email: '', password: '' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  if (status.isLoading) return <Spinner />;
  if (status.data && !status.data.needsSetup) return <Navigate to="/" replace />;

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const locale = i18n.language === 'en' ? 'en' : 'de';
      await api.post('/setup', { companyName: form.companyName, region: form.region, locale, admin: { firstName: form.firstName, lastName: form.lastName, email: form.email, password: form.password } });
      await api.post('/auth/login', { email: form.email, password: form.password });
      setLanguage(locale);
      await qc.invalidateQueries();
      navigate('/welcome');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const fe = (p: string) => error?.fieldError?.(p);

  return (
    <AuthShell title={t('setup.title')} intro={t('setup.intro')}>
      <form onSubmit={submit} className="grid gap-4">
        <Field label={t('setup.company')} error={fe('companyName')}>
          <Input required value={form.companyName} onChange={set('companyName')} autoFocus />
        </Field>
        <Field label={t('setup.region')} hint={t('setup.regionHint')} error={fe('region')}>
          <Select value={form.region} onChange={set('region')}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_NAMES[r]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('setup.firstName')} error={fe('admin.firstName')}>
            <Input required value={form.firstName} onChange={set('firstName')} autoComplete="given-name" />
          </Field>
          <Field label={t('setup.lastName')} error={fe('admin.lastName')}>
            <Input required value={form.lastName} onChange={set('lastName')} autoComplete="family-name" />
          </Field>
        </div>
        <Field label={t('setup.email')} error={fe('admin.email')}>
          <Input type="email" required value={form.email} onChange={set('email')} autoComplete="email" />
        </Field>
        <Field label={t('setup.password')} hint={t('setup.passwordHint')} error={fe('admin.password')}>
          <Input type="password" required minLength={10} value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        {error && !error.errors.length && <p className="text-refuse">{error.message}</p>}
        <Button type="submit" variant="primary" busy={busy}>
          {t('setup.submit')}
        </Button>
      </form>
    </AuthShell>
  );
}
