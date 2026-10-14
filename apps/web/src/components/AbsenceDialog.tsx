import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { fmtDay, fmtNumber, fullName, todayISO } from '../lib/format';
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea, useErrorText, useToast } from './ui';

export interface AbsenceType {
  id: string;
  name: string;
  category: string;
  unit: 'DAY' | 'HOUR';
  requiresApproval: boolean;
  countsAgainstBalance: boolean;
  allowsSubstitute: boolean;
  allowsHalfDays: boolean;
  color: string;
  active: boolean;
}

export const useAbsenceTypes = () => useQuery({ queryKey: ['absence-types'], queryFn: () => api.get<{ items: AbsenceType[] }>('/absence-types'), select: (d) => d.items });

/** Request (for oneself) or record (HR, for someone else) an absence, with a live day preview. */
export function AbsenceDialog({ open, onClose, personId, personName }: { open: boolean; onClose: () => void; personId?: string; personName?: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const types = useAbsenceTypes();
  const directory = useQuery({ queryKey: ['directory'], queryFn: () => api.get('/directory'), enabled: open });
  const active = (types.data ?? []).filter((x) => x.active);
  const [form, setForm] = useState({ typeId: '', startDate: todayISO(), endDate: todayISO(), startHalf: false, endHalf: false, openEnded: false, comment: '', substitutePersonId: '' });
  const type = active.find((x) => x.id === form.typeId) ?? active[0];
  const forOther = !!personId;

  useEffect(() => {
    if (open) setForm((f) => ({ ...f, typeId: f.typeId || active[0]?.id || '' }));
  }, [open, active.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const single = form.startDate === form.endDate;
  const previewBody = useMemo(
    () => (type && form.startDate && (form.openEnded || form.endDate >= form.startDate) ? { personId, typeId: type.id, startDate: form.startDate, endDate: form.openEnded ? form.startDate : form.endDate, startHalf: form.startHalf, endHalf: !single && form.endHalf } : null),
    [type, form, personId, single],
  );
  const preview = useQuery({
    queryKey: ['absence-preview', previewBody],
    queryFn: () => api.post('/absence-periods/preview', previewBody),
    enabled: open && !!previewBody && !form.openEnded,
  });

  const submit = useMutation({
    mutationFn: () =>
      api.post('/absence-periods', {
        personId,
        typeId: type!.id,
        startDate: form.startDate,
        endDate: form.openEnded ? null : form.endDate,
        startHalf: form.startHalf,
        endHalf: !single && form.endHalf,
        comment: form.comment || null,
        substitutePersonId: form.substitutePersonId || null,
      }),
    onSuccess: () => {
      toast(forOther ? t('absence.recorded') : t('absence.submitted'));
      qc.invalidateQueries({ queryKey: ['absences'] });
      qc.invalidateQueries({ queryKey: ['balances'] });
      qc.invalidateQueries({ queryKey: ['absence-calendar'] });
      qc.invalidateQueries({ queryKey: ['absence-approvals'] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.status === 409) toast(t('absence.overlap'), 'error');
      else if (e instanceof ApiError && e.message === 'Insufficient balance') toast(t('absence.insufficient'), 'error');
      else toast(errText(e), 'error');
    },
  });

  const total = preview.data?.total as number | undefined;
  const balance = preview.data?.balance;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={forOther ? `${t('absence.record')}${personName ? ` – ${personName}` : ''}` : t('absence.request')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={submit.isPending} disabled={!type || total === 0} onClick={() => submit.mutate()}>
            {forOther ? t('absence.record') : t('absence.submitRequest')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={t('absence.type')}>
          <Select value={type?.id ?? ''} onChange={(e) => setForm({ ...form, typeId: e.target.value })}>
            {active.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('absence.start')}>
            <Input type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: e.target.value > form.endDate ? e.target.value : form.endDate })} />
          </Field>
          <Field label={t('absence.end')}>
            <Input type="date" value={form.endDate} min={form.startDate} disabled={form.openEnded} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          {type?.allowsHalfDays && <Checkbox label={t('absence.startHalf')} checked={form.startHalf} onChange={(v) => setForm({ ...form, startHalf: v })} />}
          {type?.allowsHalfDays && !single && !form.openEnded && <Checkbox label={t('absence.endHalf')} checked={form.endHalf} onChange={(v) => setForm({ ...form, endHalf: v })} />}
          {forOther && type && !type.countsAgainstBalance && <Checkbox label={t('absence.openEnded')} checked={form.openEnded} onChange={(v) => setForm({ ...form, openEnded: v })} />}
        </div>
        {type?.allowsSubstitute && (
          <Field label={`${t('absence.substitute')} (${t('common.optional')})`}>
            <Select value={form.substitutePersonId} onChange={(e) => setForm({ ...form, substitutePersonId: e.target.value })}>
              <option value="">–</option>
              {(directory.data?.items ?? [])
                .filter((p: any) => p.id !== personId)
                .map((p: any) => (
                  <option key={p.id} value={p.id}>
                    {fullName(p)}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={`${t('common.comment')} (${t('common.optional')})`}>
          <Textarea rows={2} value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
        </Field>

        {!form.openEnded && preview.data && (
          <div className="rounded-md border border-rule bg-paper p-3" aria-live="polite">
            {total === 0 ? (
              <p className="font-semibold text-refuse">{t('absence.noWorkingDays')}</p>
            ) : (
              <p className="font-semibold">{type?.unit === 'HOUR' ? t('absence.previewHours', { count: total }) : t('absence.preview', { count: total })}</p>
            )}
            {balance && (
              <p className="text-sm text-ink-soft">
                {t('absence.balanceAfter', {
                  // The balance is per year: only days falling into that year reduce it.
                  count: fmtNumber(balance.available - preview.data.days.filter((d: any) => d.date.startsWith(String(balance.year))).reduce((s: number, d: any) => s + d.amount, 0)) as any,
                })}{' '}
                ({balance.year})
              </p>
            )}
            <ul className="mt-2 flex flex-wrap gap-1 text-xs">
              {preview.data.days.slice(0, 31).map((d: any) => (
                <li key={d.date} title={d.holiday ?? ''} className={`tnum rounded-[3px] border px-1.5 py-0.5 ${d.amount > 0 ? 'border-stamp/50 text-stamp' : 'border-rule text-ink-faint line-through'}`}>
                  {fmtDay(d.date)}
                  {d.amount === 0.5 ? ' ½' : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}
