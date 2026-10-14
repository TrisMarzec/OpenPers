import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { ApiError } from '../lib/api';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');
export { cx };

// ---------- Button ----------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-stamp text-white hover:bg-stamp-dark border-stamp hover:border-stamp-dark',
  secondary: 'bg-sheet text-ink border-rule hover:border-ink-faint',
  ghost: 'bg-transparent text-ink-soft border-transparent hover:bg-rule-soft hover:text-ink',
  danger: 'bg-sheet text-refuse border-refuse/40 hover:bg-refuse-wash',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; busy?: boolean }>(function Button(
  { variant = 'secondary', size = 'md', busy, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-ctl)] border font-semibold whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-8 px-2.5 text-sm' : 'h-10 px-4',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

// ---------- Form fields ----------
/** Label + control + hint/error. The label wraps the control so it is announced by screen readers. */
export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-ink">{label}</span>
        {children}
      </label>
      {error ? (
        <p role="alert" className="text-sm text-refuse">
          {error}
        </p>
      ) : hint ? (
        <p className="text-sm text-ink-faint">{hint}</p>
      ) : null}
    </div>
  );
}

const control = 'w-full rounded-[var(--radius-ctl)] border border-rule bg-sheet px-3 text-ink placeholder:text-ink-faint focus:border-stamp focus:outline-none focus:ring-2 focus:ring-stamp/20 disabled:bg-paper aria-[invalid=true]:border-refuse';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, 'h-10', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(control, 'h-10 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(control, 'min-h-24 py-2', className)} {...rest} />;
});

export function Checkbox({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 size-4 accent-stamp" />
      <label htmlFor={id} className="text-sm">
        {label}
        {hint && <span className="block text-ink-faint">{hint}</span>}
      </label>
    </div>
  );
}

// ---------- Status stamp ----------
const stampTone: Record<string, string> = {
  approved: 'text-grant',
  ACTIVE: 'text-grant',
  published: 'text-grant',
  delivered: 'text-grant',
  ENABLED: 'text-grant',
  pending: 'text-wait',
  ONBOARDING: 'text-wait',
  draft: 'text-ink-faint',
  rejected: 'text-refuse',
  failed: 'text-refuse',
  cancelled: 'text-ink-faint',
  INACTIVE: 'text-ink-faint',
  closed: 'text-ink-faint',
  DISABLED: 'text-ink-faint',
  ARCHIVED: 'text-ink-faint',
  LEAVE: 'text-stamp',
};

export function Stamp({ status, children }: { status: string; children?: ReactNode }) {
  const { t } = useTranslation();
  return <span className={cx('stamp', stampTone[status] ?? 'text-ink-soft')}>{children ?? t(`status.${status}`, status)}</span>;
}

export function Swatch({ color }: { color: string }) {
  return <span aria-hidden className="inline-block size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />;
}

// ---------- Layout bits ----------
export function PageHeader({ title, actions, children }: { title: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3 border-b border-rule pb-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {children && <div className="mt-1 text-ink-soft">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

export function Section({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-md border border-rule bg-sheet', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-rule-soft px-4 py-3">
          <h2 className="font-bold">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-md border border-dashed border-rule px-4 py-6 text-ink-soft">
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; hidden?: boolean }[] }) {
  return (
    <div role="tablist" className="mb-5 flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-rule)]">
      {items
        .filter((i) => !i.hidden)
        .map((i) => (
          <button
            key={i.value}
            role="tab"
            type="button"
            aria-selected={value === i.value}
            onClick={() => onChange(i.value)}
            className={cx('border-b-2 px-3 py-2 font-semibold whitespace-nowrap', value === i.value ? 'border-stamp text-stamp' : 'border-transparent text-ink-soft hover:text-ink')}
          >
            {i.label}
          </button>
        ))}
    </div>
  );
}

export function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={cx('overflow-x-auto rounded-md border border-rule bg-sheet', className)}>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-rule bg-paper/60 text-sm text-ink-soft">
            {head.map((h, i) => (
              <th key={i} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-rule-soft [&>tr:last-child]:border-0 [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-middle">{children}</tbody>
      </table>
    </div>
  );
}

export function Spinner() {
  const { t } = useTranslation();
  return <p className="py-6 text-ink-faint">{t('common.loading')}</p>;
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const hue = [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full font-bold text-white" style={{ width: size, height: size, fontSize: size * 0.38, background: `hsl(${hue} 45% 38%)` }}>
      {name}
    </span>
  );
}

// ---------- Dialog ----------
export function Dialog({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useTranslation();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // showModal() focuses the close button; move focus to the first form control instead.
      requestAnimationFrame(() => d.querySelector<HTMLElement>('[autofocus], input:not([type=hidden]), select, textarea')?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={cx('m-auto w-[calc(100%-2rem)] rounded-md border border-rule bg-sheet p-0 text-ink shadow-xl', wide ? 'max-w-3xl' : 'max-w-lg')}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-rule-soft px-5 py-3">
            <h2 className="text-lg font-bold">{title}</h2>
            <button type="button" aria-label={t('common.close')} onClick={onClose} className="rounded p-1 text-ink-soft hover:bg-rule-soft">
              <X size={18} />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-rule-soft px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

// ---------- Toasts ----------
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} className={cx('rounded-md border px-4 py-2.5 font-semibold shadow-md', t.tone === 'ok' ? 'border-grant/40 bg-grant-wash text-grant' : 'border-refuse/40 bg-refuse-wash text-refuse')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Turns an API error into a user-facing message. */
export function useErrorText() {
  const { t } = useTranslation();
  return (err: unknown) => {
    if (err instanceof ApiError) {
      if (err.status === 403) return t('common.forbidden');
      if (err.status === 422 && err.errors.length) {
        const fields = [...new Set(err.errors.map((e) => e.path).filter(Boolean))];
        return fields.length ? `${t('common.checkFields')}: ${fields.join(', ')}` : err.errors[0].message;
      }
      return err.message || t('common.errorGeneric');
    }
    return t('common.errorGeneric');
  };
}
