import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { initials } from '../lib/format';
import { Avatar, Button, useErrorText, useToast } from './ui';

interface Named {
  id: string;
  firstName: string;
  lastName: string;
}

/** personId → photo URL from the company directory (visible to every signed-in user). */
export function usePhotoMap() {
  const dir = useQuery({ queryKey: ['directory'], queryFn: () => api.get<{ items: { id: string; photoUrl: string | null }[] }>('/directory'), staleTime: 300_000 });
  return new Map((dir.data?.items ?? []).map((p) => [p.id, p.photoUrl]));
}

/** Avatar for any person record; looks up the photo when the record does not carry one. */
export function PersonAvatar({ person, size = 32 }: { person: Named & { photoUrl?: string | null }; size?: number }) {
  const photos = usePhotoMap();
  return <Avatar name={initials(person)} size={size} src={person.photoUrl !== undefined ? person.photoUrl : photos.get(person.id)} />;
}

const loadImage = (file: File) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable'));
    img.src = URL.createObjectURL(file);
  });

const toBlob = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), type, 0.88));

/** Centre-crops to a square and scales to 512 px, so uploads stay small and EXIF data is dropped. */
export async function squarePhoto(file: File, size = 512): Promise<Blob> {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.min(size, side);
  canvas.getContext('2d')!.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  return toBlob(canvas, 'image/jpeg');
}

/** Scales raster logos to at most 512 px height (keeping transparency); SVG is uploaded as is. */
export async function fitLogo(file: File): Promise<Blob> {
  if (file.type === 'image/svg+xml') return file;
  const img = await loadImage(file);
  const scale = Math.min(1, 512 / img.naturalHeight, 1024 / img.naturalWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(img.src);
  return toBlob(canvas, 'image/png');
}

/** Hidden file input behind a regular button, so the picker is keyboard accessible. */
export function ImagePicker({ accept, label, busy, onPick, badge }: { accept: string; label: string; busy?: boolean; onPick: (file: File) => void; badge?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) onPick(f);
        }}
      />
      {badge ? (
        <button type="button" aria-label={label} title={label} disabled={busy} onClick={() => ref.current?.click()} className={badgeClass}>
          <Camera size={14} aria-hidden />
        </button>
      ) : (
        <Button size="sm" busy={busy} onClick={() => ref.current?.click()}>
          <Camera size={14} aria-hidden /> {label}
        </Button>
      )}
    </>
  );
}

/** Small round action sitting on the edge of an avatar. */
const badgeClass = 'grid size-7 place-items-center rounded-full border-2 border-paper bg-sheet text-ink-soft shadow-sm hover:text-ink disabled:opacity-60';

/** Large avatar with change/remove actions for the profile header. */
export function PhotoEditor({ person, editable }: { person: Named & { photoUrl?: string | null }; editable: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const refresh = () => ['person', 'directory', 'persons', 'me'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append('file', await squarePhoto(file), 'photo.jpg');
      return api.put(`/persons/${person.id}/photo`, form);
    },
    onSuccess: () => {
      toast(t('photo.saved'));
      refresh();
    },
    onError: (e) => toast(e instanceof Error && e.message === 'unreadable' ? t('photo.unreadable') : errText(e), 'error'),
  });
  const remove = useMutation({ mutationFn: () => api.delete(`/persons/${person.id}/photo`), onSuccess: refresh, onError: (e) => toast(errText(e), 'error') });
  return (
    <div className="relative shrink-0">
      <Avatar name={initials(person)} size={72} src={person.photoUrl} />
      {editable && (
        <div className="absolute -right-1 -bottom-1 flex gap-1">
          {person.photoUrl && (
            <button type="button" aria-label={t('photo.remove')} title={t('photo.remove')} disabled={remove.isPending} onClick={() => confirm(t('photo.removeConfirm')) && remove.mutate()} className={badgeClass}>
              <Trash2 size={13} aria-hidden />
            </button>
          )}
          <ImagePicker badge accept="image/png,image/jpeg,image/webp" label={person.photoUrl ? t('photo.change') : t('photo.upload')} busy={upload.isPending} onPick={(f) => upload.mutate(f)} />
        </div>
      )}
    </div>
  );
}

/** Company name and logo, public so login and careers pages can show them too. */
export function useBranding() {
  return useQuery({ queryKey: ['branding'], queryFn: () => api.get<{ name: string | null; logoUrl: string | null }>('/public/company'), staleTime: 300_000 }).data;
}

/** Company logo, or the OpenPers mark when none is uploaded. */
export function BrandMark({ className = 'h-8' }: { className?: string }) {
  const b = useBranding();
  if (b?.logoUrl) return <img src={b.logoUrl} alt={b.name ?? ''} className={`${className} w-auto max-w-[11rem] object-contain`} />;
  return <img src="/favicon.svg" alt="" className={`${className} w-auto`} />;
}

/** Logo upload with a preview on light and dark surfaces. */
export function LogoEditor() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const toast = useToast();
  const errText = useErrorText();
  const b = useBranding();
  const refresh = () => ['branding', 'company'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      const blob = await fitLogo(file);
      form.append('file', blob, blob.type === 'image/svg+xml' ? 'logo.svg' : 'logo.png');
      return api.put('/company/logo', form);
    },
    onSuccess: () => {
      toast(t('photo.logoSaved'));
      refresh();
    },
    onError: (e) => toast(e instanceof Error && e.message === 'unreadable' ? t('photo.unreadable') : errText(e), 'error'),
  });
  const remove = useMutation({ mutationFn: () => api.delete('/company/logo'), onSuccess: refresh, onError: (e) => toast(errText(e), 'error') });
  return (
    <div className="grid gap-3">
      <p className="text-sm font-semibold">{t('photo.logo')}</p>
      {b?.logoUrl ? (
        <div className="grid max-w-md grid-cols-2 overflow-hidden rounded-md border border-rule">
          <div className="flex h-20 items-center justify-center bg-white p-3">
            <img src={b.logoUrl} alt={t('photo.logoOnLight')} className="max-h-full max-w-full object-contain" />
          </div>
          <div className="flex h-20 items-center justify-center bg-[#16181d] p-3">
            <img src={b.logoUrl} alt={t('photo.logoOnDark')} className="max-h-full max-w-full object-contain" />
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-soft">{t('photo.noLogo')}</p>
      )}
      <p className="text-xs text-ink-faint">{t('photo.logoHint')}</p>
      <div className="flex gap-2">
        <ImagePicker accept="image/png,image/jpeg,image/webp,image/svg+xml" label={b?.logoUrl ? t('photo.changeLogo') : t('photo.uploadLogo')} busy={upload.isPending} onPick={(f) => upload.mutate(f)} />
        {b?.logoUrl && (
          <Button size="sm" variant="ghost" busy={remove.isPending} onClick={() => confirm(t('photo.removeLogoConfirm')) && remove.mutate()}>
            <Trash2 size={14} aria-hidden /> {t('photo.removeLogo')}
          </Button>
        )}
      </div>
    </div>
  );
}
