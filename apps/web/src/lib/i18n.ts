import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import de from '../locales/de';
import en from '../locales/en';

const stored = (() => {
  try {
    return localStorage.getItem('openpers.lang');
  } catch {
    return null;
  }
})();

i18n.use(initReactI18next).init({
  resources: { de: { translation: de }, en: { translation: en } },
  lng: stored ?? (navigator.language.startsWith('de') ? 'de' : 'en'),
  fallbackLng: 'de',
  interpolation: { escapeValue: false },
});

export function setLanguage(lng: 'de' | 'en') {
  i18n.changeLanguage(lng);
  document.documentElement.lang = lng;
  try {
    localStorage.setItem('openpers.lang', lng);
  } catch {
    /* storage unavailable */
  }
}

export default i18n;
