// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/A11yWcagAaPanel.svelte
//              client/js/core/a11y-wcag-aa-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/a11y-wcag-aa.ts
// Sprint 108 — WCAG 2.1 AA Tamamlama
//
// Kapsam:
//   - Skip navigation link (kanal listesi → mesaj alanı)
//   - ARIA landmark eksiklikleri: main, nav, complementary, banner
//   - Stage/voice alanı landmark'ları
//   - Yüksek kontrast modunda zorunlu mekanizmalar
//   - Reduce motion (prefers-reduced-motion) desteği
//   - Screen reader duyuru yardımcıları (live regions)
//   - Color contrast ratio hesaplayıcı (WCAG AA: 4.5:1 normal, 3:1 büyük metin)
//
// NOT: Bu modül DOM manipülasyonu yapar; yalnızca tarayıcı ortamında çalışır.

// ── Tip tanımları ─────────────────────────────────────────────────────────────

export interface ContrastResult {
  ratio:        number;
  passAA:       boolean;
  passAALarge:  boolean;
  passAAA:      boolean;
}

// ── 1. Skip Navigation Link ───────────────────────────────────────────────────

/**
 * Sayfa başına "Ana içeriğe geç" skip-link ekler.
 * Odaklanıldığında görünür hale gelir (CSS clip → normal).
 */
export function injectSkipLink(
  mainId = 'main-content',
  label = 'Ana içeriğe geç',
): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('bridge-skip-link')) return; // zaten var

  const link = document.createElement('a');
  link.id        = 'bridge-skip-link';
  link.href      = `#${mainId}`;
  link.textContent = label;
  link.setAttribute('lang', document.documentElement.lang || 'tr');

  // WCAG 2.1 SC 2.4.1: bileşen görünür olana kadar CSS ile gizle
  Object.assign(link.style, {
    position:   'absolute',
    left:       '-9999px',
    top:        '4px',
    zIndex:     '99999',
    padding:    '8px 16px',
    background: 'var(--brand, #2d9cdb)',
    color:      '#fff',
    borderRadius: '0 0 4px 4px',
    fontWeight: '600',
    fontSize:   '14px',
    textDecoration: 'none',
  });

  link.addEventListener('focus',  () => { link.style.left = '4px'; });
  link.addEventListener('blur',   () => { link.style.left = '-9999px'; });

  document.body.insertBefore(link, document.body.firstChild);
}

// ── 2. ARIA Landmark Denetimi ─────────────────────────────────────────────────

interface LandmarkSpec {
  selector:  string;
  role:      string;
  label:     string;
  required?: boolean;
}

const REQUIRED_LANDMARKS: LandmarkSpec[] = [
  {
    selector: '#server-list, [data-testid="server-list"]',
    role:     'navigation',
    label:    'Sunucu listesi',
    required: true,
  },
  {
    selector: '#channel-list, [data-testid="channel-list"], .channel-list',
    role:     'navigation',
    label:    'Kanal listesi',
    required: true,
  },
  {
    selector: '#messages-container, [data-testid="messages"], .messages-container',
    role:     'main',
    label:    'Mesajlar',
    required: true,
  },
  {
    selector: '#member-list, [data-testid="member-list"], .member-list',
    role:     'complementary',
    label:    'Üye listesi',
    required: false,
  },
  {
    selector: '#voice-bar, [data-testid="voice-bar"], .voice-bar',
    role:     'complementary',
    label:    'Ses kanalı durumu',
    required: false,
  },
  {
    selector: '#stage-area, [data-testid="stage"], .stage-container',
    role:     'region',
    label:    'Sahne alanı',
    required: false,
  },
];

/**
 * Eksik ARIA landmark'larını DOM'a uygular.
 * Her eleman için `role` ve `aria-label` eksikse ekler; mevcutsa dokunmaz.
 */
export function patchLandmarks(): void {
  if (typeof document === 'undefined') return;

  for (const spec of REQUIRED_LANDMARKS) {
    const el = document.querySelector<HTMLElement>(spec.selector);
    if (!el) continue;

    if (!el.getAttribute('role') && spec.role !== 'main') {
      el.setAttribute('role', spec.role);
    }
    if (!el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby')) {
      el.setAttribute('aria-label', spec.label);
    }

    // main landmark için tabindex -1 (skip-link hedefi)
    if (spec.role === 'main' && !el.getAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1');
      if (!el.id) el.id = 'main-content';
    }
  }
}

// ── 3. Reduced Motion Desteği ─────────────────────────────────────────────────

/**
 * `prefers-reduced-motion: reduce` ortam sorgusunu izler.
 * Değişince `<html>` üzerinde `data-reduced-motion` attribute'unu günceller.
 * CSS: [data-reduced-motion] * { animation-duration: 0.01ms !important; }
 */
export function initReducedMotion(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');

  function apply(reduced: boolean): void {
    document.documentElement.setAttribute(
      'data-reduced-motion',
      reduced ? 'true' : 'false',
    );
  }

  apply(mq.matches);

  const handler = (e: MediaQueryListEvent) => apply(e.matches);
  mq.addEventListener('change', handler);

  return () => mq.removeEventListener('change', handler);
}

// ── 4. Live Region Announcer ──────────────────────────────────────────────────

let _politeRegion:   HTMLElement | null = null;
let _assertiveRegion: HTMLElement | null = null;

function _getOrCreateRegion(politeness: 'polite' | 'assertive'): HTMLElement {
  const id  = `bridge-live-${politeness}`;
  const existing = document.getElementById(id);
  if (existing) return existing;

  const el = document.createElement('div');
  el.id = id;
  el.setAttribute('role', 'log');
  el.setAttribute('aria-live', politeness);
  el.setAttribute('aria-atomic', 'false');
  el.setAttribute('aria-relevant', 'additions text');
  Object.assign(el.style, {
    position:   'absolute',
    width:      '1px',
    height:     '1px',
    padding:    '0',
    margin:     '-1px',
    overflow:   'hidden',
    clip:       'rect(0,0,0,0)',
    whiteSpace: 'nowrap',
    border:     '0',
  });

  document.body.appendChild(el);
  return el;
}

/** Ekran okuyucuya kibar (polite) duyuru gönder */
export function announcePolite(message: string): void {
  if (typeof document === 'undefined') return;
  _politeRegion = _getOrCreateRegion('polite');
  _politeRegion.textContent = '';
  requestAnimationFrame(() => {
    if (_politeRegion) _politeRegion.textContent = message;
  });
}

/** Ekran okuyucuya kesici (assertive) duyuru gönder (hatalar, kritik bilgiler) */
export function announceAssertive(message: string): void {
  if (typeof document === 'undefined') return;
  _assertiveRegion = _getOrCreateRegion('assertive');
  _assertiveRegion.textContent = '';
  requestAnimationFrame(() => {
    if (_assertiveRegion) _assertiveRegion.textContent = message;
  });
}

// ── 5. Color Contrast Hesaplayıcı (WCAG 2.1 Spec) ────────────────────────────

/**
 * Hex rengi [r, g, b] dizisine dönüştürür.
 * #rgb, #rrggbb formatlarını destekler.
 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.replace('#', '');
  let r: number, g: number, b: number;

  if (clean.length === 3) {
    r = parseInt(clean[0] + clean[0], 16);
    g = parseInt(clean[1] + clean[1], 16);
    b = parseInt(clean[2] + clean[2], 16);
  } else if (clean.length === 6) {
    r = parseInt(clean.slice(0, 2), 16);
    g = parseInt(clean.slice(2, 4), 16);
    b = parseInt(clean.slice(4, 6), 16);
  } else {
    return null;
  }

  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r, g, b];
}

/**
 * Göreli parlaklık hesaplar (WCAG 2.1 formülü).
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const toLinear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * İki renk arasındaki kontrast oranını ve WCAG AA/AAA geçme durumunu döner.
 *
 * @param foreground - ön plan rengi (#rrggbb)
 * @param background - arka plan rengi (#rrggbb)
 * @param isLargeText - büyük metin mi? (18pt+ normal veya 14pt+ kalın)
 */
export function contrastRatio(
  foreground: string,
  background: string,
  isLargeText = false,
): ContrastResult | null {
  const fg = hexToRgb(foreground);
  const bg = hexToRgb(background);
  if (!fg || !bg) return null;

  const l1 = relativeLuminance(...fg);
  const l2 = relativeLuminance(...bg);
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  const ratio   = (lighter + 0.05) / (darker + 0.05);

  return {
    ratio:       Math.round(ratio * 100) / 100,
    passAA:      isLargeText ? ratio >= 3.0 : ratio >= 4.5,
    passAALarge: ratio >= 3.0,
    passAAA:     isLargeText ? ratio >= 4.5 : ratio >= 7.0,
  };
}

// ── 6. Voice/Stage ARIA ───────────────────────────────────────────────────────

/**
 * Ses kanalı barını ekran okuyucular için semantik hale getirir.
 * Kullanıcı ses kanalına girince duyuruda bulunur.
 */
export function patchVoiceBarAria(channelName?: string): void {
  if (typeof document === 'undefined') return;

  const bar = document.querySelector<HTMLElement>(
    '#voice-bar, [data-testid="voice-bar"], .voice-bar',
  );
  if (!bar) return;

  if (!bar.getAttribute('role')) bar.setAttribute('role', 'complementary');
  if (!bar.getAttribute('aria-label')) {
    bar.setAttribute('aria-label', channelName ? `Ses kanalı: ${channelName}` : 'Ses kanalı');
  }

  // Mikrofon ve ses butonlarına aria-label ekle
  const micBtn = bar.querySelector<HTMLElement>('[data-testid="mute-btn"], .mute-btn, #mute-btn');
  if (micBtn && !micBtn.getAttribute('aria-label')) {
    micBtn.setAttribute('aria-label', 'Mikrofonu sessize al / aç');
    micBtn.setAttribute('aria-pressed', 'false');
  }

  const deafenBtn = bar.querySelector<HTMLElement>('[data-testid="deafen-btn"], .deafen-btn');
  if (deafenBtn && !deafenBtn.getAttribute('aria-label')) {
    deafenBtn.setAttribute('aria-label', 'Kulaklığı kapat / aç');
    deafenBtn.setAttribute('aria-pressed', 'false');
  }

  if (channelName) {
    announcePolite(`${channelName} ses kanalına katıldınız`);
  }
}

/**
 * Sahne alanını (Stage) ARIA region olarak işaretler.
 * Konuşmacı değişimlerinde ekran okuyucuya bildirim gönderir.
 */
export function patchStageAria(speakerName?: string): void {
  if (typeof document === 'undefined') return;

  const stage = document.querySelector<HTMLElement>(
    '#stage-area, [data-testid="stage"], .stage-container',
  );
  if (!stage) return;

  if (!stage.getAttribute('role')) stage.setAttribute('role', 'region');
  if (!stage.getAttribute('aria-label')) stage.setAttribute('aria-label', 'Sahne alanı');

  if (speakerName) {
    announcePolite(`${speakerName} konuşuyor`);
  }
}

// ── 7. Otomatik başlatma ──────────────────────────────────────────────────────

/**
 * Uygulama başlangıcında tüm A11Y düzeltmelerini uygular.
 * app.ts'te `initA11yWcagAA()` olarak çağrılır.
 */
export function initA11yWcagAA(): void {
  if (typeof document === 'undefined') return;

  injectSkipLink();
  patchLandmarks();
  const cleanupReducedMotion = initReducedMotion();

  // DOM değişimlerini izle — SPA route geçişlerinde landmark'ları yeniden uygula
  const observer = new MutationObserver(() => {
    patchLandmarks();
  });

  observer.observe(document.body, { childList: true, subtree: false });

  // Sayfa kapanınca temizle
  window.addEventListener('unload', () => {
    observer.disconnect();
    cleanupReducedMotion();
  }, { once: true });
}
