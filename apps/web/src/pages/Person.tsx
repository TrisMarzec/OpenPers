import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fullName, initials, todayISO } from '../lib/format';
import { AbsenceDialog } from '../components/AbsenceDialog';
import { Avatar, Button, Checkbox, Dialog, Field, Input, Section, Select, Spinner, Stamp, Table, Tabs, Textarea, useErrorText, useToast } from '../components/ui';
import { AbsenceList, BalanceTable } from './Absences';
import { DocumentList } from './Documents';
import { useOrgData, WeekHoursInput } from './People';
import { AttendanceList } from '../components/AttendanceList';

type Tab = 'overview' | 'employment' | 'absences' | 'time' | 'documents' | 'account';
const SELF_FIELDS = ['phone', 'privateAddress', 'emergencyContact', 'preferredName', 'language'];

function PersonalForm({ person, canWrite, self }: { person: any; canWrite: boolean; self: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const defs = useQuery({ queryKey: ['attribute-definitions'], queryFn: () => api.get('/attribute-definitions') });
  const [f, setF] = useState<any>(person);
  const [attrs, setAttrs] = useState<Record<string, unknown>>(person.attributes ?? {});
  useEffect(() => {
    setF(person);
    setAttrs(person.attributes ?? {});
  }, [person]);
  const editable = (k: string) => canWrite || (self && SELF_FIELDS.includes(k));
  const save = useMutation({
    mutationFn: async () => {
      const keys = ['firstName', 'lastName', 'preferredName', 'email', 'gender', 'birthDate', 'phone', 'privateAddress', 'emergencyContact', 'language'].filter(editable);
      const body = Object.fromEntries(keys.map((k) => [k, f[k] === '' ? null : f[k]]).filter(([k, v]) => v !== null || !['firstName', 'lastName', 'email', 'gender', 'language'].includes(k as string)));
      await api.patch(`/persons/${person.id}`, body);
      if (canWrite && defs.data?.items.length) {
        const changed = Object.fromEntries(Object.entries(attrs).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(person.attributes?.[k])).map(([k, v]) => [k, v === '' ? null : v]));
        if (Object.keys(changed).length) await api.put(`/persons/${person.id}/attributes`, changed);
      }
    },
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['person', person.id] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const input = (k: string, type = 'text') => <Input type={type} value={f[k] ?? ''} disabled={!editable(k)} onChange={(e) => setF({ ...f, [k]: e.target.value })} />;
  return (
    <div className="grid gap-5">
      {self && !canWrite && <p className="text-ink-soft">{t('person.selfServiceHint')}</p>}
      <Section title={t('person.tabs.overview')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('person.firstName')}>{input('firstName')}</Field>
          <Field label={t('person.lastName')}>{input('lastName')}</Field>
          <Field label={t('person.preferredName')}>{input('preferredName')}</Field>
          <Field label={t('person.email')}>{input('email', 'email')}</Field>
          <Field label={t('person.gender')}>
            <Select value={f.gender} disabled={!editable('gender')} onChange={(e) => setF({ ...f, gender: e.target.value })}>
              {Object.entries(t('person.genders', { returnObjects: true }) as Record<string, string>).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('person.birthDate')}>{input('birthDate', 'date')}</Field>
          <Field label={t('person.phone')}>{input('phone', 'tel')}</Field>
          <Field label={t('person.language')}>
            <Select value={f.language} disabled={!editable('language')} onChange={(e) => setF({ ...f, language: e.target.value })}>
              <option value="de">Deutsch</option>
              <option value="en">English</option>
            </Select>
          </Field>
          <Field label={t('person.privateAddress')} className="sm:col-span-2">
            <Textarea rows={2} value={f.privateAddress ?? ''} disabled={!editable('privateAddress')} onChange={(e) => setF({ ...f, privateAddress: e.target.value })} />
          </Field>
          <Field label={t('person.emergencyContact')} className="sm:col-span-2">
            <Input value={f.emergencyContact ?? ''} disabled={!editable('emergencyContact')} onChange={(e) => setF({ ...f, emergencyContact: e.target.value })} />
          </Field>
        </div>
      </Section>
      {(defs.data?.items ?? []).length > 0 && (
        <Section title={t('person.customFields')}>
          <div className="grid gap-4 sm:grid-cols-2">
            {defs.data.items
              .filter((d: any) => !d.sensitive || d.key in attrs || canWrite)
              .map((d: any) =>
                d.type === 'boolean' ? (
                  <div key={d.id} className="self-end pb-2">
                    <Checkbox label={d.label} checked={!!attrs[d.key]} onChange={(v) => canWrite && setAttrs({ ...attrs, [d.key]: v })} />
                  </div>
                ) : (
                <Field
                  key={d.id}
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      {d.label}
                      {d.sensitive && <Lock size={13} aria-label={t('person.sensitive')} className="text-ink-faint" />}
                    </span>
                  }
                >
                  {d.type === 'select' ? (
                    <Select value={(attrs[d.key] as string) ?? ''} disabled={!canWrite} onChange={(e) => setAttrs({ ...attrs, [d.key]: e.target.value })}>
                      <option value="">–</option>
                      {(d.options ?? []).map((o: string) => (
                        <option key={o}>{o}</option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      type={d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'text'}
                      value={(attrs[d.key] as string) ?? ''}
                      disabled={!canWrite}
                      onChange={(e) => setAttrs({ ...attrs, [d.key]: d.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}
                    />
                  )}
                </Field>
                ),
              )}
          </div>
        </Section>
      )}
      {(canWrite || self) && (
        <div className="flex justify-end">
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </div>
      )}
    </div>
  );
}

function EmploymentTab({ person, canWrite }: { person: any; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const org = useOrgData();
  const emp = person.currentEmployment;
  const [f, setF] = useState<any>(() => ({ ...emp, orgUnitId: emp?.orgUnitIds?.[0] ?? '', effectiveDate: '' }));
  const [sched, setSched] = useState<{ open: boolean; validFrom: string; hours: number[] }>({ open: false, validFrom: todayISO(), hours: emp?.schedules?.at(-1)?.hours ?? [8, 8, 8, 8, 8, 0, 0] });
  const changes = useQuery({ queryKey: ['employment-changes', emp?.id], queryFn: () => api.get(`/persons/${person.id}/employments/${emp.id}/changes`), enabled: !!emp });
  const save = useMutation({
    mutationFn: () =>
      api.patch(`/persons/${person.id}/employments/${emp.id}`, {
        effectiveDate: f.effectiveDate || undefined,
        status: f.status,
        positionTitle: f.positionTitle || null,
        employeeNumber: f.employeeNumber || null,
        contractType: f.contractType,
        type: f.type,
        endDate: f.endDate || null,
        probationEndDate: f.probationEndDate || null,
        supervisorPersonId: f.supervisorPersonId || null,
        workplaceId: f.workplaceId || null,
        legalEntityId: f.legalEntityId || null,
        orgUnitIds: f.orgUnitId ? [f.orgUnitId] : [],
      }),
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['person', person.id] });
      qc.invalidateQueries({ queryKey: ['employment-changes'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const addSchedule = useMutation({
    mutationFn: () => api.post(`/persons/${person.id}/employments/${emp.id}/schedules`, { validFrom: sched.validFrom, weeklyHours: sched.hours }),
    onSuccess: () => {
      toast(t('common.saved'));
      setSched({ ...sched, open: false });
      qc.invalidateQueries({ queryKey: ['person', person.id] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  if (!emp) return null;
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const options = (items: any[], label = (x: any) => x.name) => [<option key="" value="">–</option>, ...items.map((x) => <option key={x.id} value={x.id}>{label(x)}</option>)];
  const pending = (changes.data?.items ?? []).filter((c: any) => !c.appliedAt);
  return (
    <div className="grid gap-5">
      <Section title={t('person.tabs.employment')}>
        <fieldset disabled={!canWrite} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('people.position')}>
            <Input value={f.positionTitle ?? ''} onChange={set('positionTitle')} />
          </Field>
          <Field label={t('common.status')}>
            <Select value={f.status} onChange={set('status')}>
              {['ACTIVE', 'ONBOARDING', 'LEAVE', 'INACTIVE'].map((s) => (
                <option key={s} value={s}>
                  {t(`status.${s}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('person.employeeNumber')}>
            <Input value={f.employeeNumber ?? ''} onChange={set('employeeNumber')} />
          </Field>
          <Field label={t('person.contractType')}>
            <Select value={f.contractType} onChange={set('contractType')}>
              {Object.entries(t('person.contractTypes', { returnObjects: true }) as Record<string, string>).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('person.type')}>
            <Select value={f.type} onChange={set('type')}>
              {Object.entries(t('person.types', { returnObjects: true }) as Record<string, string>).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('people.startDate')}>
            <Input type="date" value={f.startDate} disabled />
          </Field>
          <Field label={t('person.probationEndDate')}>
            <Input type="date" value={f.probationEndDate ?? ''} onChange={set('probationEndDate')} />
          </Field>
          <Field label={t('person.endDate')}>
            <Input type="date" value={f.endDate ?? ''} onChange={set('endDate')} />
          </Field>
          <Field label={t('person.supervisor')}>
            <Select value={f.supervisorPersonId ?? ''} onChange={set('supervisorPersonId')}>
              {options(org.directory.filter((p: any) => p.id !== person.id), fullName)}
            </Select>
          </Field>
          <Field label={t('person.orgUnits')}>
            <Select value={f.orgUnitId} onChange={set('orgUnitId')}>
              {options(org.orgUnits)}
            </Select>
          </Field>
          <Field label={t('person.workplace')}>
            <Select value={f.workplaceId ?? ''} onChange={set('workplaceId')}>
              {options(org.workplaces)}
            </Select>
          </Field>
          <Field label={t('person.legalEntity')}>
            <Select value={f.legalEntityId ?? ''} onChange={set('legalEntityId')}>
              {options(org.legalEntities)}
            </Select>
          </Field>
          {canWrite && (
            <Field label={t('person.effectiveDate')} hint={t('person.effectiveHint')}>
              <Input type="date" value={f.effectiveDate} min={todayISO()} onChange={set('effectiveDate')} />
            </Field>
          )}
        </fieldset>
        {canWrite && (
          <div className="mt-4 flex justify-end">
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          </div>
        )}
      </Section>
      {pending.length > 0 && (
        <Section title={t('person.scheduled')}>
          <ul className="grid gap-1">
            {pending.map((c: any) => (
              <li key={c.id} className="text-sm">
                <strong>{t('person.scheduledFor', { date: fmtDate(c.effectiveDate) })}</strong>: {Object.keys(c.changes).join(', ')}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <Section
        title={t('person.schedules')}
        actions={
          canWrite && (
            <Button size="sm" onClick={() => setSched({ ...sched, open: true })}>
              {t('person.addSchedule')}
            </Button>
          )
        }
      >
        <Table head={[t('person.validFrom'), ...(t('person.weekdays', { returnObjects: true }) as string[]), 'Σ']}>
          {emp.schedules.map((s: any) => (
            <tr key={s.id} className="tnum">
              <td className="font-semibold">{fmtDate(s.validFrom)}</td>
              {s.hours.map((h: number, i: number) => (
                <td key={i} className={h === 0 ? 'text-ink-faint' : ''}>
                  {h}
                </td>
              ))}
              <td className="font-bold">{s.hours.reduce((a: number, b: number) => a + b, 0)}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Dialog
        open={sched.open}
        onClose={() => setSched({ ...sched, open: false })}
        title={t('person.addSchedule')}
        footer={
          <Button variant="primary" busy={addSchedule.isPending} onClick={() => addSchedule.mutate()}>
            {t('common.save')}
          </Button>
        }
      >
        <div className="grid gap-4">
          <Field label={t('person.validFrom')}>
            <Input type="date" value={sched.validFrom} onChange={(e) => setSched({ ...sched, validFrom: e.target.value })} />
          </Field>
          <Field label={t('person.weeklyHours')}>
            <WeekHoursInput value={sched.hours} onChange={(hours) => setSched({ ...sched, hours })} />
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

function AccountTab({ person }: { person: any }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get('/roles') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users') });
  const account = users.data?.items.find((u: any) => u.personId === person.id);
  const [f, setF] = useState({ password: '', role: 'employee' });
  useEffect(() => {
    if (account?.roles?.[0]) setF((x) => ({ ...x, role: account.roles[0].key }));
  }, [account?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const create = useMutation({
    mutationFn: () => api.post('/users', { email: person.email, password: f.password, roles: [f.role], personId: person.id, locale: person.language === 'en' ? 'en' : 'de' }),
    onSuccess: () => {
      toast(t('common.created'));
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['person', person.id] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const update = useMutation({
    mutationFn: (body: any) => api.patch(`/users/${account.id}`, body),
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const roleSelect = (
    <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
      {(roles.data?.items ?? []).map((r: any) => (
        <option key={r.key} value={r.key}>
          {r.name}
        </option>
      ))}
    </Select>
  );
  if (users.isLoading) return <Spinner />;
  return (
    <Section title={t('person.tabs.account')}>
      {!account ? (
        <div className="grid max-w-md gap-4">
          <p className="text-ink-soft">{t('person.noAccount')}</p>
          <Field label={t('person.role')}>{roleSelect}</Field>
          <Field label={t('person.initialPassword')} hint={t('setup.passwordHint')}>
            <Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" />
          </Field>
          <div>
            <Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>
              {t('person.createAccount')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid max-w-md gap-4">
          <p>
            <strong>{account.email}</strong>
            {account.lastLoginAt && <span className="block text-sm text-ink-faint">Login: {new Date(account.lastLoginAt).toLocaleString()}</span>}
          </p>
          <Field label={t('person.role')}>{roleSelect}</Field>
          <Checkbox label={t('person.accountActive')} checked={account.active} onChange={(active) => update.mutate({ active })} />
          <Field label={t('person.initialPassword')} hint={t('setup.passwordHint')}>
            <Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" />
          </Field>
          <div>
            <Button variant="primary" busy={update.isPending} onClick={() => update.mutate({ roles: [f.role], ...(f.password ? { password: f.password } : {}) })}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

export function PersonPage() {
  const { id } = useParams();
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');
  const [recording, setRecording] = useState(false);
  const q = useQuery({ queryKey: ['person', id], queryFn: () => api.get(`/persons/${id}`) });
  const anonymize = useMutation({
    mutationFn: () => api.post(`/persons/${id}/anonymize`),
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries();
      navigate('/people');
    },
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <p className="text-refuse">{t('common.forbidden')}</p>;
  const p = q.data;
  const self = p.id === me?.personId;
  const canWrite = can('people.write');
  const emp = p.currentEmployment;

  const exportData = async () => {
    const data = await api.get(`/persons/${p.id}/export`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `openpers-export-${p.lastName}-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div>
      <header className="mb-5 flex flex-wrap items-center gap-4 border-b border-rule pb-5">
        <Avatar name={initials(p)} size={56} />
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold">{fullName(p)}</h1>
          <p className="text-ink-soft">
            {[emp?.positionTitle, emp?.orgUnits?.map((o: any) => o.name).join(', ')].filter(Boolean).join(' – ') || p.email}
          </p>
          {p.anonymizedAt && <p className="text-sm text-refuse">{t('person.anonymized', { date: fmtDate(p.anonymizedAt.slice(0, 10)) })}</p>}
        </div>
        {emp && <Stamp status={emp.status} />}
        <div className="flex flex-wrap gap-2">
          {(self || can('people.read')) && (
            <Button size="sm" onClick={exportData}>
              {t('person.exportData')}
            </Button>
          )}
          {can('people.write', 'all') && !p.anonymizedAt && (
            <Button size="sm" variant="danger" onClick={() => confirm(t('person.anonymizeConfirm')) && anonymize.mutate()}>
              {t('person.anonymize')}
            </Button>
          )}
        </div>
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'overview', label: t('person.tabs.overview') },
          { value: 'employment', label: t('person.tabs.employment') },
          { value: 'absences', label: t('person.tabs.absences'), hidden: !can('absence.read') },
          { value: 'time', label: t('person.tabs.time'), hidden: !can('time.read') },
          { value: 'documents', label: t('person.tabs.documents'), hidden: !can('documents.read') },
          { value: 'account', label: t('person.tabs.account'), hidden: !can('users.manage') },
        ]}
      />
      {tab === 'overview' && <PersonalForm person={p} canWrite={canWrite} self={self} />}
      {tab === 'employment' && <EmploymentTab person={p} canWrite={canWrite} />}
      {tab === 'absences' && (
        <div>
          {can('absence.manage') && (
            <div className="mb-3 flex justify-end">
              <Button variant="primary" onClick={() => setRecording(true)}>
                {t('absence.record')}
              </Button>
            </div>
          )}
          <BalanceTable personId={p.id} />
          <AbsenceList personId={p.id} canManage={can('absence.manage')} />
          <AbsenceDialog open={recording} onClose={() => setRecording(false)} personId={p.id} personName={fullName(p)} />
        </div>
      )}
      {tab === 'time' && <AttendanceList personId={p.id} editable={can('time.manage') || (self && can('time.track'))} />}
      {tab === 'documents' && <DocumentList personId={p.id} />}
      {tab === 'account' && <AccountTab person={p} />}
    </div>
  );
}
