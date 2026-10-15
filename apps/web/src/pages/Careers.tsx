import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { applyTheme, getThemePref } from '../lib/theme';
import { Link, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { Button, Checkbox, Empty, Field, Input, Spinner, Textarea } from '../components/ui';
import { useBranding } from '../components/Photo';

function CareersShell({ company, children }: { company?: string | null; children: ReactNode }) {
  const branding = useBranding();
  // The public careers page follows the visitor's system preference, not the app default.
  useEffect(() => {
    applyTheme('system');
    return () => applyTheme(getThemePref());
  }, []);
  return (
    <div className="min-h-screen bg-sheet">
      <header className="border-b border-rule">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <Link to="/careers" className="flex items-center gap-3 text-lg font-bold">
            {branding?.logoUrl && <img src={branding.logoUrl} alt="" className="h-9 w-auto max-w-[12rem] object-contain" />}
            {company ?? ''}
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-10">{children}</main>
    </div>
  );
}

export function CareersPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['public-jobs'], queryFn: () => api.get('/public/jobs') });
  return (
    <CareersShell company={q.data?.company}>
      <h1 className="text-3xl font-bold">{t('careers.title')}</h1>
      <p className="mt-1 mb-8 text-ink-soft">{t('careers.intro')}</p>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <Empty>{t('careers.empty')}</Empty>
      ) : (
        <ul className="divide-y divide-rule border-y border-rule">
          {q.data.items.map((j: any) => (
            <li key={j.slug}>
              <Link to={`/careers/${j.slug}`} className="group flex flex-wrap items-baseline justify-between gap-2 py-4">
                <span className="text-lg font-bold group-hover:text-stamp group-hover:underline">{j.title}</span>
                <span className="text-ink-soft">{[j.department, j.location, t(`recruiting.employmentTypes.${j.employmentType}`)].filter(Boolean).join(', ')}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </CareersShell>
  );
}

export function CareerJobPage() {
  const { slug } = useParams();
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['public-job', slug], queryFn: () => api.get(`/public/jobs/${slug}`) });
  const list = useQuery({ queryKey: ['public-jobs'], queryFn: () => api.get('/public/jobs') });
  const cvRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', phone: '', coverLetter: '', website: '' });
  const [consent, setConsent] = useState(false);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    const form = new FormData();
    for (const [k, v] of Object.entries(f)) if (v) form.set(k, v);
    form.set('privacyConsent', String(consent));
    const cv = cvRef.current?.files?.[0];
    if (cv) form.set('cv', cv);
    try {
      await api.upload(`/public/jobs/${slug}/apply`, form);
      setState('done');
    } catch (err) {
      setError(err as ApiError);
      setState('idle');
    }
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const fe = (p: string) => error?.fieldError?.(p);

  if (q.isLoading) return <Spinner />;
  if (!q.data)
    return (
      <CareersShell company={list.data?.company}>
        <Empty action={<Link to="/careers" className="font-semibold text-stamp hover:underline">{t('careers.allJobs')}</Link>}>{t('careers.empty')}</Empty>
      </CareersShell>
    );
  const j = q.data;
  return (
    <CareersShell company={list.data?.company}>
      <Link to="/careers" className="text-sm font-semibold text-stamp hover:underline">
        {t('careers.allJobs')}
      </Link>
      <h1 className="mt-3 text-3xl font-bold">{j.title}</h1>
      <p className="mt-1 text-ink-soft">{[j.department, j.location, t(`recruiting.employmentTypes.${j.employmentType}`)].filter(Boolean).join(', ')}</p>
      <div className="mt-6">
        <Markdown text={j.description} />
      </div>

      <section className="mt-10 border-t-2 border-ink pt-6">
        <h2 className="mb-4 text-2xl font-bold">{t('careers.apply')}</h2>
        {state === 'done' ? (
          <p role="status" className="rounded-md border border-grant/40 bg-grant-wash p-4 font-semibold text-grant">
            {t('careers.thanks')}
          </p>
        ) : (
          <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
            <Field label={t('careers.firstName')} error={fe('firstName')}>
              <Input required value={f.firstName} onChange={set('firstName')} autoComplete="given-name" />
            </Field>
            <Field label={t('careers.lastName')} error={fe('lastName')}>
              <Input required value={f.lastName} onChange={set('lastName')} autoComplete="family-name" />
            </Field>
            <Field label={t('careers.email')} error={fe('email')}>
              <Input type="email" required value={f.email} onChange={set('email')} autoComplete="email" />
            </Field>
            <Field label={`${t('careers.phone')} (${t('common.optional')})`}>
              <Input type="tel" value={f.phone} onChange={set('phone')} autoComplete="tel" />
            </Field>
            <Field label={t('careers.coverLetter')} className="sm:col-span-2">
              <Textarea rows={6} value={f.coverLetter} onChange={set('coverLetter')} />
            </Field>
            <Field label={t('careers.cv')} className="sm:col-span-2">
              <input ref={cvRef} type="file" accept=".pdf,.docx" className="block text-sm file:mr-3 file:rounded-[var(--radius-ctl)] file:border file:border-rule file:bg-sheet file:px-3 file:py-2 file:font-semibold" />
            </Field>
            {/* Honeypot for bots – hidden from people and assistive tech. */}
            <div aria-hidden className="absolute -left-[9999px]">
              <input tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')} name="website" />
            </div>
            <div className="sm:col-span-2">
              <Checkbox label={t('careers.consent')} checked={consent} onChange={setConsent} />
              {fe('privacyConsent') && <p className="mt-1 text-sm text-refuse">{fe('privacyConsent')}</p>}
            </div>
            {error && !error.errors.length && <p className="text-refuse sm:col-span-2">{error.message}</p>}
            <div className="sm:col-span-2">
              <Button type="submit" variant="primary" busy={state === 'busy'} disabled={!consent}>
                {t('careers.submit')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </CareersShell>
  );
}
