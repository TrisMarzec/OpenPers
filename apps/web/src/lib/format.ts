import i18n from './i18n';

const locale = () => (i18n.language === 'en' ? 'en-GB' : 'de-DE');

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const toISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseISO = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00`);

/**
 * Formats a calendar date (YYYY-MM-DD) as is, or a full timestamp in the viewer's local time zone –
 * slicing a UTC timestamp would show yesterday's date for late-evening events in Europe.
 */
export function fmtDate(iso?: string | null, opts: Intl.DateTimeFormatOptions = { day: '2-digit', month: '2-digit', year: 'numeric' }) {
  if (!iso) return '–';
  return (iso.length > 10 ? new Date(iso) : parseISO(iso)).toLocaleDateString(locale(), opts);
}

export const fmtDay = (iso: string) => fmtDate(iso, { weekday: 'short', day: '2-digit', month: '2-digit' });

export function fmtRange(start: string, end?: string | null) {
  if (!end) return `${fmtDate(start)} – …`;
  return start === end ? fmtDate(start) : `${fmtDate(start)} – ${fmtDate(end)}`;
}

export const fmtTime = (dt?: string | null) => (dt ? dt.slice(11, 16) : '–');

export function fmtMinutes(min: number, signed = false) {
  const sign = min < 0 ? '−' : signed && min > 0 ? '+' : '';
  const abs = Math.abs(Math.round(min));
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')} h`;
}

export const fmtNumber = (n: number) => n.toLocaleString(locale(), { maximumFractionDigits: 2 });

export const addDaysISO = (iso: string, days: number) => {
  const d = parseISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
};

export const startOfWeek = (iso: string) => {
  const d = parseISO(iso);
  const diff = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - diff);
  return toISO(d);
};

export const fullName = (p?: { firstName: string; lastName: string; preferredName?: string | null } | null) =>
  p ? `${p.preferredName || p.firstName} ${p.lastName}` : '–';

export const initials = (p?: { firstName: string; lastName: string } | null) => (p ? `${p.firstName[0] ?? ''}${p.lastName[0] ?? ''}`.toUpperCase() : '?');
