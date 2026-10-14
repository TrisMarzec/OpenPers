import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, REGION_NAMES } from '@openpers/shared';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { cx, Button, Checkbox, Dialog, Field, Input, PageHeader, Section, Spinner, Stamp, Table, useErrorText, useToast } from '../../components/ui';
import { CrudSection, FormFields, type FieldSpec } from './Crud';

function CompanySettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['company'], queryFn: () => api.get('/company') });
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (q.data) setF({ name: q.data.name, region: q.data.region, timezone: q.data.timezone, retentionMonths: q.data.settings?.recruiting?.retentionMonths ?? 6 });
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.patch('/company', { name: f.name, region: f.region, timezone: f.timezone, settings: { recruiting: { retentionMonths: Number(f.retentionMonths) } } }),
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['company'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (!f) return <Spinner />;
  const fields: FieldSpec[] = [
    { key: 'name', label: t('settings.companyName') },
    { key: 'region', label: t('settings.defaultRegion'), type: 'region', required: true, hint: t('setup.regionHint') },
    { key: 'timezone', label: t('settings.timezone') },
    { key: 'retentionMonths', label: t('settings.retentionMonths'), type: 'number' },
  ];
  return (
    <Section title={t('settings.sections.company')}>
      <div className="max-w-md">
        <FormFields fields={fields} value={f} onChange={setF} />
        <Button variant="primary" className="mt-4" busy={save.isPending} onClick={() => save.mutate()}>
          {t('common.save')}
        </Button>
      </div>
    </Section>
  );
}

function OrgSettings() {
  const { t } = useTranslation();
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const unitOptions = (units.data?.items ?? []).map((u: any) => ({ value: u.id, label: u.name }));
  return (
    <div className="grid gap-5">
      <CrudSection
        title={t('settings.orgUnits')}
        path="/org-units"
        defaults={{ type: 'department' }}
        fields={[
          { key: 'name', label: t('common.name') },
          { key: 'type', label: t('settings.unitType'), type: 'select', required: true, options: [{ value: 'department', label: t('settings.department') }, { value: 'team', label: t('settings.team') }] },
          { key: 'parentId', label: t('settings.parent'), type: 'select', options: unitOptions },
        ]}
      />
      <CrudSection title={t('settings.workplaces')} path="/workplaces" defaults={{ region: 'DE-BE' }} fields={[{ key: 'name', label: t('common.name') }, { key: 'region', label: t('setup.region'), type: 'region', required: true }, { key: 'address', label: t('settings.address') }]} />
      <CrudSection title={t('settings.legalEntities')} path="/legal-entities" defaults={{ region: 'DE-BE', country: 'DE' }} fields={[{ key: 'name', label: t('common.name') }, { key: 'region', label: t('setup.region'), type: 'region', required: true }, { key: 'country', label: 'ISO', column: false }]} />
      <CrudSection title={t('settings.costCenters')} path="/cost-centers" fields={[{ key: 'code', label: t('settings.code') }, { key: 'name', label: t('common.name') }]} />
    </div>
  );
}

function AbsenceSettings() {
  const { t } = useTranslation();
  const types = useQuery({ queryKey: ['absence-types'], queryFn: () => api.get('/absence-types') });
  const typeOptions = (types.data?.items ?? []).map((x: any) => ({ value: x.id, label: x.name }));
  const cats = t('settings.categories', { returnObjects: true }) as Record<string, string>;
  return (
    <div className="grid gap-5">
      <CrudSection
        title={t('settings.absenceTypes')}
        path="/absence-types"
        canDelete={false}
        defaults={{ category: 'other', unit: 'DAY', requiresApproval: true, allowsHalfDays: true, color: '#3b82f6', active: true }}
        fields={[
          { key: 'name', label: t('common.name') },
          { key: 'category', label: t('settings.category'), type: 'select', required: true, options: Object.entries(cats).map(([value, label]) => ({ value, label })) },
          { key: 'unit', label: t('settings.unit'), type: 'select', required: true, column: false, options: [{ value: 'DAY', label: t('absence.days') }, { value: 'HOUR', label: t('settings.hoursUnit') }] },
          { key: 'color', label: t('settings.color'), type: 'color' },
          { key: 'requiresApproval', label: t('settings.requiresApproval'), type: 'checkbox' },
          { key: 'countsAgainstBalance', label: t('settings.countsAgainstBalance'), type: 'checkbox' },
          { key: 'allowsHalfDays', label: t('settings.allowsHalfDays'), type: 'checkbox', column: false },
          { key: 'allowsSubstitute', label: t('absence.substitute'), type: 'checkbox', column: false },
          { key: 'active', label: t('status.ACTIVE'), type: 'checkbox' },
        ]}
      />
      <CrudSection
        title={t('settings.policies')}
        path="/absence-policies"
        canDelete={false}
        defaults={{ annualEntitlement: 30, carryoverMax: 0, carryoverExpiry: '03-31', isDefault: false }}
        fields={[
          { key: 'name', label: t('common.name') },
          { key: 'absenceTypeId', label: t('absence.type'), type: 'select', required: true, options: typeOptions, createOnly: true },
          { key: 'annualEntitlement', label: t('settings.annualEntitlement'), type: 'number' },
          { key: 'carryoverMax', label: t('settings.carryoverMax'), type: 'number' },
          { key: 'carryoverExpiry', label: t('settings.carryoverExpiry') },
          { key: 'isDefault', label: t('settings.isDefault'), type: 'checkbox' },
        ]}
      />
      <CrudSection
        title={t('settings.holidays')}
        intro={t('settings.holidaysHint')}
        path="/custom-holidays"
        canEdit={false}
        fields={[
          { key: 'date', label: t('common.date'), type: 'date' },
          { key: 'name', label: t('common.name') },
          { key: 'region', label: t('setup.region'), type: 'region', render: (r) => (r.region ? REGION_NAMES[r.region as keyof typeof REGION_NAMES] : t('settings.scopes.all')) },
        ]}
      />
    </div>
  );
}

function TimeSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['time-settings'], queryFn: () => api.get('/time-settings') });
  const [f, setF] = useState<any>(null);
  useEffect(() => {
    if (q.data) setF(q.data);
  }, [q.data]);
  const save = useMutation({
    mutationFn: () => api.patch('/time-settings', { approvalRequired: f.approvalRequired, lockAfterDays: f.lockAfterDays || null }),
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['time-settings'] });
    },
  });
  return (
    <div className="grid gap-5">
      <Section title={t('settings.sections.time')}>
        {f && (
          <div className="grid max-w-md gap-4">
            <FormFields
              fields={[
                { key: 'approvalRequired', label: t('settings.approvalRequired'), type: 'checkbox' },
                { key: 'lockAfterDays', label: t('settings.lockAfterDays'), type: 'number', hint: t('settings.lockHint') },
              ]}
              value={f}
              onChange={setF}
            />
            <div>
              <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Section>
      <CrudSection
        title={t('settings.projects')}
        path="/projects"
        canDelete={false}
        defaults={{ status: 'ACTIVE' }}
        fields={[
          { key: 'code', label: t('settings.code') },
          { key: 'name', label: t('common.name') },
          { key: 'status', label: t('common.status'), type: 'select', required: true, options: [{ value: 'ACTIVE', label: t('status.ACTIVE') }, { value: 'ARCHIVED', label: t('status.ARCHIVED') }] },
        ]}
      />
    </div>
  );
}

function FieldSettings() {
  const { t } = useTranslation();
  const types = t('settings.fieldTypes', { returnObjects: true }) as Record<string, string>;
  return (
    <CrudSection
      title={t('settings.sections.fields')}
      path="/attribute-definitions"
      defaults={{ type: 'text', section: 'general', sensitive: false }}
      fields={[
        { key: 'label', label: t('settings.fieldLabel') },
        { key: 'key', label: t('settings.fieldKey'), createOnly: true, hint: 'a–z, 0–9, _' },
        { key: 'type', label: t('settings.fieldType'), type: 'select', required: true, createOnly: true, options: Object.entries(types).map(([value, label]) => ({ value, label })) },
        { key: 'options', label: t('settings.options'), type: 'list', column: false },
        { key: 'sensitive', label: t('person.sensitive'), type: 'checkbox', createOnly: true, hint: t('settings.sensitiveHint') },
      ]}
    />
  );
}

function DocumentSettings() {
  const { t } = useTranslation();
  const cats = useQuery({ queryKey: ['document-categories'], queryFn: () => api.get('/document-categories') });
  return (
    <div className="grid gap-5">
      <CrudSection title={t('settings.documentCategories')} path="/document-categories" fields={[{ key: 'name', label: t('common.name') }, { key: 'employeeVisible', label: t('documents.visible'), type: 'checkbox' }]} />
      <CrudSection
        title={t('settings.templates')}
        path="/document-templates"
        intro={
          <>
            {t('settings.templateHint')} <code className="text-ink">{'{{person.firstName}} {{person.lastName}} {{employment.startDate}} {{employment.positionTitle}} {{company.name}} {{today.date}}'}</code>
          </>
        }
        fields={[
          { key: 'name', label: t('common.name') },
          { key: 'categoryId', label: t('documents.category'), type: 'select', options: (cats.data?.items ?? []).map((c: any) => ({ value: c.id, label: c.name })) },
          { key: 'body', label: t('recruiting.description'), type: 'textarea', column: false },
        ]}
      />
    </div>
  );
}

function UserSettings() {
  const { t } = useTranslation();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users') });
  const scopes = t('settings.scopes', { returnObjects: true }) as Record<string, string>;
  return (
    <div className="grid gap-5">
      <Section title={t('settings.users')}>
        {users.isLoading ? (
          <Spinner />
        ) : (
          <Table head={['E-Mail', t('settings.roles'), t('common.status')]}>
            {(users.data?.items ?? []).map((u: any) => (
              <tr key={u.id}>
                <td className="font-semibold">{u.personId ? <Link to={`/people/${u.personId}`} className="hover:text-stamp hover:underline">{u.email}</Link> : u.email}</td>
                <td>{u.roles.map((r: any) => `${r.name} (${scopes[r.scope]})`).join(', ')}</td>
                <td>
                  <Stamp status={u.active ? 'ACTIVE' : 'INACTIVE'} />
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Section>
      <CrudSection
        title={t('settings.roles')}
        path="/roles"
        defaults={{ defaultScope: 'self', permissions: [] }}
        fields={[
          { key: 'name', label: t('common.name') },
          { key: 'key', label: t('settings.fieldKey'), createOnly: true, column: false },
          { key: 'defaultScope', label: t('settings.scope'), type: 'select', required: true, options: Object.entries(scopes).map(([value, label]) => ({ value, label })) },
          { key: 'permissions', label: t('settings.permissions'), type: 'list', hint: PERMISSIONS.join(', '), render: (r) => <span className="text-sm text-ink-soft">{r.permissions.length}</span> },
        ]}
      />
    </div>
  );
}

function IntegrationSettings() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get('/api-tokens') });
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get('/webhooks') });
  const events = useQuery({ queryKey: ['webhook-events'], queryFn: () => api.get('/webhook-events') });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);
  const [tokenName, setTokenName] = useState('');
  const [hook, setHook] = useState<{ url: string; events: string[]; token: string } | null>(null);
  const createToken = useMutation({
    mutationFn: () => api.post('/api-tokens', { name: tokenName }),
    onSuccess: (r) => {
      setSecret({ label: t('settings.tokenCreated'), value: r.token });
      setTokenName('');
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.delete(`/api-tokens/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['api-tokens'] }) });
  const createHook = useMutation({
    mutationFn: () => api.post('/webhooks', { url: hook!.url, events: hook!.events.length ? hook!.events : ['*'], authType: hook!.token ? 'TOKEN' : 'NONE', token: hook!.token || null }),
    onSuccess: (r) => {
      setHook(null);
      setSecret({ label: t('settings.secretShown'), value: r.secret });
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const delHook = useMutation({ mutationFn: (id: string) => api.delete(`/webhooks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) });
  const ping = useMutation({ mutationFn: (id: string) => api.post(`/webhooks/${id}/ping`), onSuccess: () => toast(t('common.saved')) });

  return (
    <div className="grid gap-5">
      <p>
        <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="font-semibold text-stamp hover:underline">
          {t('settings.apiDocs')}
        </a>
      </p>
      <Section title={t('settings.apiTokens')}>
        <div className="mb-4 flex max-w-md gap-2">
          <Input placeholder={t('common.name')} value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
          <Button disabled={!tokenName} onClick={() => createToken.mutate()}>
            {t('common.create')}
          </Button>
        </div>
        <Table head={[t('common.name'), t('settings.prefix'), t('settings.lastUsed'), '']}>
          {(tokens.data?.items ?? []).map((x: any) => (
            <tr key={x.id}>
              <td className="font-semibold">{x.name}</td>
              <td className="tnum">{x.prefix}…</td>
              <td>{x.lastUsedAt ? new Date(x.lastUsedAt).toLocaleString() : '–'}</td>
              <td className="text-right">
                <Button size="sm" variant="danger" onClick={() => revoke.mutate(x.id)}>
                  {t('common.delete')}
                </Button>
              </td>
            </tr>
          ))}
        </Table>
      </Section>
      {hooks.data && (
        <Section
          title={t('settings.webhooks')}
          actions={
            <Button size="sm" onClick={() => setHook({ url: 'https://', events: [], token: '' })}>
              {t('common.add')}
            </Button>
          }
        >
          <Table head={[t('settings.webhookUrl'), t('settings.events'), t('common.status'), '']}>
            {hooks.data.items.map((h: any) => (
              <tr key={h.id}>
                <td className="font-semibold break-all">{h.url}</td>
                <td className="text-sm">{h.events.includes('*') ? t('settings.allEvents') : h.events.join(', ')}</td>
                <td>
                  <Stamp status={h.status} />
                </td>
                <td className="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => ping.mutate(h.id)}>
                    {t('settings.ping')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => confirm(t('common.confirmDelete')) && delHook.mutate(h.id)}>
                    {t('common.delete')}
                  </Button>
                </td>
              </tr>
            ))}
          </Table>
        </Section>
      )}
      <Dialog
        open={!!hook}
        onClose={() => setHook(null)}
        title={t('settings.webhooks')}
        footer={
          <Button variant="primary" busy={createHook.isPending} onClick={() => createHook.mutate()}>
            {t('common.create')}
          </Button>
        }
      >
        {hook && (
          <div className="grid gap-4">
            <Field label={t('settings.webhookUrl')}>
              <Input value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
            </Field>
            <Field label={t('settings.authHeader')} hint={t('common.optional')}>
              <Input value={hook.token} placeholder="Bearer …" onChange={(e) => setHook({ ...hook, token: e.target.value })} />
            </Field>
            <fieldset>
              <legend className="mb-2 text-sm font-semibold">{t('settings.events')}</legend>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {(events.data?.items ?? []).map((ev: string) => (
                  <Checkbox key={ev} label={ev} checked={hook.events.includes(ev)} onChange={(v) => setHook({ ...hook, events: v ? [...hook.events, ev] : hook.events.filter((x) => x !== ev) })} />
                ))}
              </div>
              <p className="mt-2 text-sm text-ink-faint">{t('settings.eventsHint')}</p>
            </fieldset>
          </div>
        )}
      </Dialog>
      <Dialog open={!!secret} onClose={() => setSecret(null)} title={secret?.label ?? ''}>
        <code className="block rounded-md border border-rule bg-paper p-3 text-sm break-all select-all">{secret?.value}</code>
      </Dialog>
    </div>
  );
}

function AuditLog() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['audit-log'], queryFn: () => api.get('/audit-log?limit=200') });
  if (q.isLoading) return <Spinner />;
  return (
    <Table head={[t('common.date'), t('settings.auditEntity'), t('settings.auditAction'), t('settings.auditDetails')]}>
      {(q.data?.items ?? []).map((a: any) => (
        <tr key={a.id} className="text-sm">
          <td className="tnum whitespace-nowrap">{new Date(a.at).toLocaleString()}</td>
          <td>
            {a.entity}
            <span className="block text-ink-faint">{a.entityId.slice(0, 8)}</span>
          </td>
          <td className="font-semibold">{a.action}</td>
          <td className="max-w-md truncate text-ink-soft" title={JSON.stringify(a.changes)}>
            {a.changes ? JSON.stringify(a.changes) : ''}
          </td>
        </tr>
      ))}
    </Table>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const sections = [
    { path: 'company', label: t('settings.sections.company'), show: can('settings.manage'), el: <CompanySettings /> },
    { path: 'org', label: t('settings.sections.org'), show: can('org.manage'), el: <OrgSettings /> },
    { path: 'absence', label: t('settings.sections.absence'), show: can('absence.manage'), el: <AbsenceSettings /> },
    { path: 'time', label: t('settings.sections.time'), show: can('time.manage'), el: <TimeSettings /> },
    { path: 'fields', label: t('settings.sections.fields'), show: can('people.write'), el: <FieldSettings /> },
    { path: 'documents', label: t('settings.sections.documents'), show: can('documents.manage'), el: <DocumentSettings /> },
    { path: 'users', label: t('settings.sections.users'), show: can('users.manage'), el: <UserSettings /> },
    { path: 'integrations', label: t('settings.sections.integrations'), show: can('webhooks.manage'), el: <IntegrationSettings /> },
    { path: 'audit', label: t('settings.sections.audit'), show: can('settings.manage'), el: <AuditLog /> },
  ].filter((s) => s.show);
  return (
    <div>
      <PageHeader title={t('settings.title')} />
      <div className="grid gap-6 lg:grid-cols-[200px_1fr]">
        <nav className="flex gap-1 overflow-x-auto lg:flex-col">
          {sections.map((s) => (
            <NavLink key={s.path} to={`/settings/${s.path}`} className={({ isActive }) => cx('rounded-[var(--radius-ctl)] px-3 py-2 font-semibold whitespace-nowrap', isActive ? 'bg-stamp-wash text-stamp' : 'text-ink-soft hover:bg-rule-soft hover:text-ink')}>
              {s.label}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0">
          <Routes>
            {sections.map((s) => (
              <Route key={s.path} path={s.path} element={s.el} />
            ))}
            <Route path="*" element={sections[0] ? <Navigate to={`/settings/${sections[0].path}`} replace /> : null} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
