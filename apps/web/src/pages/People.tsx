import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fullName, initials, todayISO } from '../lib/format';
import { Avatar, Button, Dialog, Empty, Field, Input, PageHeader, Select, Spinner, Stamp, Table, useErrorText, useToast } from '../components/ui';

export function useOrgData() {
  const orgUnits = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const workplaces = useQuery({ queryKey: ['workplaces'], queryFn: () => api.get('/workplaces') });
  const legalEntities = useQuery({ queryKey: ['legal-entities'], queryFn: () => api.get('/legal-entities') });
  const directory = useQuery({ queryKey: ['directory'], queryFn: () => api.get('/directory') });
  return { orgUnits: orgUnits.data?.items ?? [], workplaces: workplaces.data?.items ?? [], legalEntities: legalEntities.data?.items ?? [], directory: directory.data?.items ?? [] };
}

export function WeekHoursInput({ value, onChange }: { value: number[]; onChange: (v: number[]) => void }) {
  const { t } = useTranslation();
  const labels = t('person.weekdays', { returnObjects: true }) as string[];
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {value.map((h, i) => (
        <label key={i} className="flex flex-col items-center gap-1 text-xs font-semibold text-ink-soft">
          {labels[i]}
          <Input type="number" min={0} max={24} step={0.5} value={h} className="tnum h-9 px-1 text-center" onChange={(e) => onChange(value.map((x, j) => (j === i ? Number(e.target.value) : x)))} />
        </label>
      ))}
    </div>
  );
}

function NewPersonDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const navigate = useNavigate();
  const org = useOrgData();
  const [f, setF] = useState({ firstName: '', lastName: '', email: '', startDate: todayISO(), positionTitle: '', contractType: 'PERMANENT', supervisorPersonId: '', orgUnitId: '', workplaceId: '', legalEntityId: '', weeklyHours: [8, 8, 8, 8, 8, 0, 0] });
  const [error, setError] = useState<ApiError | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.post('/persons', {
        firstName: f.firstName,
        lastName: f.lastName,
        email: f.email,
        employment: {
          startDate: f.startDate,
          positionTitle: f.positionTitle || null,
          contractType: f.contractType,
          supervisorPersonId: f.supervisorPersonId || null,
          orgUnitIds: f.orgUnitId ? [f.orgUnitId] : [],
          workplaceId: f.workplaceId || null,
          legalEntityId: f.legalEntityId || null,
          weeklyHours: f.weeklyHours,
        },
      }),
    onSuccess: (p) => {
      toast(t('people.created'));
      qc.invalidateQueries({ queryKey: ['persons'] });
      qc.invalidateQueries({ queryKey: ['directory'] });
      navigate(`/people/${p.id}`);
    },
    onError: (e) => {
      setError(e as ApiError);
      toast(errText(e), 'error');
    },
  });
  const fe = (p: string) => error?.fieldError?.(p);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('people.new')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={create.isPending} onClick={() => create.mutate()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('person.firstName')} error={fe('firstName')}>
          <Input value={f.firstName} onChange={set('firstName')} autoFocus />
        </Field>
        <Field label={t('person.lastName')} error={fe('lastName')}>
          <Input value={f.lastName} onChange={set('lastName')} />
        </Field>
        <Field label={t('person.email')} error={fe('email')} className="sm:col-span-2">
          <Input type="email" value={f.email} onChange={set('email')} />
        </Field>
        <Field label={t('people.startDate')} error={fe('employment.startDate')}>
          <Input type="date" value={f.startDate} onChange={set('startDate')} />
        </Field>
        <Field label={t('people.position')}>
          <Input value={f.positionTitle} onChange={set('positionTitle')} />
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
        <Field label={t('person.supervisor')}>
          <Select value={f.supervisorPersonId} onChange={set('supervisorPersonId')}>
            <option value="">–</option>
            {org.directory.map((p: any) => (
              <option key={p.id} value={p.id}>
                {fullName(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('person.orgUnits')}>
          <Select value={f.orgUnitId} onChange={set('orgUnitId')}>
            <option value="">–</option>
            {org.orgUnits.map((o: any) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('person.workplace')}>
          <Select value={f.workplaceId} onChange={set('workplaceId')}>
            <option value="">–</option>
            {org.workplaces.map((o: any) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('person.weeklyHours')} className="sm:col-span-2">
          <WeekHoursInput value={f.weeklyHours} onChange={(weeklyHours) => setF({ ...f, weeklyHours })} />
        </Field>
      </div>
    </Dialog>
  );
}

export function PeoplePage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const full = can('people.read');
  const list = useQuery({ queryKey: ['persons', search], queryFn: () => api.get(`/persons?limit=200${search ? `&search=${encodeURIComponent(search)}` : ''}`), enabled: full });
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get('/directory') });
  const canCreate = can('people.write', 'all');

  // Persons the caller may open in full; everyone else is shown from the company directory.
  const visibleIds = new Set((list.data?.items ?? []).map((p: any) => p.id));
  const rows = (dir.data?.items ?? []).filter((p: any) => !search || `${p.firstName} ${p.lastName} ${p.email}`.toLowerCase().includes(search.toLowerCase()));
  const extra = (list.data?.items ?? []).filter((p: any) => !rows.some((r: any) => r.id === p.id));

  return (
    <div>
      <PageHeader
        title={t('people.title')}
        actions={
          canCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              {t('people.new')}
            </Button>
          )
        }
      />
      <div className="mb-4 max-w-sm">
        <Input type="search" placeholder={t('people.searchPlaceholder')} aria-label={t('common.search')} value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {dir.isLoading ? (
        <Spinner />
      ) : rows.length + extra.length === 0 ? (
        <Empty
          action={
            canCreate && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                {t('people.new')}
              </Button>
            )
          }
        >
          {search ? t('people.noResults') : t('people.empty')}
        </Empty>
      ) : (
        <Table head={[t('common.name'), t('people.position'), t('people.team'), t('people.startDate'), t('common.status')]}>
          {[...rows, ...extra].map((p: any) => {
            const detail = list.data?.items.find((x: any) => x.id === p.id);
            const linkable = visibleIds.has(p.id);
            return (
              <tr key={p.id} className={linkable ? 'hover:bg-paper' : ''}>
                <td>
                  <div className="flex items-center gap-3">
                    <Avatar name={initials(p)} src={p.photoUrl} />
                    <div>
                      {linkable ? (
                        <Link to={`/people/${p.id}`} className="font-semibold text-ink hover:text-stamp hover:underline">
                          {fullName(p)}
                        </Link>
                      ) : (
                        <span className="font-semibold">{fullName(p)}</span>
                      )}
                      <div className="text-sm text-ink-faint">{p.email}</div>
                    </div>
                  </div>
                </td>
                <td>{p.positionTitle ?? '–'}</td>
                <td>{(p.orgUnits ?? []).map((o: any) => o.name).join(', ') || '–'}</td>
                <td className="tnum">{detail ? fmtDate(detail.startDate) : '–'}</td>
                <td>{(detail?.status ?? p.status) && <Stamp status={detail?.status ?? p.status} />}</td>
              </tr>
            );
          })}
        </Table>
      )}
      {creating && <NewPersonDialog open onClose={() => setCreating(false)} />}
    </div>
  );
}
