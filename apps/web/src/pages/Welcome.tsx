import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Check, CheckCircle2, Circle, FileText, KeyRound, MapPin, Network, Plus, SkipForward, Trash2, Users } from 'lucide-react';
import { REGION_NAMES, REGIONS } from '@openpers/shared';
import { api } from '../lib/api';
import { fmtDate, fullName, todayISO } from '../lib/format';
import { LogoEditor } from '../components/Photo';
import { CompanyDocUpload, useCompanyDocs } from '../components/CompanyDocs';
import { Button, Checkbox, cx, Field, Input, Select, Spinner, useErrorText, useToast } from '../components/ui';
import { FormFields, type FieldSpec } from './settings/Crud';

type StepKey = 'company' | 'locations' | 'departments' | 'roles' | 'documents' | 'people';
interface Guide {
  steps: { key: StepKey; status: 'open' | 'done' | 'skipped'; count?: number }[];
  completed: number;
  total: number;
  dismissed: boolean;
}

const ICONS: Record<StepKey, typeof Building2> = { company: Building2, locations: MapPin, departments: Network, roles: KeyRound, documents: FileText, people: Users };

export function useSetupGuide(enabled = true) {
  return useQuery({ queryKey: ['setup-guide'], queryFn: () => api.get<Guide>('/setup-guide'), enabled });
}

function useStepStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, status }: { key: StepKey; status: 'done' | 'skipped' | 'open' }) => api.post<Guide>(`/setup-guide/steps/${key}`, { status }),
    onSuccess: (g) => qc.setQueryData(['setup-guide'], g),
  });
}

function StepFrame({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="grid gap-5">
      <div>
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="mt-1 max-w-2xl text-ink-soft">{intro}</p>
      </div>
      {children}
    </div>
  );
}

// ---------- 1. Company ----------
function CompanyStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['company'], queryFn: () => api.get('/company') });
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (q.data && !f) setF({ name: q.data.name, region: q.data.region, timezone: q.data.timezone });
  }, [q.data, f]);
  const save = useMutation({
    mutationFn: () => api.patch('/company', f),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['company'] });
      qc.invalidateQueries({ queryKey: ['branding'] });
      onSaved();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (!f) return <Spinner />;
  const fields: FieldSpec[] = [
    { key: 'name', label: t('settings.companyName'), required: true },
    { key: 'region', label: t('settings.defaultRegion'), type: 'region', required: true, hint: t('setup.regionHint') },
    { key: 'timezone', label: t('settings.timezone') },
  ];
  return (
    <StepFrame title={t('welcome.company.title')} intro={t('welcome.company.intro')}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="max-w-md">
          <FormFields fields={fields} value={f} onChange={setF} />
        </div>
        <LogoEditor />
      </div>
      <div>
        <Button variant="primary" busy={save.isPending} disabled={!f.name?.trim()} onClick={() => save.mutate()}>
          {t('welcome.saveNext')}
        </Button>
      </div>
    </StepFrame>
  );
}

// ---------- 2. Locations ----------
function LocationsStep({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const company = useQuery({ queryKey: ['company'], queryFn: () => api.get('/company') });
  const q = useQuery({ queryKey: ['workplaces'], queryFn: () => api.get('/workplaces') });
  const [f, setF] = useState({ name: '', region: '', address: '' });
  const refresh = () => ['workplaces', 'setup-guide'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const add = useMutation({
    mutationFn: () => api.post('/workplaces', { name: f.name, region: f.region || company.data?.region, address: f.address || null }),
    onSuccess: () => (setF({ name: '', region: '', address: '' }), refresh()),
    onError: (e) => toast(errText(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/workplaces/${id}`), onSuccess: refresh, onError: (e) => toast(errText(e), 'error') });
  const items = q.data?.items ?? [];
  return (
    <StepFrame title={t('welcome.locations.title')} intro={t('welcome.locations.intro')}>
      {items.length > 0 && (
        <ul className="grid gap-2">
          {items.map((w: any) => (
            <li key={w.id} className="flex items-center gap-3 rounded-md border border-rule bg-sheet px-3 py-2">
              <MapPin size={16} className="text-ink-faint" aria-hidden />
              <span className="font-semibold">{w.name}</span>
              <span className="text-sm text-ink-soft">{[REGION_NAMES[w.region as keyof typeof REGION_NAMES], w.address].filter(Boolean).join(' · ')}</span>
              <Button size="sm" variant="ghost" className="ml-auto" aria-label={t('common.delete')} onClick={() => remove.mutate(w.id)}>
                <Trash2 size={14} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid max-w-3xl gap-3 rounded-md border border-dashed border-rule p-3 sm:grid-cols-[1fr_12rem_1fr_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (f.name.trim()) add.mutate();
        }}
      >
        <Field label={t('welcome.locations.name')}>
          <Input value={f.name} placeholder={t('welcome.locations.namePlaceholder')} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('welcome.locations.region')}>
          <Select value={f.region || company.data?.region || ''} onChange={(e) => setF({ ...f, region: e.target.value })}>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_NAMES[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('welcome.locations.address')} (${t('common.optional')})`}>
          <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
        </Field>
        <Button type="submit" busy={add.isPending} disabled={!f.name.trim()}>
          <Plus size={14} aria-hidden /> {t('common.add')}
        </Button>
      </form>
      <p className="text-sm text-ink-soft">{t('welcome.locations.hint')}</p>
      <div>
        <Button variant="primary" disabled={!items.length} onClick={next}>
          {t('welcome.next')}
        </Button>
      </div>
    </StepFrame>
  );
}

// ---------- 3. Departments & teams ----------
function DepartmentsStep({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const [custom, setCustom] = useState({ name: '', parentId: '' });
  const refresh = () => ['org-units', 'setup-guide'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const add = useMutation({
    mutationFn: (u: { name: string; parentId?: string }) => api.post('/org-units', { name: u.name, type: u.parentId ? 'team' : 'department', parentId: u.parentId || null }),
    onSuccess: () => (setCustom({ name: '', parentId: '' }), refresh()),
    onError: (e) => toast(errText(e), 'error'),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/org-units/${id}`), onSuccess: refresh, onError: (e) => toast(errText(e), 'error') });
  const units: any[] = q.data?.items ?? [];
  const departments = units.filter((u) => !u.parentId);
  const suggestions = t('welcome.departments.suggestions', { returnObjects: true }) as string[];
  const exists = (name: string) => units.some((u) => u.name.toLowerCase() === name.toLowerCase());
  return (
    <StepFrame title={t('welcome.departments.title')} intro={t('welcome.departments.intro')}>
      <div>
        <p className="mb-2 text-sm font-semibold">{t('welcome.departments.pick')}</p>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((s) => {
            const on = exists(s);
            return (
              <button
                key={s}
                type="button"
                disabled={on || add.isPending}
                aria-pressed={on}
                onClick={() => add.mutate({ name: s })}
                className={cx('flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-semibold', on ? 'border-grant bg-grant/10 text-grant' : 'border-rule bg-sheet text-ink-soft hover:border-stamp hover:text-stamp')}
              >
                {on ? <Check size={14} aria-hidden /> : <Plus size={14} aria-hidden />} {s}
              </button>
            );
          })}
        </div>
      </div>
      <form
        className="grid max-w-3xl gap-3 sm:grid-cols-[1fr_17rem_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (custom.name.trim()) add.mutate(custom);
        }}
      >
        <Field label={t('welcome.departments.custom')}>
          <Input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
        </Field>
        <Field label={t('welcome.departments.parent')}>
          <Select value={custom.parentId} onChange={(e) => setCustom({ ...custom, parentId: e.target.value })}>
            <option value="">{t('welcome.departments.asDepartment')}</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {t('welcome.departments.teamIn', { name: d.name })}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" busy={add.isPending} disabled={!custom.name.trim()}>
          <Plus size={14} aria-hidden /> {t('common.add')}
        </Button>
      </form>
      {departments.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {departments.map((d) => (
            <li key={d.id} className="rounded-md border border-rule bg-sheet p-3">
              <div className="flex items-center gap-2">
                <Network size={15} className="text-ink-faint" aria-hidden />
                <span className="font-semibold">{d.name}</span>
                <Button size="sm" variant="ghost" className="ml-auto" aria-label={t('common.delete')} onClick={() => remove.mutate(d.id)}>
                  <Trash2 size={14} />
                </Button>
              </div>
              {units
                .filter((u) => u.parentId === d.id)
                .map((team) => (
                  <div key={team.id} className="mt-1 flex items-center gap-2 pl-6 text-sm text-ink-soft">
                    {team.name}
                    <button type="button" aria-label={t('common.delete')} className="ml-auto rounded p-1 hover:bg-rule-soft" onClick={() => remove.mutate(team.id)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
            </li>
          ))}
        </ul>
      )}
      <div>
        <Button variant="primary" disabled={!units.length} onClick={next}>
          {t('welcome.next')}
        </Button>
      </div>
    </StepFrame>
  );
}

// ---------- 4. Roles & access ----------
type Level = 'none' | 'view' | 'edit';
interface Role {
  id: string;
  key: string;
  name: string;
  builtin: boolean;
  fieldAccess: Record<string, { self: Level; others: Level }>;
}

function RolesStep({ onSaved }: { onSaved: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ items: Role[] }>('/roles') });
  const roles = q.data?.items ?? [];
  const manager = roles.find((r) => r.key === 'manager');
  const employee = roles.find((r) => r.key === 'employee');
  const [a, setA] = useState<Record<string, boolean> | null>(null);
  useEffect(() => {
    if (manager && employee && !a)
      setA({
        managerCompensation: manager.fieldAccess.compensation.others !== 'none',
        managerPersonal: manager.fieldAccess.personal.others !== 'none',
        managerPayroll: manager.fieldAccess.payroll.others !== 'none',
        employeeEditsPersonal: employee.fieldAccess.personal.self === 'edit',
      });
  }, [manager, employee, a]);
  const save = useMutation({
    mutationFn: async () => {
      const lvl = (on: boolean): Level => (on ? 'view' : 'none');
      await api.patch(`/roles/${manager!.id}`, { fieldAccess: { compensation: { others: lvl(a!.managerCompensation) }, personal: { others: lvl(a!.managerPersonal) }, payroll: { others: lvl(a!.managerPayroll) } } });
      await api.patch(`/roles/${employee!.id}`, { fieldAccess: { personal: { self: a!.employeeEditsPersonal ? 'edit' : 'view' }, contact: { self: a!.employeeEditsPersonal ? 'edit' : 'view' } } });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles'] });
      onSaved();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (!a) return <Spinner />;
  const questions: { key: string; label: string; hint: string }[] = ['managerCompensation', 'managerPersonal', 'managerPayroll', 'employeeEditsPersonal'].map((k) => ({ key: k, label: t(`welcome.roles.q.${k}`), hint: t(`welcome.roles.qHint.${k}`) }));
  return (
    <StepFrame title={t('welcome.roles.title')} intro={t('welcome.roles.intro')}>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {['admin', 'hr', 'manager', 'employee'].map((k) => (
          <li key={k} className="rounded-md border border-rule bg-sheet p-3">
            <div className="font-semibold">{roles.find((r) => r.key === k)?.name ?? k}</div>
            <p className="mt-1 text-sm text-ink-soft">{t(`welcome.roles.describe.${k}`)}</p>
          </li>
        ))}
      </ul>
      <div className="grid max-w-2xl gap-3">
        <p className="text-sm font-semibold">{t('welcome.roles.questions')}</p>
        {questions.map((qq) => (
          <Checkbox key={qq.key} label={qq.label} hint={qq.hint} checked={a[qq.key]} onChange={(v) => setA({ ...a, [qq.key]: v })} />
        ))}
        <p className="text-sm text-ink-soft">
          {t('welcome.roles.more')}{' '}
          <Link to="/settings/users" className="font-semibold text-stamp hover:underline">
            {t('welcome.roles.matrix')}
          </Link>
        </p>
      </div>
      <div>
        <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
          {t('welcome.saveNext')}
        </Button>
      </div>
    </StepFrame>
  );
}

// ---------- 5. Company documents ----------
interface Recommended {
  title: string;
  why: string;
  requiresAck: boolean;
}

function DocumentsStep({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const docs = useCompanyDocs();
  const [upload, setUpload] = useState<{ title: string; requiresAck: boolean } | null>(null);
  const recommended = t('welcome.documents.recommended', { returnObjects: true }) as Recommended[];
  const items = docs.data?.items ?? [];
  const uploaded = (title: string) => items.find((d) => d.title.toLowerCase() === title.toLowerCase());
  const others = items.filter((d) => !recommended.some((r) => r.title.toLowerCase() === d.title.toLowerCase()));
  return (
    <StepFrame title={t('welcome.documents.title')} intro={t('welcome.documents.intro')}>
      <ul className="grid gap-2">
        {recommended.map((r) => {
          const done = uploaded(r.title);
          return (
            <li key={r.title} className="flex flex-wrap items-center gap-3 rounded-md border border-rule bg-sheet px-3 py-2.5">
              {done ? <CheckCircle2 size={18} className="text-grant" aria-hidden /> : <Circle size={18} className="text-ink-faint" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{r.title}</div>
                <p className="text-sm text-ink-soft">{r.why}</p>
              </div>
              {r.requiresAck && <span className="stamp text-ink-soft">{t('welcome.documents.ack')}</span>}
              {done ? (
                <span className="text-sm text-grant">{t('welcome.documents.uploadedOn', { date: fmtDate(done.createdAt) })}</span>
              ) : (
                <Button size="sm" onClick={() => setUpload({ title: r.title, requiresAck: r.requiresAck })}>
                  {t('companyDocs.upload')}
                </Button>
              )}
            </li>
          );
        })}
        {others.map((d) => (
          <li key={d.id} className="flex items-center gap-3 rounded-md border border-rule bg-sheet px-3 py-2.5">
            <CheckCircle2 size={18} className="text-grant" aria-hidden />
            <span className="flex-1 font-semibold">{d.title}</span>
            {d.requiresAck && <span className="stamp text-ink-soft">{t('welcome.documents.ack')}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setUpload({ title: '', requiresAck: false })}>
          <Plus size={14} aria-hidden /> {t('welcome.documents.custom')}
        </Button>
      </div>
      <p className="text-sm text-ink-soft">{t('welcome.documents.hint')}</p>
      <div>
        <Button variant="primary" disabled={!items.length} onClick={next}>
          {t('welcome.next')}
        </Button>
      </div>
      {upload && <CompanyDocUpload preset={upload} onClose={() => setUpload(null)} />}
    </StepFrame>
  );
}

// ---------- 6. First employees ----------
function PeopleStep({ next }: { next: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const people = useQuery({ queryKey: ['persons', 'welcome'], queryFn: () => api.get('/persons?limit=200') });
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const workplaces = useQuery({ queryKey: ['workplaces'], queryFn: () => api.get('/workplaces') });
  const empty = { firstName: '', lastName: '', email: '', positionTitle: '', orgUnitId: '', workplaceId: '', startDate: todayISO() };
  const [f, setF] = useState(empty);
  const add = useMutation({
    mutationFn: () =>
      api.post('/persons', {
        firstName: f.firstName,
        lastName: f.lastName,
        email: f.email,
        employment: { startDate: f.startDate, positionTitle: f.positionTitle || null, orgUnitIds: f.orgUnitId ? [f.orgUnitId] : [], workplaceId: f.workplaceId || null },
      }),
    onSuccess: () => {
      toast(t('welcome.people.added', { name: `${f.firstName} ${f.lastName}` }));
      setF({ ...empty, orgUnitId: f.orgUnitId, workplaceId: f.workplaceId, startDate: f.startDate });
      ['persons', 'setup-guide', 'directory'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const valid = f.firstName.trim() && f.lastName.trim() && /.+@.+\..+/.test(f.email) && f.startDate;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <StepFrame title={t('welcome.people.title')} intro={t('welcome.people.intro')}>
      <form
        className="grid gap-3 rounded-md border border-dashed border-rule p-3 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) add.mutate();
        }}
      >
        <Field label={t('person.firstName')}>
          <Input value={f.firstName} onChange={set('firstName')} />
        </Field>
        <Field label={t('person.lastName')}>
          <Input value={f.lastName} onChange={set('lastName')} />
        </Field>
        <Field label={t('person.email')}>
          <Input type="email" value={f.email} onChange={set('email')} />
        </Field>
        <Field label={t('people.position')}>
          <Input value={f.positionTitle} onChange={set('positionTitle')} />
        </Field>
        <Field label={t('welcome.people.department')}>
          <Select value={f.orgUnitId} onChange={set('orgUnitId')}>
            <option value="">–</option>
            {(units.data?.items ?? []).map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('welcome.people.location')}>
          <Select value={f.workplaceId} onChange={set('workplaceId')}>
            <option value="">–</option>
            {(workplaces.data?.items ?? []).map((w: any) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('people.startDate')}>
          <Input type="date" value={f.startDate} onChange={set('startDate')} />
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="primary" busy={add.isPending} disabled={!valid} className="w-full">
            <Plus size={14} aria-hidden /> {t('common.add')}
          </Button>
        </div>
      </form>
      {(people.data?.items ?? []).length > 0 && (
        <ul className="grid gap-1 text-sm">
          {people.data.items.map((p: any) => (
            <li key={p.id} className="flex gap-2">
              <CheckCircle2 size={16} className="text-grant" aria-hidden />
              <span className="font-semibold">{fullName(p)}</span>
              <span className="text-ink-soft">{[p.positionTitle, p.orgUnits?.map((o: any) => o.name).join(', ')].filter(Boolean).join(' · ')}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-ink-soft">{t('welcome.people.hint')}</p>
      <div>
        <Button variant="primary" onClick={next}>
          {t('welcome.next')}
        </Button>
      </div>
    </StepFrame>
  );
}

function DoneStep({ guide }: { guide: Guide }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const finish = useMutation({
    mutationFn: () => api.post('/setup-guide/dismiss'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['setup-guide'] });
      navigate('/');
    },
  });
  const skipped = guide.steps.filter((s) => s.status === 'skipped');
  return (
    <StepFrame title={t('welcome.done.title')} intro={t('welcome.done.intro')}>
      {skipped.length > 0 && <p className="text-sm text-wait">{t('welcome.done.skipped', { steps: skipped.map((s) => t(`welcome.steps.${s.key}`)).join(', ') })}</p>}
      <ul className="grid gap-1 text-sm text-ink-soft">
        {(t('welcome.done.nextIdeas', { returnObjects: true }) as string[]).map((x) => (
          <li key={x}>→ {x}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" busy={finish.isPending} onClick={() => finish.mutate()}>
          {t('welcome.done.toDashboard')}
        </Button>
        <Link to="/settings" className="rounded-[var(--radius-ctl)] border border-rule px-3 py-2 font-semibold hover:bg-rule-soft">
          {t('welcome.done.toSettings')}
        </Link>
      </div>
    </StepFrame>
  );
}

export function WelcomePage() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const guide = useSetupGuide();
  const status = useStepStatus();
  if (guide.isLoading) return <Spinner />;
  if (guide.isError || !guide.data) return <p className="text-refuse">{t('common.forbidden')}</p>;
  const g = guide.data;
  const keys = g.steps.map((s) => s.key);
  const firstOpen = g.steps.find((s) => s.status === 'open')?.key;
  const current = (params.get('step') as StepKey | 'done' | null) ?? firstOpen ?? 'done';
  const go = (k: StepKey | 'done') => setParams({ step: k }, { replace: false });
  const after = (k: StepKey) => {
    const i = keys.indexOf(k);
    const rest = [...keys.slice(i + 1), ...keys.slice(0, i)];
    return rest.find((x) => g.steps.find((s) => s.key === x)?.status === 'open') ?? 'done';
  };
  const complete = (k: StepKey) => status.mutate({ key: k, status: 'done' }, { onSuccess: (ng) => go(ng.steps.find((s) => s.status === 'open' && keys.indexOf(s.key) > keys.indexOf(k))?.key ?? ng.steps.find((s) => s.status === 'open')?.key ?? 'done') });
  const skip = (k: StepKey) => status.mutate({ key: k, status: 'skipped' }, { onSuccess: () => go(after(k)) });
  const pct = Math.round((g.completed / g.total) * 100);
  return (
    <div>
      <header className="mb-6">
        <h1 className="text-3xl font-bold">{t('welcome.title')}</h1>
        <p className="mt-1 text-ink-soft">{t('welcome.intro')}</p>
        <div className="mt-4 flex max-w-md items-center gap-3">
          <div className="h-2 flex-1 rounded-full bg-rule-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('welcome.progress')}>
            <div className="h-2 rounded-full bg-grant transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="tnum text-sm font-semibold">{t('welcome.ofSteps', { done: g.completed, total: g.total })}</span>
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <nav aria-label={t('welcome.progress')}>
          <ol className="grid gap-1">
            {g.steps.map((s, i) => {
              const Icon = ICONS[s.key];
              return (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => go(s.key)}
                    aria-current={current === s.key ? 'step' : undefined}
                    className={cx('flex w-full items-center gap-2.5 rounded-[var(--radius-ctl)] px-2.5 py-2 text-left font-semibold', current === s.key ? 'bg-stamp-wash text-stamp' : 'text-ink-soft hover:bg-rule-soft hover:text-ink')}
                  >
                    {s.status === 'done' ? <CheckCircle2 size={18} className="text-grant" aria-hidden /> : s.status === 'skipped' ? <SkipForward size={18} className="text-ink-faint" aria-hidden /> : <Icon size={18} aria-hidden />}
                    <span className="flex-1">
                      {i + 1}. {t(`welcome.steps.${s.key}`)}
                    </span>
                    <span className="sr-only">{t(`welcome.status.${s.status}`)}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <section className="min-w-0 rounded-md border border-rule bg-sheet p-5">
          {current === 'company' && <CompanyStep onSaved={() => complete('company')} />}
          {current === 'locations' && <LocationsStep next={() => complete('locations')} />}
          {current === 'departments' && <DepartmentsStep next={() => complete('departments')} />}
          {current === 'roles' && <RolesStep onSaved={() => complete('roles')} />}
          {current === 'documents' && <DocumentsStep next={() => complete('documents')} />}
          {current === 'people' && <PeopleStep next={() => complete('people')} />}
          {current === 'done' && <DoneStep guide={g} />}
          {current !== 'done' && g.steps.find((s) => s.key === current)?.status !== 'done' && (
            <div className="mt-6 border-t border-rule pt-4">
              <Button variant="ghost" size="sm" onClick={() => skip(current as StepKey)}>
                <SkipForward size={14} aria-hidden /> {t('welcome.skip')}
              </Button>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/** Dashboard card for admins until the setup guide is finished or hidden. */
export function SetupGuideCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const guide = useSetupGuide();
  const hide = useMutation({ mutationFn: () => api.post<Guide>('/setup-guide/dismiss'), onSuccess: (g) => qc.setQueryData(['setup-guide'], g) });
  const g = guide.data;
  if (!g || g.dismissed || g.completed >= g.total) return null;
  const next = g.steps.find((s) => s.status === 'open');
  const pct = Math.round((g.completed / g.total) * 100);
  return (
    <div className="mb-5 flex flex-wrap items-center gap-4 rounded-md border border-stamp/40 bg-stamp-wash p-4">
      <div className="min-w-0 flex-1">
        <div className="font-bold">{t('welcome.card.title')}</div>
        <p className="text-sm text-ink-soft">{t('welcome.card.text', { done: g.completed, total: g.total, next: next ? t(`welcome.steps.${next.key}`) : '–' })}</p>
        <div className="mt-2 h-1.5 max-w-sm rounded-full bg-sheet" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('welcome.progress')}>
          <div className="h-1.5 rounded-full bg-grant" style={{ width: `${pct}%` }} />
        </div>
      </div>
      <Link to={next ? `/welcome?step=${next.key}` : '/welcome'} className="rounded-[var(--radius-ctl)] bg-stamp px-3 py-2 text-sm font-semibold text-on-stamp">
        {t('welcome.card.continue')}
      </Link>
      <Button size="sm" variant="ghost" busy={hide.isPending} onClick={() => hide.mutate()}>
        {t('welcome.card.hide')}
      </Button>
    </div>
  );
}
