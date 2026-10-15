import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, Lock, Pencil, Trash2 } from 'lucide-react';
import { PERSON_FIELD_CATEGORY, type AccessLevel, type CategoryAccess, type DataCategory } from '@openpers/shared';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtMinutes, fmtNumber, fullName, todayISO } from '../lib/format';
import { Button, Checkbox, Dialog, Empty, Field, Input, Section, Select, Table, Textarea, useErrorText, useToast } from './ui';
import { ThemeToggle } from './ThemeToggle';
import { setLanguage } from '../lib/i18n';

export type Access = CategoryAccess;

/** Small marker telling the viewer whether a section is editable, read-only or hidden data. */
export function AccessBadge({ level }: { level: AccessLevel }) {
  const { t } = useTranslation();
  if (level === 'edit')
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold text-grant">
        <Pencil size={12} aria-hidden /> {t('access.edit')}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold text-ink-faint">
      {level === 'view' ? <Eye size={12} aria-hidden /> : <Lock size={12} aria-hidden />} {t(`access.${level}`)}
    </span>
  );
}

function CategorySection({ category, access, children, actions }: { category: DataCategory; access: Access; children: ReactNode; actions?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Section
      title={
        <span className="flex items-center gap-3">
          {t(`categories.${category}`)} <AccessBadge level={access[category]} />
        </span>
      }
      actions={actions}
    >
      {children}
    </Section>
  );
}

// ---------- Overview ----------

export function ProfileOverview({ person }: { person: any }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const year = new Date().getFullYear();
  const emp = person.currentEmployment;
  const balances = useQuery({ queryKey: ['balances', person.id, year], queryFn: () => api.get(`/persons/${person.id}/balances?year=${year}`), enabled: can('absence.read') });
  const timeBalance = useQuery({ queryKey: ['time-balance', person.id], queryFn: () => api.get(`/persons/${person.id}/time-balance`), enabled: can('time.read') });
  const upcoming = useQuery({ queryKey: ['absences', person.id, 'upcoming'], queryFn: () => api.get(`/absence-periods?personId=${person.id}&from=${todayISO()}`), enabled: can('absence.read') });
  const vacation = balances.data?.items?.[0];
  const next = (upcoming.data?.items ?? []).filter((a: any) => ['approved', 'pending'].includes(a.status)).sort((a: any, b: any) => a.startDate.localeCompare(b.startDate))[0];
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-ink-soft">{label}</dt>
      <dd className="font-semibold">{value || '–'}</dd>
    </>
  );
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Section title={t('profile.work')} className="lg:col-span-2">
        <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-2">
          {row(t('people.position'), emp?.positionTitle)}
          {row(t('person.orgUnits'), emp?.orgUnits?.map((o: any) => o.name).join(', '))}
          {emp?.supervisor !== undefined &&
            row(
              t('person.supervisor'),
              emp?.supervisor ? (
                <Link to={`/people/${emp.supervisor.id}`} className="text-stamp hover:underline">
                  {fullName(emp.supervisor)}
                </Link>
              ) : null,
            )}
          {emp?.startDate && row(t('people.startDate'), fmtDate(emp.startDate))}
          {emp?.contractType && row(t('person.contractType'), t(`person.contractTypes.${emp.contractType}`))}
          {emp?.probationEndDate && row(t('person.probationEndDate'), fmtDate(emp.probationEndDate))}
          {row(t('person.email'), person.email && <a href={`mailto:${person.email}`} className="text-stamp hover:underline">{person.email}</a>)}
          {person.phone !== undefined && row(t('person.phone'), person.phone)}
        </dl>
      </Section>
      <div className="grid content-start gap-5">
        {vacation && (
          <Section title={t('dashboard.vacationLeft', { year })}>
            <p className="tnum text-3xl font-bold">
              {fmtNumber(vacation.available)} <span className="text-base font-semibold text-ink-soft">{t('absence.days')}</span>
            </p>
            {next && (
              <p className="mt-2 text-sm text-ink-soft">
                {t('profile.nextAbsence')}: {next.typeName}, {fmtDate(next.startDate)}
              </p>
            )}
          </Section>
        )}
        {timeBalance.data && (
          <Section title={t('dashboard.overtime')}>
            <p className={`tnum text-2xl font-bold ${timeBalance.data.balanceMinutes < 0 ? 'text-refuse' : ''}`}>{fmtMinutes(timeBalance.data.balanceMinutes, true)}</p>
          </Section>
        )}
        <Section title={t('profile.yourAccess')}>
          <ul className="grid gap-1.5 text-sm">
            {(Object.keys(person.access) as DataCategory[]).map((c) => (
              <li key={c} className="flex items-center justify-between gap-3">
                <span>{t(`categories.${c}`)}</span>
                <AccessBadge level={person.access[c]} />
              </li>
            ))}
          </ul>
        </Section>
      </div>
    </div>
  );
}

// ---------- Personal data (profile, contact, personal + their custom fields) ----------

const FIELD_ORDER: Record<'profile' | 'contact' | 'personal', string[]> = {
  profile: ['firstName', 'lastName', 'preferredName', 'email'],
  contact: ['phone', 'emergencyContact'],
  personal: ['birthDate', 'gender', 'language', 'privateAddress'],
};

function AttributeInput({ def, value, disabled, onChange }: { def: any; value: unknown; disabled: boolean; onChange: (v: unknown) => void }) {
  if (def.type === 'boolean') return <Checkbox label={def.label} checked={!!value} onChange={(v) => !disabled && onChange(v)} />;
  return (
    <Field
      label={
        <span className="inline-flex items-center gap-1.5">
          {def.label}
          {def.sensitive && <Lock size={12} className="text-ink-faint" aria-hidden />}
        </span>
      }
    >
      {def.type === 'select' ? (
        <Select value={(value as string) ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">–</option>
          {(def.options ?? []).map((o: string) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
      ) : (
        <Input
          type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={(e) => onChange(def.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
        />
      )}
    </Field>
  );
}

/** Edits the given categories of a person; every field is editable only with `edit` on its category. */
export function CategoryForm({ person, categories }: { person: any; categories: DataCategory[] }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const access: Access = person.access;
  const defs = useQuery({ queryKey: ['attribute-definitions'], queryFn: () => api.get('/attribute-definitions') });
  const [f, setF] = useState<any>(person);
  const [attrs, setAttrs] = useState<Record<string, unknown>>(person.attributes ?? {});
  useEffect(() => {
    setF(person);
    setAttrs(person.attributes ?? {});
  }, [person]);
  const visibleCats = categories.filter((c) => access[c] !== 'none');
  const editableCats = visibleCats.filter((c) => access[c] === 'edit');
  const fieldsOf = (c: DataCategory) => (FIELD_ORDER as Record<string, string[]>)[c] ?? [];
  const defsOf = (c: DataCategory) => (defs.data?.items ?? []).filter((d: any) => d.category === c);

  const save = useMutation({
    mutationFn: async () => {
      const keys = editableCats.flatMap(fieldsOf).filter((k) => JSON.stringify(f[k] ?? null) !== JSON.stringify(person[k] ?? null));
      const required = ['firstName', 'lastName', 'email', 'gender', 'language'];
      const body = Object.fromEntries(keys.map((k) => [k, f[k] === '' ? null : f[k]]).filter(([k, v]) => v !== null || !required.includes(k as string)));
      if (Object.keys(body).length) await api.patch(`/persons/${person.id}`, body);
      const attrKeys = editableCats.flatMap(defsOf).map((d: any) => d.key);
      const changed = Object.fromEntries(
        Object.entries(attrs)
          .filter(([k, v]) => attrKeys.includes(k) && JSON.stringify(v) !== JSON.stringify(person.attributes?.[k]))
          .map(([k, v]) => [k, v === '' ? null : v]),
      );
      if (Object.keys(changed).length) await api.put(`/persons/${person.id}/attributes`, changed);
    },
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['person', person.id] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });

  const input = (k: string) => {
    const disabled = access[PERSON_FIELD_CATEGORY[k]] !== 'edit';
    const label = t(`person.${k}`);
    if (k === 'gender')
      return (
        <Field key={k} label={label}>
          <Select value={f.gender ?? 'UNKNOWN'} disabled={disabled} onChange={(e) => setF({ ...f, gender: e.target.value })}>
            {Object.entries(t('person.genders', { returnObjects: true }) as Record<string, string>).map(([key, v]) => (
              <option key={key} value={key}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
      );
    if (k === 'language')
      return (
        <Field key={k} label={label}>
          <Select value={f.language ?? 'de'} disabled={disabled} onChange={(e) => setF({ ...f, language: e.target.value })}>
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </Select>
        </Field>
      );
    if (k === 'privateAddress')
      return (
        <Field key={k} label={label} className="sm:col-span-2">
          <Textarea rows={2} value={f.privateAddress ?? ''} disabled={disabled} onChange={(e) => setF({ ...f, privateAddress: e.target.value })} />
        </Field>
      );
    return (
      <Field key={k} label={label}>
        <Input type={k === 'birthDate' ? 'date' : k === 'email' ? 'email' : k === 'phone' ? 'tel' : 'text'} value={f[k] ?? ''} disabled={disabled} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      </Field>
    );
  };

  if (!visibleCats.length) return <Empty>{t('access.noAccess')}</Empty>;
  return (
    <div className="grid gap-5">
      {visibleCats.map((c) => (
        <CategorySection key={c} category={c} access={access}>
          <div className="grid gap-4 sm:grid-cols-2">
            {fieldsOf(c).map(input)}
            {defsOf(c).map((d: any) => (
              <div key={d.id} className={d.type === 'boolean' ? 'self-end pb-2' : ''}>
                <AttributeInput def={d} value={attrs[d.key]} disabled={access[c] !== 'edit'} onChange={(v) => setAttrs({ ...attrs, [d.key]: v })} />
              </div>
            ))}
            {fieldsOf(c).length === 0 && defsOf(c).length === 0 && <p className="text-ink-soft sm:col-span-2">{t('profile.noFields')}</p>}
          </div>
        </CategorySection>
      ))}
      {editableCats.length > 0 && (
        <div className="flex justify-end">
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------- Compensation ----------

export function CompensationSection({ person }: { person: any }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const access: Access = person.access;
  const editable = access.compensation === 'edit';
  const q = useQuery({ queryKey: ['compensations', person.id], queryFn: () => api.get(`/persons/${person.id}/compensations`) });
  const [form, setForm] = useState<{ type: string; amount: string; currency: string; interval: string; validFrom: string; comment: string } | null>(null);
  const add = useMutation({
    mutationFn: () => api.post(`/persons/${person.id}/compensations`, { type: form!.type, amount: Number(form!.amount.replace(',', '.')), currency: form!.currency, interval: form!.interval || null, validFrom: form!.validFrom, comment: form!.comment || null }),
    onSuccess: () => {
      toast(t('common.saved'));
      setForm(null);
      qc.invalidateQueries({ queryKey: ['compensations', person.id] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/persons/${person.id}/compensations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['compensations', person.id] }),
  });
  const money = (n: number, c: string) => n.toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { style: 'currency', currency: c });
  const today = todayISO();
  const current = (q.data?.items ?? []).find((c: any) => c.type === 'FIXED_SALARY' && c.validFrom <= today) ?? (q.data?.items ?? []).find((c: any) => c.type === 'HOURLY_SALARY' && c.validFrom <= today);
  return (
    <CategorySection
      category="compensation"
      access={access}
      actions={
        editable && (
          <Button size="sm" onClick={() => setForm({ type: 'FIXED_SALARY', amount: '', currency: 'EUR', interval: 'MONTHLY', validFrom: today, comment: '' })}>
            {t('common.add')}
          </Button>
        )
      }
    >
      {current && (
        <p className="mb-4">
          <span className="text-ink-soft">{t('compensation.current')}: </span>
          <span className="tnum text-2xl font-bold">{money(current.amount, current.currency)}</span>
          <span className="text-ink-soft"> {current.interval ? t(`compensation.intervals.${current.interval}`) : t('compensation.perHour')}</span>
        </p>
      )}
      {!q.data?.items.length ? (
        <Empty>{t('compensation.empty')}</Empty>
      ) : (
        <Table head={[t('person.validFrom'), t('compensation.type'), t('compensation.amount'), t('common.comment'), '']}>
          {q.data.items.map((c: any) => (
            <tr key={c.id}>
              <td className="tnum">{fmtDate(c.validFrom)}</td>
              <td>{t(`compensation.types.${c.type}`)}</td>
              <td className="tnum font-semibold">
                {money(c.amount, c.currency)} <span className="font-normal text-ink-soft">{c.interval ? t(`compensation.intervals.${c.interval}`) : ''}</span>
              </td>
              <td className="text-ink-soft">{c.comment}</td>
              <td className="text-right">
                {editable && (
                  <button type="button" aria-label={t('common.delete')} className="rounded p-1.5 text-ink-faint hover:bg-refuse-wash hover:text-refuse" onClick={() => confirm(t('common.confirmDelete')) && del.mutate(c.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={t('compensation.add')}
        footer={
          <Button variant="primary" busy={add.isPending} onClick={() => add.mutate()}>
            {t('common.save')}
          </Button>
        }
      >
        {form && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('compensation.type')}>
              <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, interval: e.target.value === 'ONE_TIME' || e.target.value === 'HOURLY_SALARY' ? '' : form.interval || 'MONTHLY' })}>
                {['FIXED_SALARY', 'HOURLY_SALARY', 'RECURRING', 'ONE_TIME'].map((x) => (
                  <option key={x} value={x}>
                    {t(`compensation.types.${x}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('person.validFrom')}>
              <Input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
            </Field>
            <Field label={t('compensation.amount')}>
              <Input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </Field>
            <Field label={t('compensation.currency')}>
              <Input value={form.currency} maxLength={3} onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })} />
            </Field>
            {(form.type === 'FIXED_SALARY' || form.type === 'RECURRING') && (
              <Field label={t('compensation.interval')}>
                <Select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value })}>
                  <option value="MONTHLY">{t('compensation.intervals.MONTHLY')}</option>
                  <option value="YEARLY">{t('compensation.intervals.YEARLY')}</option>
                </Select>
              </Field>
            )}
            <Field label={`${t('common.comment')} (${t('common.optional')})`} className="sm:col-span-2">
              <Input value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
            </Field>
          </div>
        )}
      </Dialog>
    </CategorySection>
  );
}

// ---------- Own account settings ----------

export function OwnAccountSection() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const errText = useErrorText();
  const [pw, setPw] = useState({ current: '', next: '' });
  const change = useMutation({
    mutationFn: () => api.post('/auth/password', { currentPassword: pw.current, newPassword: pw.next }),
    onSuccess: () => {
      toast(t('profile.passwordChanged'));
      setPw({ current: '', next: '' });
      setTimeout(() => (location.href = '/login'), 1200);
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Section title={t('profile.preferences')}>
        <div className="grid gap-4">
          <Field label={t('common.language')}>
            <Select
              value={i18n.language === 'en' ? 'en' : 'de'}
              onChange={(e) => {
                const lng = e.target.value as 'de' | 'en';
                setLanguage(lng);
                api.patch('/auth/me', { locale: lng }).catch(() => {});
              }}
            >
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <div>
            <span className="mb-1 block text-sm font-semibold">{t('theme.label')}</span>
            <ThemeToggle />
          </div>
        </div>
      </Section>
      <Section title={t('profile.changePassword')}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <Field label={t('profile.currentPassword')}>
            <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </Field>
          <Field label={t('profile.newPassword')} hint={t('setup.passwordHint')}>
            <Input type="password" autoComplete="new-password" minLength={10} value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </Field>
          <div>
            <Button type="submit" variant="primary" busy={change.isPending} disabled={!pw.current || pw.next.length < 10}>
              {t('profile.changePassword')}
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}
