// client/js/core/theme-store.ts
// Faz 2 (tasarım) — Tema motoru: saf mantık, Svelte/DOM yaşam döngüsü yok.
//
// GERİ KAZANILAN DAVRANIŞ
// ───────────────────────
// tokens.css beş temayı eksiksiz tanımlıyordu ama kullanıcı hiçbirine
// erişemiyordu: ThemeManager/ThemeSelector/ThemeStyles üçü de 52 satırlık
// boş kabuktu ve index.html'deki tema düğmesi tanımsız `toggleTheme()`
// çağırıp ReferenceError fırlatıyordu.
//
// SORUMLULUK SINIRI
//   theme-store.ts     → tema listesi, doğrulama, kalıcılık, DOM'a uygulama
//   ThemeManager.svelte → yaşam döngüsü + registry sözleşmesi + düğme bağlama
//   theme-boot (inline) → ilk boyamadan ÖNCE aynı anahtarı okur (FOUC yok)
//
// ÖNEMLİ: Buradaki uygulama mantığı index.html'deki bootstrap script'iyle
// AYNI sözleşmeyi paylaşır (anahtar adı + data-theme + theme-light sınıfı).
// Biri değişirse diğeri de değişmeli.

import { createLogger } from './logger.ts';

const log = createLogger('ThemeStore');

/**
 * Kullanılabilir temalar.
 *
 * DİKKAT: Bu liste tokens.css'te GERÇEKTEN tanımlı olanlarla birebir aynıdır.
 * Legacy `theme.ts` ayrıca 'sunset' ve 'forest' listeliyordu ama bu ikisinin
 * hiçbir token bloğu yok — döngü onlara geldiğinde uygulama tanımsız
 * yüzeylerle (okunamaz metin) kalıyordu. Yeni tema eklenecekse ÖNCE
 * tokens.css'e bloğu yazılmalı, sonra buraya eklenmeli.
 */
export const THEMES = ['dark', 'light', 'amoled', 'aurora', 'midnight'] as const;

export type ThemeId = typeof THEMES[number];

export const DEFAULT_THEME: ThemeId = 'dark';

/** Tek düğmelik döngüde gösterilen simge — mevcut #btn-theme sözleşmesi. */
export const THEME_ICONS: Record<ThemeId, string> = {
  dark:     '🌙',
  light:    '☀️',
  amoled:   '🌑',
  aurora:   '🌠',
  midnight: '🌌',
};

export const THEME_LABEL_KEYS: Record<ThemeId, string> = {
  dark: 'theme_dark', light: 'theme_light', amoled: 'theme_amoled',
  aurora: 'theme_aurora', midnight: 'theme_midnight',
};

/**
 * Depolama anahtarı.
 *
 * Tema bir CİHAZ/TARAYICI tercihidir, kullanıcı hesabı tercihi değil:
 *   - aynı kişi farklı cihazlarda farklı ortam ışığında çalışır
 *   - giriş yapılmadan (auth ekranında) da doğru tema uygulanmalı
 *   - ilk boyamadan önce okunur; o an oturum kimliği henüz bilinmiyor
 * Bu yüzden anahtar kullanıcıya göre bölünmez ve ÇIKIŞTA SİLİNMEZ.
 * (Taslaklar tam tersi: onlar içerik olduğu için kullanıcı bazlıdır.)
 *
 * Sürüm eki: şema değişirse eski değerler sessizce çakışmasın.
 */
export const THEME_STORAGE_KEY = 'bridge:theme:v1';

/** Legacy anahtar — bir kez okunup yeni anahtara taşınır, sonra silinir. */
const LEGACY_STORAGE_KEY = 'bridge_theme';

// ── Doğrulama ────────────────────────────────────────────────────────────────

/** Verilen değer gerçekten tanımlı bir tema mı? */
export function isTheme(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}

export function getAvailableThemes(): ReadonlyArray<ThemeId> {
  return THEMES;
}

// ── Kalıcılık ────────────────────────────────────────────────────────────────

function storage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

/**
 * Kayıtlı tercihi okur.
 *
 * Bozuk/bilinmeyen/kaldırılmış tema adı `null` döner — çağıran sistem
 * tercihine veya varsayılana düşer. Depolama kapalıysa da `null`.
 */
export function readStoredTheme(): ThemeId | null {
  try {
    const raw = storage()?.getItem(THEME_STORAGE_KEY);
    if (isTheme(raw)) return raw;

    // Tek seferlik göç: eski `bridge_theme` anahtarı.
    const legacy = storage()?.getItem(LEGACY_STORAGE_KEY);
    if (isTheme(legacy)) {
      writeStoredTheme(legacy);
      try { storage()?.removeItem(LEGACY_STORAGE_KEY); } catch { /* önemsiz */ }
      return legacy;
    }

    // Tanınmayan değer (elle düzenlenmiş, kaldırılmış tema) — temizle.
    if (raw !== null && raw !== undefined) {
      try { storage()?.removeItem(THEME_STORAGE_KEY); } catch { /* önemsiz */ }
      log.warn('Bilinmeyen tema değeri silindi');
    }
    return null;
  } catch {
    return null;
  }
}

/** Tercihi yazar. Depolama kapalıysa sessizce geçer — tema yine uygulanır. */
export function writeStoredTheme(theme: ThemeId): void {
  try { storage()?.setItem(THEME_STORAGE_KEY, theme); } catch { /* kota/kapalı */ }
}

/**
 * İşletim sistemi tercihi.
 *
 * Kullanıcının AÇIK bir seçimi varsa o kazanır; yoksa sistem tercihine
 * uyulur. Böylece ilk açılışta koyu mod kullanan biri beyaz ekranla
 * karşılaşmaz, ama seçim yapan kişinin tercihi de sistem tarafından ezilmez.
 */
export function systemTheme(): ThemeId {
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Uygulanacak başlangıç teması: kayıtlı tercih → sistem → varsayılan. */
export function resolveInitialTheme(): ThemeId {
  return readStoredTheme() ?? systemTheme();
}

// ── Uygulama ─────────────────────────────────────────────────────────────────

/**
 * Temayı DOM'a uygular.
 *
 * `data-theme` gövdeye yazılır (tokens.css selektörleriyle aynı sözleşme).
 * `theme-light` sınıfı legacy CSS modülleri için korunur.
 * `<html>`'e de yazılır: ilk boyama script'i orada başlatır ve
 * `color-scheme` tarayıcı arayüzünü (kaydırma çubuğu, form denetimleri)
 * temaya uydurur.
 */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement;
  const body = document.body;

  root.setAttribute('data-theme', theme);
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  if (body) {
    body.setAttribute('data-theme', theme);
    body.classList.toggle('theme-light', theme === 'light');
  }
}

/** Döngüdeki bir sonraki tema. */
export function nextTheme(current: ThemeId): ThemeId {
  const index = THEMES.indexOf(current);
  return THEMES[(index + 1) % THEMES.length];
}

/** Şu an uygulanmış tema (DOM gerçeği; depolama değil). */
export function currentTheme(): ThemeId {
  const attr = document.documentElement.getAttribute('data-theme')
    ?? document.body?.getAttribute('data-theme');
  return isTheme(attr) ? attr : DEFAULT_THEME;
}
