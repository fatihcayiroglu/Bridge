// client/js/core/i18n/index.ts
// Sprint 120 — i18n Svelte5 implementasyonu
// Legacy js_core_legacy/i18n/* → Svelte5 Runes tabanlı reactive sistem
//
// Kullanım:
//   import { t, locale, setLocale } from './i18n/index.ts';
//   $t('sign_in')              // reactive çeviri
//   setLocale('en')            // dili değiştir
//   locale.current             // mevcut dil kodu

export type Locale = 'tr' | 'en' | 'es' | 'ru' | 'ja' | 'ko' | 'zh' | 'pt' | 'de' | 'fr';

export const SUPPORTED_LOCALES: Record<Locale, string> = {
  tr: 'Türkçe',
  en: 'English',
  es: 'Español',
  ru: 'Русский',
  ja: '日本語',
  ko: '한국어',
  zh: '中文',
  pt: 'Português',
  de: 'Deutsch',
  fr: 'Français',
};

// ── Çeviri tabloları (lazy-loaded) ──────────────────────────────────────────
type TranslationTable = Record<string, string>;

const _cache = new Map<Locale, TranslationTable>();

const LOCALE_LOADERS: Record<Locale, () => Promise<{ default: TranslationTable }>> = {
  tr: () => import('./tr'),
  en: () => import('./en'),
  es: () => import('./es'),
  ru: () => import('./ru'),
  ja: () => import('./ja'),
  ko: () => import('./ko'),
  zh: () => import('./zh'),
  pt: () => import('./pt'),
  de: () => import('./de'),
  fr: () => import('./fr'),
};

async function _loadLocale(loc: Locale): Promise<TranslationTable> {
  if (_cache.has(loc)) return _cache.get(loc)!;
  try {
    const mod = await LOCALE_LOADERS[loc]();
    _cache.set(loc, mod.default);
    return mod.default;
  } catch {
    // Dil dosyası yoksa EN fallback
    if (loc !== 'en') {
      const en = await _loadLocale('en');
      _cache.set(loc, en);
      return en;
    }
    return {};
  }
}

// ── Locale state (plain JS module — subscriber pattern) ─────────────────────
// Not: Svelte5 rune'ları yalnızca .svelte dosyalarında çalışır.
// .ts dosyasında subscriber pattern kullanıyoruz.

function _detectLocale(): Locale {
  try {
    const saved = localStorage.getItem('bridge_locale') as Locale | null;
    if (saved && saved in SUPPORTED_LOCALES) return saved;
    const browser = (navigator.language || 'en').split('-')[0] as Locale;
    if (browser in SUPPORTED_LOCALES) return browser;
  } catch { /* ignore */ }
  return 'tr'; // Bridge TR odaklı, varsayılan TR
}

type LocaleListener = (loc: Locale) => void;
const _listeners = new Set<LocaleListener>();

let _current: Locale = _detectLocale();
let _table: TranslationTable = {};
let _loading = false;

// İlk yükleme
_loadLocale(_current).then(tbl => {
  _table = tbl;
  document.documentElement.setAttribute('lang', _current);
  _listeners.forEach(fn => fn(_current));
});

export const locale = {
  get current(): Locale  { return _current; },
  get loading(): boolean { return _loading; },
  subscribe(fn: LocaleListener): () => void {
    _listeners.add(fn);
    fn(_current); // hemen mevcut değerle çağır
    return () => _listeners.delete(fn);
  },
};

export async function setLocale(loc: Locale): Promise<void> {
  if (loc === _current) return;
  _loading = true;
  try {
    const tbl = await _loadLocale(loc);
    _current = loc;
    _table   = tbl;
    try { localStorage.setItem('bridge_locale', loc); } catch { /* ignore */ }
    document.documentElement.setAttribute('lang', loc);
    _listeners.forEach(fn => fn(loc));
  } finally {
    _loading = false;
  }
}

// ── Ana çeviri fonksiyonu ────────────────────────────────────────────────────
export function t(key: string, fallback?: string): string {
  return _table[key] ?? fallback ?? key;
}

// Svelte template'lerinde reaktif kullanım için $derived'e benzer wrapper
// Kullanım: <span>{$t('sign_in')}</span>
// NOT: Svelte5'te fonksiyon çağrısı reaktif olduğu için t() direkt kullanılabilir.
export { t as $t };
