import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { REGION_NAMES, REGIONS } from '@openpers/shared';
import { api } from '../../lib/api';
import { Button, Checkbox, Dialog, Empty, Field, Input, Section, Select, Table, Textarea, useErrorText, useToast } from '../../components/ui';

export interface FieldSpec {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'select' | 'region' | 'color' | 'checkbox' | 'textarea' | 'list';
  options?: { value: string; label: string }[];
  hint?: ReactNode;
  required?: boolean;
  /** Shown in the table (default true). */
  column?: boolean;
  render?: (row: any) => ReactNode;
  /** Only when creating. */
  createOnly?: boolean;
}

export function FormFields({ fields, value, onChange, editing }: { fields: FieldSpec[]; value: any; onChange: (v: any) => void; editing?: boolean }) {
  return (
    <div className="grid gap-4">
      {fields
        .filter((f) => !(editing && f.createOnly))
        .map((f) => {
          const v = value[f.key];
          const set = (x: unknown) => onChange({ ...value, [f.key]: x });
          if (f.type === 'checkbox') return <Checkbox key={f.key} label={f.label} hint={f.hint} checked={!!v} onChange={set} />;
          return (
            <Field key={f.key} label={f.label} hint={f.hint}>
              {f.type === 'select' || f.type === 'region' ? (
                <Select value={v ?? ''} onChange={(e) => set(e.target.value)}>
                  {!f.required && <option value="">–</option>}
                  {(f.type === 'region' ? REGIONS.map((r) => ({ value: r, label: REGION_NAMES[r] })) : (f.options ?? [])).map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              ) : f.type === 'textarea' ? (
                <Textarea rows={8} value={v ?? ''} onChange={(e) => set(e.target.value)} />
              ) : f.type === 'list' ? (
                <Input value={Array.isArray(v) ? v.join(', ') : (v ?? '')} onChange={(e) => set(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
              ) : (
                <Input
                  type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : f.type === 'color' ? 'color' : 'text'}
                  value={v ?? ''}
                  className={f.type === 'color' ? 'w-20 p-1' : ''}
                  onChange={(e) => set(f.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value)}
                />
              )}
            </Field>
          );
        })}
    </div>
  );
}

/** List + create/edit dialog for a simple REST collection. */
export function CrudSection({
  title,
  path,
  fields,
  defaults = {},
  canDelete = true,
  canEdit = true,
  toBody = (v) => v,
  intro,
}: {
  title: ReactNode;
  path: string;
  fields: FieldSpec[];
  defaults?: Record<string, unknown>;
  canDelete?: boolean;
  canEdit?: boolean;
  toBody?: (v: any, editing: boolean) => any;
  intro?: ReactNode;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const [edit, setEdit] = useState<{ id?: string; value: any } | null>(null);
  const q = useQuery({ queryKey: [path.slice(1)], queryFn: () => api.get(path) });
  const save = useMutation({
    mutationFn: () => {
      const editing = !!edit!.id;
      const picked = Object.fromEntries(fields.filter((f) => !(editing && f.createOnly)).map((f) => [f.key, edit!.value[f.key]]));
      const clean = Object.fromEntries(Object.entries(toBody(picked, editing)).map(([k, v]) => [k, v === '' ? null : v]).filter(([, v]) => v !== undefined));
      return edit!.id ? api.patch(`${path}/${edit!.id}`, clean) : api.post(path, clean);
    },
    onSuccess: () => {
      toast(t('common.saved'));
      setEdit(null);
      qc.invalidateQueries({ queryKey: [path.slice(1)] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`${path}/${id}`),
    onSuccess: () => {
      toast(t('common.deleted'));
      qc.invalidateQueries({ queryKey: [path.slice(1)] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const cols = fields.filter((f) => f.column !== false);
  const display = (f: FieldSpec, row: any) => {
    if (f.render) return f.render(row);
    const v = row[f.key];
    if (f.type === 'checkbox') return v ? t('common.yes') : t('common.no');
    if (f.type === 'region') return REGION_NAMES[v as keyof typeof REGION_NAMES] ?? v;
    if (f.type === 'select') return f.options?.find((o) => o.value === v)?.label ?? '–';
    if (f.type === 'color') return <span className="inline-block size-4 rounded-[2px] border border-rule" style={{ background: v }} />;
    if (Array.isArray(v)) return v.join(', ');
    return v ?? '–';
  };
  return (
    <Section
      title={title}
      actions={
        <Button size="sm" onClick={() => setEdit({ value: { ...defaults } })}>
          {t('common.add')}
        </Button>
      }
    >
      {intro && <p className="mb-3 text-sm text-ink-soft">{intro}</p>}
      {!q.data?.items.length ? (
        <Empty>{t('common.none')}</Empty>
      ) : (
        <Table head={[...cols.map((c) => c.label), '']}>
          {q.data.items.map((row: any) => (
            <tr key={row.id}>
              {cols.map((c, i) => (
                <td key={c.key} className={i === 0 ? 'font-semibold' : ''}>
                  {display(c, row)}
                </td>
              ))}
              <td className="text-right whitespace-nowrap">
                {canEdit && (
                  <button type="button" aria-label={t('common.edit')} className="rounded p-1.5 text-ink-soft hover:bg-rule-soft" onClick={() => setEdit({ id: row.id, value: row })}>
                    <Pencil size={15} />
                  </button>
                )}
                {canDelete && !row.builtin && (
                  <button type="button" aria-label={t('common.delete')} className="rounded p-1.5 text-ink-soft hover:bg-refuse-wash hover:text-refuse" onClick={() => confirm(t('common.confirmDelete')) && del.mutate(row.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={title}
        footer={
          <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        }
      >
        {edit && <FormFields fields={fields} value={edit.value} editing={!!edit.id} onChange={(value) => setEdit({ ...edit, value })} />}
      </Dialog>
    </Section>
  );
}
