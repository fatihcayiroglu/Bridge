// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/I18nPanel.svelte
//              client/js/core/i18n-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/i18n.ts
// Sprint 72: Lazy-load mimarisine geçiş
//
// Önceki yapı: 4 dil tek dosyada (~45KB) — hepsini başlangıçta yüklüyordu.
// Yeni yapı:   Türkçe (varsayılan) anında yüklenir; diğer diller setLang()
//              çağrısında dinamik import() ile ilk kez alınır ve önbelleklenir.
//              Initial bundle tasarrufu: ~34KB (en/de/fr tabloları kaldırıldı).
//
// ── Breaking changes (Sprint 72) ──────────────────────────────
//
// 1. setLang() artık void yerine Promise<void> döndürüyor.
//    - ESKİ (çalışmaya devam eder):   onclick="i18n.setLang('en')"
//    - YENİ (await ile):              await i18n.setLang('en')
//    - DOM'u dil yüklenmeden önce güncelliyorsan await kullan.
//
// 2. i18n.LANGS artık senkron tam tablo değil; yüklenen dillerin önbelleği.
//    - ESKİ (bozulur):   i18n.LANGS.en['send']
//    - YENİ:             i18n.t('send')   (dil zaten setLang ile yüklenmiş olmalı)
//    - Tüm dillere erişmek için: await i18n.preloadAll(); i18n.LANGS['en']['send']
//
// Kullanım (değişmedi):
//   import { t, setLang, lang } from './i18n.js';
//   t('send')          → "Gönder" veya "Send"
//   setLang('en')      → dili async yükle + DOM'u güncelle
//   <span data-i18n="send">  → otomatik çevrilir
//
// Dil dosyaları: client/js/core/i18n/tr.ts | en.ts | de.ts | fr.ts

import { BridgeRegistry } from './bridge-registry.js';

// ── Tip tanımları ─────────────────────────────────────────────

export type LangCode = 'tr' | 'en' | 'de' | 'fr' | 'es' | 'ja' | 'pt' | 'ko' | 'ru' | 'it' | 'zh' | 'ar' | 'nl' | 'he' | 'fa'; // Sprint 84: +4 dil; Sprint 86: +he (İbranice) +fa (Farsça)
type LangMap = Record<string, string>;

// ── Sabitler ─────────────────────────────────────────────────

const STORAGE_KEY = 'bridge_lang';
const DEFAULT: LangCode = 'tr';

// ── RTL dil kümesi ────────────────────────────────────────────
/** Bu dillerde <html dir="rtl"> ve .rtl CSS sınıfı etkinleştirilir */
export const RTL_LANGS = new Set<LangCode>(['ar', 'he', 'fa']); // Sprint 86: +İbranice +Farsça
export const SUPPORTED: LangCode[] = ['tr', 'en', 'de', 'fr', 'es', 'ja', 'pt', 'ko', 'ru', 'it', 'zh', 'ar', 'nl', 'he', 'fa']; // Sprint 86: +he +fa

// ── Çeviri önbelleği ─────────────────────────────────────────
// Türkçe başlangıçta boş — ilk erişimde lazy load ile dolar.
// (TR varsayılan olduğu için hemen yüklenir; diğerleri talep üzerine.)

const _cache: Partial<Record<LangCode, LangMap>> = {};

// ── Aktif dil ─────────────────────────────────────────────────

let _lang: LangCode = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && SUPPORTED.includes(saved as LangCode)) return saved as LangCode;
  } catch { /* ignore */ }
  const browser = (navigator.language ?? '').slice(0, 2).toLowerCase();
  return SUPPORTED.includes(browser as LangCode) ? (browser as LangCode) : DEFAULT;
})();

// ── Lazy loader ───────────────────────────────────────────────

const _loaderMap: Record<LangCode, () => Promise<{ default: LangMap }>> = {
  tr: () => import('./i18n/tr.js'),
  en: () => import('./i18n/en.js'),
  de: () => import('./i18n/de.js'),
  fr: () => import('./i18n/fr.js'),
  // Sprint 82: Yeni diller
  es: () => import('./i18n/es.js'),
  ja: () => import('./i18n/ja.js'),
  pt: () => import('./i18n/pt.js'),
  ko: () => import('./i18n/ko.js'),
  ru: () => import('./i18n/ru.js'),
  // Sprint 84: +4 dil
  it: () => import('./i18n/it.js'),
  zh: () => import('./i18n/zh.js'),
  ar: () => import('./i18n/ar.js'),
  nl: () => import('./i18n/nl.js'),
  // Sprint 86: RTL diller — İbranice + Farsça
  he: () => import('./i18n/he.js'),
  fa: () => import('./i18n/fa.js'),
};

async function _loadLang(code: LangCode): Promise<LangMap> {
  if (_cache[code]) return _cache[code]!;
  const mod = await _loaderMap[code]();
  _cache[code] = mod.default;
  return mod.default;
}

// Başlangıçta aktif dili (ve her zaman TR fallback) önyükle
const _initPromise: Promise<void> = (async () => {
  // TR her zaman yüklenir (fallback için)
  await _loadLang('tr');
  if (_lang !== 'tr') await _loadLang(_lang);
  // Başlangıç RTL uygulaması
  if (RTL_LANGS.has(_lang)) {
    document.documentElement.setAttribute('dir', 'rtl');
    document.documentElement.classList.add('rtl');
  } else {
    document.documentElement.setAttribute('dir', 'ltr');
    document.documentElement.classList.add('ltr');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => _applyAll());
  } else {
    _applyAll();
  }
})();

// ── Çeviri fonksiyonu ─────────────────────────────────────────

export function t(key: string, fallback?: string): string {
  const current = _cache[_lang];
  const tr      = _cache['tr'];
  return current?.[key] ?? tr?.[key] ?? fallback ?? key;
}

export function lang(): LangCode { return _lang; }

// ── Dil değiştirme (async) ────────────────────────────────────

export async function setLang(code: string): Promise<void> {
  if (!SUPPORTED.includes(code as LangCode)) return;
  const next = code as LangCode;
  await _loadLang(next);        // önbellekte yoksa ağdan çek
  _lang = next;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* ignore */ }
  document.documentElement.lang = code;
  // RTL / LTR yönü ayarla
  const isRtl = RTL_LANGS.has(next);
  document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');
  if (isRtl) {
    document.documentElement.classList.add('rtl');
    document.documentElement.classList.remove('ltr');
  } else {
    document.documentElement.classList.add('ltr');
    document.documentElement.classList.remove('rtl');
  }
  _applyAll();
  _dispatchChange();
}

export async function toggleLang(): Promise<void> {
  const idx = SUPPORTED.indexOf(_lang);
  await setLang(SUPPORTED[(idx + 1) % SUPPORTED.length]);
}

/** Tüm dilleri arka planda önceden yükle (opsiyonel — idle zamanında çağrılabilir) */
export async function preloadAll(): Promise<void> {
  await Promise.all(SUPPORTED.map(_loadLang));
}

// ── DOM uygulama ─────────────────────────────────────────────

export function _applyAll(root?: Element | Document): void {
  const scope: Element | Document = root ?? document;

  scope.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n ?? '');
  });

  scope.querySelectorAll<HTMLElement>('[data-i18n-html]').forEach(el => {
    el.innerHTML = t((el.dataset as Record<string, string>)['i18nHtml'] ?? '');
  });

  scope.querySelectorAll<HTMLElement>('[data-tip-i18n]').forEach(el => {
    const key = (el.dataset as Record<string, string>)['tipI18n'] ?? '';
    el.dataset.tip = t(key);
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', t(key));
  });

  scope.querySelectorAll<HTMLInputElement>('[data-placeholder-i18n]').forEach(el => {
    el.placeholder = t((el.dataset as Record<string, string>)['placeholderI18n'] ?? '');
  });

  scope.querySelectorAll<HTMLElement>('[data-aria-label-i18n]').forEach(el => {
    el.setAttribute('aria-label', t((el.dataset as Record<string, string>)['ariaLabelI18n'] ?? ''));
  });

  scope.querySelectorAll<HTMLElement>('[data-i18n-toggle]').forEach(el => {
    el.textContent  = t('lang_toggle');
    el.title        = t('lang_toggle_tip');
    el.dataset.tip  = t('lang_toggle_tip');
  });
}

// ── Event ─────────────────────────────────────────────────────

function _dispatchChange(): void {
  document.dispatchEvent(new CustomEvent('bridge:langchange', { detail: { lang: _lang } }));
}

// MutationObserver: dinamik eklenen node'ları da çevir
const _observer = new MutationObserver(mutations => {
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      const el = node as HTMLElement;
      if (el.dataset?.i18n || el.dataset?.tipI18n || el.dataset?.placeholderI18n) {
        _applyAll(el.parentElement ?? document);
      }
      if (el.querySelector?.('[data-i18n],[data-tip-i18n],[data-placeholder-i18n]')) {
        _applyAll(el);
      }
    });
  }
});
_observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true });

// ── Public API ─────────────────────────────────────────────────

export const i18n = {
  t,
  lang,
  setLang,
  toggleLang,
  preloadAll,
  apply: _applyAll,
  SUPPORTED,
  /** Sprint 72: LANGS artık senkron değil; cache erişimi için kullanın */
  get LANGS() { return _cache; },
  /** Init promise — DOM'dan önce dil yüklendi mi? */
  ready: _initPromise,
};

// window bağlantısı (HTML inline kullanımı için)
(window as unknown as Record<string, unknown>)['i18n'] = i18n;
(window as unknown as Record<string, unknown>)['__']   = (key: string, fb?: string) => t(key, fb);

// ── BridgeRegistry kaydı ──────────────────────────────────────

BridgeRegistry.register('i18n',            i18n);
BridgeRegistry.register('i18n:t',          (key: string, fb?: string) => t(key, fb));
BridgeRegistry.register('i18n:lang',       () => lang());
BridgeRegistry.register('i18n:setLang',    (code: string) => setLang(code));
BridgeRegistry.register('i18n:toggleLang', () => toggleLang());
BridgeRegistry.register('toggleLang',      () => toggleLang());
