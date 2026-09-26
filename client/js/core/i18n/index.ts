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
  zh: '简体中文',
  pt: 'Português',
  de: 'Deutsch',
  fr: 'Français',
};

export type LocaleStatus = 'stable' | 'beta';
export const LOCALE_STATUS: Record<Locale, LocaleStatus> = {
  tr: 'stable', en: 'stable', es: 'stable', ru: 'stable', ja: 'stable',
  ko: 'stable', zh: 'stable', pt: 'stable', de: 'stable', fr: 'stable',
};

export const LOCALE_TAGS: Record<Locale, string> = {
  tr: 'tr-TR', en: 'en-US', es: 'es-ES', ru: 'ru-RU', ja: 'ja-JP',
  ko: 'ko-KR', zh: 'zh-CN', pt: 'pt-BR', de: 'de-DE', fr: 'fr-FR',
};

export function localeTag(loc: Locale = locale.current): string {
  return LOCALE_TAGS[loc];
}

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


async function _syncLocaleToServiceWorker(loc: Locale): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const target = navigator.serviceWorker.controller ?? registration.active ?? registration.waiting;
    target?.postMessage({ type: 'SET_LOCALE', locale: loc });
  } catch { /* service worker may be unavailable */ }
}

// İlk yükleme.
//
// Bu, modül yüklenirken başlayan ASENKRON bir işti ve hiçbir yerden
// gözlenemiyordu: tablo gelmeden çağrılan `t('bir_anahtar')` (yedek metin
// verilmemişse) HAM ANAHTARI döndürüyor. Testlerde bu, süitin hangi anda
// koştuğuna göre değişen sonuçlar üretti — bazı iddialar `'ui_bridge_user'`,
// bazıları `'Bridge user'` görüyordu. Söz artık DIŞA AÇILIR; böylece hem
// testler hem de ilk boyamayı bekleyen çağıranlar tabloyu bekleyebilir.
export const localeReady: Promise<void> = _loadLocale(_current).then(tbl => {
  _table = tbl;
  document.documentElement.setAttribute('lang', _current);
  void _syncLocaleToServiceWorker(_current);
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
    void _syncLocaleToServiceWorker(loc);
    // Final21 Phase 16: the server writes push copy in the language this person reads.
    void import('./locale-sync.ts').then(m => m.reportLocaleToServer(loc)).catch(() => {});
    _listeners.forEach(fn => fn(loc));
  } finally {
    _loading = false;
  }
}

// ── Ana çeviri fonksiyonu ────────────────────────────────────────────────────
//
// ── ÜÇÜNCÜ PARAMETRE: DEĞİŞKEN YERLEŞTİRME ─────────────────────────────────
// Kullanıcıya görünen metinlerin bir kısmı değer taşır: "3 okunmamış",
// "{kullanıcı} susturuldu", "Adım 2". Bunlar dize birleştirmeyle çevrilemez,
// çünkü sözcük sırası dile göre değişir ve çevirmen cümlenin tamamını göremez.
//
// Bu yüzden metin, ADLI yer tutucularla TEK bir çeviri birimi olarak kalır:
//
//     t('sl_muted', '🔇 {user} susturuldu', { user: username })
//
// Bilinmeyen yer tutucu OLDUĞU GİBİ bırakılır — sessizce boş dize üretmek
// yerine görünür kalması yeğdir; eksik değişken böylece fark edilir.
//
// KANONİK SAHİP BURASIDIR. `i18n/reactive.svelte.ts` yalnızca Svelte
// reaktifliği ekleyen ince bir sarmalayıcıdır ve bu fonksiyona devreder;
// ikinci bir yerleştirme uygulaması YOKTUR.
export function t(
  key: string,
  fallback?: string,
  vars?: Record<string, string | number>,
): string {
  const out = _table[key] ?? fallback ?? key;
  if (!vars) return out;
  return out.replace(/\{(\w+)\}/g, (m, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m);
}

// Svelte template'lerinde reaktif kullanım için $derived'e benzer wrapper
// Kullanım: <span>{$t('sign_in')}</span>
// NOT: Svelte5'te fonksiyon çağrısı reaktif olduğu için t() direkt kullanılabilir.
export { t as $t };
