import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCESS_LEVELS, DATA_CATEGORIES, DEFAULT_FIELD_ACCESS, PERMISSIONS, SCOPES, type AccessLevel, type DataCategory, type FieldAccess } from '@openpers/shared';
import { api } from '../../lib/api';
import { Button, Checkbox, cx, Dialog, Field, Input, Section, Select, Table, useErrorText, useToast } from '../../components/ui';
import { AccessBadge } from '../../components/Profile';

interface Role {
  id?: string;
  key: string;
  name: string;
  permissions: string[];
  defaultScope: string;
  builtin?: boolean;
  fieldAccess: FieldAccess;
}

function AccessMatrix({ value, onChange, disabled }: { value: FieldAccess; onChange: (v: FieldAccess) => void; disabled?: boolean }) {
  const { t } = useTranslation();
  const set = (c: DataCategory, who: 'self' | 'others', level: AccessLevel) => onChange({ ...value, [c]: { ...value[c], [who]: level } });
  return (
    <table className="w-full border-collapse text-left text-sm">
      <thead>
        <tr className="border-b border-rule text-ink-soft">
          <th className="py-1.5 font-semibold">{t('access.category')}</th>
          <th className="py-1.5 font-semibold">{t('access.own')}</th>
          <th className="py-1.5 font-semibold">{t('access.others')}</th>
        </tr>
      </thead>
      <tbody>
        {DATA_CATEGORIES.map((c) => (
          <tr key={c} className="border-b border-rule-soft last:border-0">
            <td className="py-1.5 pr-3">
              <div className="font-semibold">{t(`categories.${c}`)}</div>
              <div className="text-xs text-ink-faint">{t(`categoryHints.${c}`)}</div>
            </td>
            {(['self', 'others'] as const).map((who) => (
              <td key={who} className="py-1.5 pr-2">
                <Select className={cx('h-9', value[c][who] === 'edit' ? 'text-grant' : value[c][who] === 'none' ? 'text-ink-faint' : '')} disabled={disabled} value={value[c][who]} aria-label={`${t(`categories.${c}`)} – ${t(who === 'self' ? 'access.own' : 'access.others')}`} onChange={(e) => set(c, who, e.target.value as AccessLevel)}>
                  {ACCESS_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {t(`access.${l}`)}
                    </option>
                  ))}
                </Select>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Roles with their permissions and their access matrix for sensitive data. */
export function RolesSection() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const q = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ items: Role[] }>('/roles') });
  const [edit, setEdit] = useState<Role | null>(null);
  const scopes = t('settings.scopes', { returnObjects: true }) as Record<string, string>;
  const save = useMutation({
    mutationFn: () => {
      const r = edit!;
      if (!r.id) return api.post('/roles', { key: r.key, name: r.name, permissions: r.permissions, defaultScope: r.defaultScope, fieldAccess: r.fieldAccess });
      if (r.builtin) return api.patch(`/roles/${r.id}`, { fieldAccess: r.fieldAccess });
      return api.patch(`/roles/${r.id}`, { name: r.name, permissions: r.permissions, defaultScope: r.defaultScope, fieldAccess: r.fieldAccess });
    },
    onSuccess: () => {
      toast(t('common.saved'));
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['roles'] });
      qc.invalidateQueries({ queryKey: ['person'] });
    },
    onError: (e) => toast(errText(e), 'error'),
  });
  const locked = edit?.key === 'admin';
  return (
    <Section
      title={t('settings.roles')}
      actions={
        <Button size="sm" onClick={() => setEdit({ key: '', name: '', permissions: ['people.read'], defaultScope: 'reports', fieldAccess: DEFAULT_FIELD_ACCESS })}>
          {t('common.add')}
        </Button>
      }
    >
      <p className="mb-3 text-sm text-ink-soft">{t('access.intro')}</p>
      <Table head={[t('common.name'), t('settings.scope'), ...DATA_CATEGORIES.map((c) => t(`categories.${c}`)), '']}>
        {(q.data?.items ?? []).map((r) => (
          <tr key={r.id}>
            <td className="font-semibold">
              {r.name}
              {r.builtin && <span className="block text-xs font-normal text-ink-faint">{t('access.builtin')}</span>}
            </td>
            <td className="text-sm">{scopes[r.defaultScope]}</td>
            {DATA_CATEGORIES.map((c) => (
              <td key={c} title={`${t('access.own')}: ${t(`access.${r.fieldAccess[c].self}`)} · ${t('access.others')}: ${t(`access.${r.fieldAccess[c].others}`)}`}>
                <AccessBadge level={r.fieldAccess[c].others} />
              </td>
            ))}
            <td className="text-right">
              <Button size="sm" variant="ghost" onClick={() => setEdit(structuredClone(r))}>
                {t('common.edit')}
              </Button>
            </td>
          </tr>
        ))}
      </Table>
      <p className="mt-2 text-xs text-ink-faint">{t('access.tableHint')}</p>
      <Dialog
        open={!!edit}
        wide
        onClose={() => setEdit(null)}
        title={edit?.id ? edit.name : t('access.newRole')}
        footer={
          !locked && (
            <Button variant="primary" busy={save.isPending} onClick={() => save.mutate()}>
              {t('common.save')}
            </Button>
          )
        }
      >
        {edit && (
          <div className="grid gap-5">
            {locked && <p className="text-sm text-ink-soft">{t('access.adminLocked')}</p>}
            {!edit.builtin && (
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label={t('common.name')}>
                  <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                </Field>
                {!edit.id && (
                  <Field label={t('settings.fieldKey')} hint="a–z, 0–9, _">
                    <Input value={edit.key} onChange={(e) => setEdit({ ...edit, key: e.target.value })} />
                  </Field>
                )}
                <Field label={t('settings.scope')}>
                  <Select value={edit.defaultScope} onChange={(e) => setEdit({ ...edit, defaultScope: e.target.value })}>
                    {SCOPES.map((s) => (
                      <option key={s} value={s}>
                        {scopes[s]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            <div>
              <h3 className="mb-2 font-bold">{t('access.matrixTitle')}</h3>
              <AccessMatrix value={edit.fieldAccess} onChange={(fieldAccess) => setEdit({ ...edit, fieldAccess })} disabled={locked} />
            </div>
            {!edit.builtin && (
              <fieldset>
                <legend className="mb-2 font-bold">{t('settings.permissions')}</legend>
                <div className="grid gap-1.5 sm:grid-cols-3">
                  {PERMISSIONS.filter((p) => p !== 'people.sensitive').map((p) => (
                    <Checkbox key={p} label={p} checked={edit.permissions.includes(p)} onChange={(v) => setEdit({ ...edit, permissions: v ? [...edit.permissions, p] : edit.permissions.filter((x) => x !== p) })} />
                  ))}
                </div>
              </fieldset>
            )}
          </div>
        )}
      </Dialog>
    </Section>
  );
}
