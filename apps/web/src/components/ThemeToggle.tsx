import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';
import { getThemePref, setThemePref, type ThemePref } from '../lib/theme';
import { cx } from './ui';

const OPTIONS: { value: ThemePref; icon: typeof Moon }[] = [
  { value: 'dark', icon: Moon },
  { value: 'light', icon: Sun },
  { value: 'system', icon: Monitor },
];

/** Segmented control for the colour theme. */
export function ThemeToggle() {
  const { t } = useTranslation();
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  useEffect(() => {
    const on = (e: Event) => setPref((e as CustomEvent<ThemePref>).detail);
    window.addEventListener('openpers:theme', on);
    return () => window.removeEventListener('openpers:theme', on);
  }, []);
  return (
    <div role="radiogroup" aria-label={t('theme.label')} className="inline-flex rounded-[var(--radius-ctl)] border border-rule p-0.5">
      {OPTIONS.map(({ value, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={pref === value}
          title={t(`theme.${value}`)}
          aria-label={t(`theme.${value}`)}
          onClick={() => setThemePref(value)}
          className={cx('rounded-[4px] p-1.5', pref === value ? 'bg-stamp-wash text-stamp' : 'text-ink-faint hover:text-ink')}
        >
          <Icon size={15} aria-hidden />
        </button>
      ))}
    </div>
  );
}
