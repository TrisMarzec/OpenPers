import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate } from '../lib/format';
import { Button, Checkbox, Dialog, Empty, Field, Input, PageHeader, Select, Spinner, Table, useErrorText, useToast } from '../components/ui';
import { CompanyDocumentsSection } from '../components/CompanyDocs';

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function UploadDialog({ open, onClose, personId, full }: { open: boolean; onClose: () => void; personId: string; full: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const cats = useQuery({ queryKey: ['document-categories'], queryFn: () => api.get('/document-categories') });
  const fileRef = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ categoryId: '', name: '', documentDate: '', visible: false, visibleTouched: false });
  const upload = useMutation({
    mutationFn: () => {
      const file = fileRef.current?.files?.[0];
      const form = new FormData();
      if (f.categoryId) form.set('categoryId', f.categoryId);
      if (f.name) form.set('name', f.name);
      if (f.documentDate) form.set('documentDate', f.documentDate);
      if (full && f.visibleTouched) form.set('employeeVisible', String(f.visible));
      if (file) form.set('file', file);
      return api.upload(`/persons/${personId}/documents`, form);
    },
    onSuccess: () => {
      toast(t('documents.uploaded'));
      qc.invalidateQueries({ queryKey: ['documents', personId] });
      onClose();
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const cat = cats.data?.items.find((c: any) => c.id === f.categoryId);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('documents.upload')}
      footer={
        <>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" busy={upload.isPending} onClick={() => upload.mutate()}>
            {t('documents.upload')}
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field label={t('documents.file')} hint={t('documents.fileHint')}>
          <input ref={fileRef} type="file" accept=".pdf,.png,.jpg,.jpeg,.docx,.xlsx,.txt" className="block w-full text-sm file:mr-3 file:rounded-[var(--radius-ctl)] file:border file:border-rule file:bg-sheet file:px-3 file:py-2 file:font-semibold" />
        </Field>
        <Field label={t('documents.category')}>
          <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
            <option value="">{t('documents.uncategorized')}</option>
            {(cats.data?.items ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`${t('common.name')} (${t('common.optional')})`}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={`${t('documents.documentDate')} (${t('common.optional')})`}>
          <Input type="date" value={f.documentDate} onChange={(e) => setF({ ...f, documentDate: e.target.value })} />
        </Field>
        {full && <Checkbox label={t('documents.visible')} checked={f.visibleTouched ? f.visible : (cat?.employeeVisible ?? false)} onChange={(v) => setF({ ...f, visible: v, visibleTouched: true })} />}
      </div>
    </Dialog>
  );
}

function TemplateDialog({ open, onClose, personId }: { open: boolean; onClose: () => void; personId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const tpls = useQuery({ queryKey: ['document-templates'], queryFn: () => api.get('/document-templates') });
  const [id, setId] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const render = useMutation({
    mutationFn: (save: boolean) => api.post(`/document-templates/${id || tpls.data?.items[0]?.id}/render/${personId}`, { save }),
    onSuccess: (r, save) => {
      setContent(r.content);
      if (save) {
        toast(t('documents.generated'));
        qc.invalidateQueries({ queryKey: ['documents', personId] });
        onClose();
      }
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={t('documents.fromTemplate')}
      footer={
        <>
          <Button onClick={() => render.mutate(false)}>{t('documents.preview')}</Button>
          <Button variant="primary" busy={render.isPending} onClick={() => render.mutate(true)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <Field label={t('documents.template')}>
        <Select value={id} onChange={(e) => setId(e.target.value)}>
          {(tpls.data?.items ?? []).map((x: any) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
      {content && <pre className="mt-4 rounded-md border border-rule bg-paper p-3 text-sm whitespace-pre-wrap">{content}</pre>}
    </Dialog>
  );
}

export function DocumentList({ personId }: { personId: string }) {
  const { t } = useTranslation();
  const { me, can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [uploading, setUploading] = useState(false);
  const [templating, setTemplating] = useState(false);
  const full = can('documents.write');
  const q = useQuery({ queryKey: ['documents', personId], queryFn: () => api.get(`/persons/${personId}/documents`) });
  const cats = useQuery({ queryKey: ['document-categories'], queryFn: () => api.get('/document-categories') });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: () => {
      toast(t('common.deleted'));
      qc.invalidateQueries({ queryKey: ['documents', personId] });
    },
  });
  const catName = (id: string | null) => cats.data?.items.find((c: any) => c.id === id)?.name ?? t('documents.uncategorized');
  const canUpload = full || personId === me?.personId;
  return (
    <div>
      <div className="mb-3 flex flex-wrap justify-end gap-2">
        {full && (
          <Button onClick={() => setTemplating(true)} variant="secondary">
            {t('documents.fromTemplate')}
          </Button>
        )}
        {canUpload && (
          <Button variant="primary" onClick={() => setUploading(true)}>
            {t('documents.upload')}
          </Button>
        )}
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.items.length ? (
        <Empty>{t('documents.empty')}</Empty>
      ) : (
        <Table head={[t('common.name'), t('documents.category'), t('common.date'), '', '']}>
          {q.data.items.map((d: any) => (
            <tr key={d.id}>
              <td>
                <a href={`/api/v1/documents/${d.id}/download`} className="font-semibold text-ink hover:text-stamp hover:underline">
                  {d.name}
                </a>
                <span className="block text-sm text-ink-faint">{fmtSize(d.size)}</span>
              </td>
              <td>{catName(d.categoryId)}</td>
              <td className="tnum">{fmtDate(d.documentDate ?? d.createdAt)}</td>
              <td className="text-sm text-ink-faint">{full && (d.employeeVisible ? t('documents.visible') : t('documents.hidden'))}</td>
              <td className="text-right whitespace-nowrap">
                <a href={`/api/v1/documents/${d.id}/download`} aria-label={t('documents.download')} className="inline-flex rounded p-1.5 text-ink-soft hover:bg-rule-soft">
                  <Download size={16} />
                </a>
                {d.manageable && (
                  <button type="button" aria-label={t('common.delete')} className="rounded p-1.5 text-ink-soft hover:bg-refuse-wash hover:text-refuse" onClick={() => confirm(t('common.confirmDelete')) && del.mutate(d.id)}>
                    <Trash2 size={16} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      {uploading && <UploadDialog open onClose={() => setUploading(false)} personId={personId} full={full} />}
      {templating && <TemplateDialog open onClose={() => setTemplating(false)} personId={personId} />}
    </div>
  );
}

export function MyDocumentsPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  return (
    <div>
      <PageHeader title={t('documents.title')} />
      <div className="grid gap-6">
        <CompanyDocumentsSection />
        {me?.personId && (
          <div>
            <h2 className="mb-3 text-lg font-bold">{t('documents.personal')}</h2>
            <DocumentList personId={me.personId} />
          </div>
        )}
      </div>
    </div>
  );
}
