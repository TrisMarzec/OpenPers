import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fullName, initials, todayISO } from '../lib/format';
import { AbsenceDialog } from '../components/AbsenceDialog';
import { PersonPerformance } from '../components/Performance';
import { PhotoEditor } from '../components/Photo';
import { InvitationBadge, InviteLinkBox, useMailStatus } from '../components/Invite';
import { Avatar, Button, Checkbox, Dialog, Field, Input, Section, Select, Spinner, Stamp, Table, Tabs, Textarea, useErrorText, useToast } from '../components/ui';
import { AbsenceList, BalanceTable } from './Absences';
import { DocumentList } from './Documents';
import { useOrgData, WeekHoursInput } from './People';
import { AttendanceList } from '../components/AttendanceList';
import { PersonChecklists } from '../components/Checklists';
import { CategoryForm, CompensationSection, OwnAccountSection, ProfileOverview, type Access } from '../components/Profile';

type Tab = 'overview' | 'checklists' | 'personal' | 'employment' | 'compensation' | 'payroll' | 'absences' | 'time' | 'documents' | 'performance' | 'account';

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
  const mail = useMailStatus();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get('/roles') });
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get('/users') });
  const account = users.data?.items.find((u: any) => u.personId === person.id);
  // Assigned roles always include the base employee role; the select shows the "highest" one.
  const mainRole = (account?.roles ?? []).map((r: any) => r.key).find((k: string) => k !== 'employee') ?? 'employee';
  const [f, setF] = useState({ password: '', role: 'employee', mode: 'invite' as 'invite' | 'password' });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  useEffect(() => {
    if (account) setF((x) => ({ ...x, role: mainRole }));
  }, [account?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const refresh = () => ['users', 'setup-guide'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const create = useMutation({
    mutationFn: () =>
      api.post('/users', { email: person.email, roles: [f.role], personId: person.id, locale: person.language === 'en' ? 'en' : 'de', ...(f.mode === 'invite' ? { invite: true } : { password: f.password }) }),
    onSuccess: (u: any) => {
      toast(f.mode === 'invite' ? (u.inviteUrl ? t('invite.created') : t('invite.sent', { email: person.email })) : t('common.created'));
      setInviteUrl(u.inviteUrl ?? null);
      refresh();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const resend = useMutation({
    mutationFn: () => api.post(`/users/${account.id}/invite`),
    onSuccess: (r: any) => {
      toast(r.inviteUrl ? t('invite.created') : t('invite.sent', { email: account.email }));
      setInviteUrl(r.inviteUrl ?? null);
      refresh();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const update = useMutation({
    mutationFn: (body: any) => api.patch(`/users/${account.id}`, body),
    onSuccess: () => {
      toast(t('common.saved'));
      setF((x) => ({ ...x, password: '' }));
      refresh();
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
  const invitationOpen = account?.invitation && account.invitation.status !== 'accepted';
  return (
    <Section title={t('person.tabs.account')}>
      {!account ? (
        <div className="grid max-w-md gap-4">
          <p className="text-ink-soft">{t('person.noAccount')}</p>
          <Field label={t('person.role')}>{roleSelect}</Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-semibold">{t('invite.how')}</legend>
            <label className="flex items-start gap-2">
              <input type="radio" name="account-mode" className="mt-1 accent-stamp" checked={f.mode === 'invite'} onChange={() => setF({ ...f, mode: 'invite' })} />
              <span>
                {t('invite.byMail', { email: person.email })}
                <span className="block text-sm text-ink-faint">{mail && !mail.configured ? t('invite.byMailNoServer') : t('invite.byMailHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="account-mode" className="mt-1 accent-stamp" checked={f.mode === 'password'} onChange={() => setF({ ...f, mode: 'password' })} />
              <span>
                {t('invite.byPassword')}
                <span className="block text-sm text-ink-faint">{t('invite.byPasswordHint')}</span>
              </span>
            </label>
          </fieldset>
          {f.mode === 'password' && (
            <Field label={t('person.initialPassword')} hint={t('setup.passwordHint')}>
              <Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" />
            </Field>
          )}
          <div>
            <Button variant="primary" busy={create.isPending} disabled={f.mode === 'password' && f.password.length < 10} onClick={() => create.mutate()}>
              {f.mode === 'invite' ? t('invite.send') : t('person.createAccount')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid max-w-md gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <strong>{account.email}</strong>
              <InvitationBadge invitation={account.invitation} />
            </div>
            {account.lastLoginAt && <span className="block text-sm text-ink-faint">Login: {new Date(account.lastLoginAt).toLocaleString()}</span>}
            {invitationOpen && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-soft">
                {t(account.invitation.status === 'expired' ? 'invite.expiredHint' : 'invite.pendingHint', { date: fmtDate(account.invitation.sentAt) })}
                <Button size="sm" busy={resend.isPending} onClick={() => resend.mutate()}>
                  {t('invite.resend')}
                </Button>
              </div>
            )}
          </div>
          {inviteUrl && <InviteLinkBox url={inviteUrl} />}
          <Field label={t('person.role')}>{roleSelect}</Field>
          <Checkbox label={t('person.accountActive')} checked={account.active} onChange={(active) => update.mutate({ active })} />
          {!invitationOpen && (
            <Field label={t('invite.newPassword')} hint={t('invite.newPasswordHint')}>
              <Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" />
            </Field>
          )}
          <div>
            <Button variant="primary" busy={update.isPending} onClick={() => update.mutate({ roles: [f.role], ...(f.password ? { password: f.password } : {}) })}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      )}
      {!account && inviteUrl && <InviteLinkBox url={inviteUrl} />}
    </Section>
  );
}

export function PersonPage({ selfView = false }: { selfView?: boolean }) {
  const params = useParams();
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const id = selfView ? me?.personId : params.id;
  const [tab, setTab] = useState<Tab>('overview');
  const [recording, setRecording] = useState(false);
  const q = useQuery({ queryKey: ['person', id], queryFn: () => api.get(`/persons/${id}`), enabled: !!id });
  const anonymize = useMutation({
    mutationFn: () => api.post(`/persons/${id}/anonymize`),
    onSuccess: () => {
      toast(t('common.saved'));
      qc.invalidateQueries();
      navigate('/people');
    },
  });
  if (!id) return <p className="text-ink-soft">{t('profile.noPerson')}</p>;
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <p className="text-refuse">{t('common.forbidden')}</p>;
  const p = q.data;
  const self = p.id === me?.personId;
  const access: Access = p.access;
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
        <PhotoEditor person={p} editable={!p.anonymizedAt && (self || access.profile === 'edit')} />
        <div className="min-w-0 flex-1">
          {selfView && <p className="text-sm font-semibold text-stamp">{t('nav.profile')}</p>}
          <h1 className="text-2xl font-bold">{fullName(p)}</h1>
          <p className="text-ink-soft">{[emp?.positionTitle, emp?.orgUnits?.map((o: any) => o.name).join(', ')].filter(Boolean).join(' – ') || p.email}</p>
          {p.anonymizedAt && <p className="text-sm text-refuse">{t('person.anonymized', { date: fmtDate(p.anonymizedAt) })}</p>}
        </div>
        {emp && <Stamp status={emp.status} />}
        <div className="flex flex-wrap gap-2">
          {(self || can('people.read')) && (
            <Button size="sm" onClick={exportData}>
              {t('person.exportData')}
            </Button>
          )}
          {!self && can('people.write', 'all') && !p.anonymizedAt && (
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
          { value: 'personal', label: t('person.tabs.personal') },
          { value: 'checklists', label: t('checklists.tab') },
          { value: 'employment', label: t('person.tabs.employment'), hidden: access.employment === 'none' },
          { value: 'compensation', label: t('categories.compensation'), hidden: access.compensation === 'none' },
          { value: 'payroll', label: t('categories.payroll'), hidden: access.payroll === 'none' },
          { value: 'absences', label: t('person.tabs.absences'), hidden: !can('absence.read') },
          { value: 'time', label: t('person.tabs.time'), hidden: !can('time.read') },
          { value: 'performance', label: t('categories.performance'), hidden: !access.performance || access.performance === 'none' },
          { value: 'documents', label: t('person.tabs.documents'), hidden: !can('documents.read') && !can('documents.write') },
          { value: 'account', label: t('person.tabs.account'), hidden: !self && !can('users.manage') },
        ]}
      />
      {tab === 'overview' && <ProfileOverview person={p} />}
      {tab === 'personal' && <CategoryForm person={p} categories={['profile', 'contact', 'personal']} />}
      {tab === 'checklists' && <PersonChecklists personId={p.id} />}
      {tab === 'employment' && <EmploymentTab person={p} canWrite={can('people.write') && access.employment === 'edit'} />}
      {tab === 'compensation' && <CompensationSection person={p} />}
      {tab === 'payroll' && <CategoryForm person={p} categories={['payroll']} />}
      {tab === 'absences' && (
        <div>
          {can('absence.manage') && !self && (
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
      {tab === 'performance' && <PersonPerformance person={p} />}
      {tab === 'account' && (self ? <OwnAccountSection /> : <AccountTab person={p} />)}
    </div>
  );
}
