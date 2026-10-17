import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Button, Checkbox, Dialog, Empty, Field, Input, PageHeader, Select, Spinner, Stamp, Table, Textarea, useErrorText, useToast } from '../components/ui';
import { useOrgData } from './People';

export function JobForm({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const { t } = useTranslation();
  const org = useOrgData();
  const team = useQuery({ queryKey: ['team-candidates'], queryFn: () => api.get('/recruiting/team-candidates') });
  const selected: string[] = value.hiringTeamUserIds ?? [];
  const set = (k: string) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('recruiting.jobTitle')} className="sm:col-span-2">
        <Input value={value.title} onChange={set('title')} autoFocus />
      </Field>
      <Field label={t('recruiting.employmentType')}>
        <Select value={value.employmentType} onChange={set('employmentType')}>
          {Object.entries(t('recruiting.employmentTypes', { returnObjects: true }) as Record<string, string>).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('recruiting.department')}>
        <Select value={value.departmentOrgUnitId ?? ''} onChange={set('departmentOrgUnitId')}>
          <option value="">–</option>
          {org.orgUnits.map((o: any) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('recruiting.location')}>
        <Select value={value.workplaceId ?? ''} onChange={set('workplaceId')}>
          <option value="">–</option>
          {org.workplaces.map((o: any) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="mb-1 text-sm font-semibold">{t('recruiting.hiringTeam')}</legend>
        <p className="mb-2 text-sm text-ink-faint">{t('recruiting.hiringTeamHint')}</p>
        <div className="grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2">
          {(team.data?.items ?? []).map((u: any) => (
            <Checkbox key={u.userId} label={`${u.firstName} ${u.lastName}`} checked={selected.includes(u.userId)} onChange={(v) => onChange({ ...value, hiringTeamUserIds: v ? [...selected, u.userId] : selected.filter((x) => x !== u.userId) })} />
          ))}
        </div>
      </fieldset>
      <Field label={t('recruiting.description')} hint={t('recruiting.descriptionHint')} className="sm:col-span-2">
        <Textarea rows={10} value={value.description} onChange={set('description')} />
      </Field>
    </div>
  );
}

export const jobPayload = (j: any) => ({ title: j.title, employmentType: j.employmentType, departmentOrgUnitId: j.departmentOrgUnitId || null, workplaceId: j.workplaceId || null, description: j.description, hiringTeamUserIds: j.hiringTeamUserIds ?? [] });

export function RecruitingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [job, setJob] = useState({ title: '', employmentType: 'FULL_TIME', departmentOrgUnitId: '', workplaceId: '', description: '' });
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: () => api.get('/jobs') });
  const create = useMutation({
    mutationFn: () => api.post('/jobs', jobPayload(job)),
    onSuccess: (j) => {
      toast(t('common.created'));
      qc.invalidateQueries({ queryKey: ['jobs'] });
      navigate(`/recruiting/jobs/${j.id}`);
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <div>
      <PageHeader
        title={t('recruiting.title')}
        actions={
          <>
            <a href="/careers" target="_blank" rel="noreferrer" className="inline-flex h-10 items-center px-2 font-semibold text-stamp hover:underline">
              {t('nav.careers')}
            </a>
            {can('recruiting.write') && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t('recruiting.newJob')}
              </Button>
            )}
          </>
        }
      />
      {jobs.isLoading ? (
        <Spinner />
      ) : !jobs.data?.items.length ? (
        <Empty>{t('recruiting.empty')}</Empty>
      ) : (
        <Table head={[t('recruiting.jobTitle'), t('recruiting.employmentType'), t('recruiting.openApplications'), t('common.status'), t('common.date')]}>
          {jobs.data.items.map((j: any) => (
            <tr key={j.id} className="hover:bg-paper">
              <td>
                <Link to={`/recruiting/jobs/${j.id}`} className="font-semibold text-ink hover:text-stamp hover:underline">
                  {j.title}
                </Link>
              </td>
              <td>{t(`recruiting.employmentTypes.${j.employmentType}`)}</td>
              <td className="tnum font-bold">{j.openApplications}</td>
              <td>
                <Stamp status={j.status} />
              </td>
              <td className="tnum">{fmtDate(j.updatedAt)}</td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog
        open={creating}
        wide
        onClose={() => setCreating(false)}
        title={t('recruiting.newJob')}
        footer={
          <Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        }
      >
        <JobForm value={job} onChange={setJob} />
      </Dialog>
    </div>
  );
}
