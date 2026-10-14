export type ThemePref = 'dark' | 'light' | 'system';

const KEY = 'openpers.theme';
/** Dark is the default for OpenPers. */
export const DEFAULT_THEME: ThemePref = 'dark';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_THEME;
}

export function resolveTheme(pref: ThemePref): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(pref: ThemePref) {
  document.documentElement.dataset.theme = resolveTheme(pref);
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  applyTheme(pref);
  window.dispatchEvent(new CustomEvent('openpers:theme', { detail: pref }));
}

// Follow OS changes while "system" is selected.
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (getThemePref() === 'system') applyTheme('system');
});
