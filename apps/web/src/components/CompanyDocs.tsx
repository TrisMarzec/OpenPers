import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, FileText, Trash2, Users } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fullName } from '../lib/format';
import { Button, Checkbox, Dialog, Empty, Field, Input, Section, Select, Spinner, Textarea, useErrorText, useToast } from './ui';

export interface CompanyDoc {
  id: string;
  title: string;
  description: string | null;
  fileName: string;
  mime: string;
  size: number;
  requiresAck: boolean;
  orgUnitId: string | null;
  createdAt: string;
  acknowledgedAt: string | null;
  stats?: { acknowledged: number; audience: number };
}

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function useCompanyDocs() {
  return useQuery({ queryKey: ['company-documents'], queryFn: () => api.get<{ items: CompanyDoc[] }>('/company-documents') });
}

/** Number of documents the signed-in employee still has to confirm (nav badge). */
export function useOpenConfirmations() {
  const { me } = useAuth();
  const q = useQuery({ queryKey: ['company-documents'], queryFn: () => api.get<{ items: CompanyDoc[] }>('/company-documents'), enabled: !!me?.personId, refetchInterval: 300_000 });
  return (q.data?.items ?? []).filter((d) => d.requiresAck && !d.acknowledgedAt).length;
}

/** Upload dialog; `preset` pre-fills a recommended document from the setup guide. */
export function CompanyDocUpload({ preset, onClose }: { preset?: { title: string; requiresAck: boolean; description?: string }; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const fileRef = useRef<HTMLInputElement>(null);
  const units = useQuery({ queryKey: ['org-units'], queryFn: () => api.get('/org-units') });
  const [f, setF] = useState({ title: preset?.title ?? '', description: preset?.description ?? '', requiresAck: preset?.requiresAck ?? true, orgUnitId: '' });
  const [hasFile, setHasFile] = useState(false);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set('title', f.title);
      if (f.description) form.set('description', f.description);
      form.set('requiresAck', String(f.requiresAck));
      if (f.orgUnitId) form.set('orgUnitId', f.orgUnitId);
      form.set('file', fileRef.current!.files![0]);
      return api.upload('/company-documents', form);
    },
    onSuccess: () => {
      toast(t('companyDocs.uploaded'));
      qc.invalidateQueries({ queryKey: ['company-documents'] });
      qc.invalidateQueries({ queryKey: ['setup-guide'] });
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('companyDocs.upload')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={upload.isPending} disabled={!f.title.trim() || !hasFile} onClick={() => upload.mutate()}>
            {t('companyDocs.publish')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={t('documents.file')} hint={t('documents.fileHint')}>
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt,.md" onChange={(e) => setHasFile(!!e.target.files?.length)} className="block w-full text-sm file:mr-3 file:rounded-[var(--radius-ctl)] file:border file:border-rule file:bg-sheet file:px-3 file:py-2 file:font-semibold" />
        </Field>
        <Field label={t('companyDocs.docTitle')}>
          <Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </Field>
        <Field label={`${t('companyDocs.description')} (${t('common.optional')})`}>
          <Textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label={t('companyDocs.audience')}>
          <Select value={f.orgUnitId} onChange={(e) => setF({ ...f, orgUnitId: e.target.value })}>
            <option value="">{t('companyDocs.everyone')}</option>
            {(units.data?.items ?? []).map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox label={t('companyDocs.requiresAck')} hint={t('companyDocs.requiresAckHint')} checked={f.requiresAck} onChange={(v) => setF({ ...f, requiresAck: v })} />
      </div>
    </Dialog>
  );
}

function AckDialog({ doc, onClose }: { doc: CompanyDoc; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['company-document-acks', doc.id], queryFn: () => api.get(`/company-documents/${doc.id}/acknowledgements`) });
  return (
    <Dialog open onClose={onClose} title={t('companyDocs.ackTitle', { title: doc.title })}>
      {q.isLoading ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-2 font-semibold">{t('companyDocs.pending', { count: q.data.pending.length })}</h3>
            <ul className="grid gap-1 text-sm">
              {q.data.pending.map((p: any) => (
                <li key={p.person.id}>{fullName(p.person)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3 className="mb-2 font-semibold">{t('companyDocs.confirmed', { count: q.data.acknowledged.length })}</h3>
            <ul className="grid gap-1 text-sm">
              {q.data.acknowledged.map((p: any) => (
                <li key={p.person.id} className="flex justify-between gap-2">
                  <span>{fullName(p.person)}</span>
                  <span className="tnum text-ink-faint">{fmtDate(p.acknowledgedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Company documents: employees read and confirm; HR publishes and sees who is missing. */
export function CompanyDocumentsSection() {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const manage = can('documents.manage');
  const q = useCompanyDocs();
  const [uploading, setUploading] = useState(false);
  const [acks, setAcks] = useState<CompanyDoc | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['company-documents'] });
  const ack = useMutation({ mutationFn: (id: string) => api.post(`/company-documents/${id}/acknowledge`), onSuccess: () => (toast(t('companyDocs.thanks')), refresh()), onError: (e) => toast(errText(e), 'error') });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/company-documents/${id}`), onSuccess: () => (toast(t('common.deleted')), refresh()), onError: (e) => toast(errText(e), 'error') });
  const items = q.data?.items ?? [];
  return (
    <Section
      title={t('companyDocs.title')}
      actions={
        manage && (
          <Button size="sm" variant="primary" onClick={() => setUploading(true)}>
            {t('companyDocs.upload')}
          </Button>
        )
      }
    >
      {q.isLoading ? (
        <Spinner />
      ) : !items.length ? (
        <Empty>{manage ? t('companyDocs.emptyManage') : t('companyDocs.empty')}</Empty>
      ) : (
        <ul className="divide-y divide-rule">
          {items.map((d) => {
            const open = d.requiresAck && !d.acknowledgedAt && !!me?.personId;
            return (
              <li key={d.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileText size={20} className="shrink-0 text-ink-faint" aria-hidden />
                <div className="min-w-0 flex-1">
                  <a href={`/api/v1/company-documents/${d.id}/download`} className="font-semibold text-ink hover:text-stamp hover:underline">
                    {d.title}
                  </a>
                  <p className="text-sm text-ink-soft">
                    {[d.description, `${fmtDate(d.createdAt)} · ${fmtSize(d.size)}`].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {d.requiresAck && manage && d.stats && (
                  <button type="button" onClick={() => setAcks(d)} className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-ink-soft hover:bg-rule-soft" title={t('companyDocs.showAcks')}>
                    <Users size={15} aria-hidden />
                    <span className="tnum">
                      {d.stats.acknowledged} / {d.stats.audience}
                    </span>
                  </button>
                )}
                {d.requiresAck && d.acknowledgedAt && (
                  <span className="flex items-center gap-1 text-sm text-grant">
                    <CheckCircle2 size={15} aria-hidden /> {t('companyDocs.readOn', { date: fmtDate(d.acknowledgedAt) })}
                  </span>
                )}
                {open && (
                  <Button size="sm" variant="primary" busy={ack.isPending && ack.variables === d.id} onClick={() => ack.mutate(d.id)}>
                    {t('companyDocs.acknowledge')}
                  </Button>
                )}
                <a href={`/api/v1/company-documents/${d.id}/download`} aria-label={t('documents.download')} className="inline-flex rounded p-1.5 text-ink-soft hover:bg-rule-soft">
                  <Download size={16} />
                </a>
                {manage && (
                  <Button size="sm" variant="ghost" aria-label={t('common.delete')} onClick={() => confirm(t('companyDocs.deleteConfirm')) && remove.mutate(d.id)}>
                    <Trash2 size={15} />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {openCount(items, me?.personId) > 0 && <p className="mt-3 text-sm text-wait">{t('companyDocs.openHint', { count: openCount(items, me?.personId) })}</p>}
      {uploading && <CompanyDocUpload onClose={() => setUploading(false)} />}
      {acks && <AckDialog doc={acks} onClose={() => setAcks(null)} />}
    </Section>
  );
}

/** Documents the employee still has to confirm. */
const openCount = (items: CompanyDoc[], personId?: string | null) => (personId ? items.filter((d) => d.requiresAck && !d.acknowledgedAt).length : 0);
