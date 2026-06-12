// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/UtilsPanel.svelte
//              client/js/core/utils-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/utils.ts
// Genel yardımcı fonksiyonlar: güvenlik, DOM, bildirim
//
// Sprint 31: Tam ESM export. window.location.origin → location.origin
// (browser API — kaçınılmaz, ama window prefix kaldırıldı)

// ── HTML güvenliği ────────────────────────────────────────────────────────────

/**
 * Kullanıcı / sunucu kaynaklı bir değeri HTML-güvenli string'e dönüştürür.
 * innerHTML ile DOM'a yazılacak her değerin bu fonksiyondan geçmesi zorunludur.
 *
 * @param s - Herhangi bir değer; null/undefined boş string olarak işlenir.
 * @returns &amp; &lt; &gt; &quot; &#39; karakterleri escape edilmiş string.
 *
 * @example
 * el.innerHTML = `<strong>${escHtml(user.displayName)}</strong>`;
 */
export function escHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * CSS renk değerini doğrular; geçersizse güvenli bir varsayılan döndürür.
 *
 * @param value - Doğrulanacak renk değeri (#RGB veya #RRGGBBAA formatında).
 * @returns Geçerli hex renk string'i veya `'#808080'` (gri varsayılan).
 */
export function cssColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  return '#808080';
}

/**
 * Verilen URL'nin yalnızca kendi origin'den veya `/uploads/` dizininden
 * gelmesi durumunda güvenli kabul eder. Aksi hâlde boş string döndürür.
 *
 * Open-redirect ve arbitrary-origin kaynak yüklemelerini önler.
 *
 * @param url - Doğrulanacak URL.
 * @returns Güvenli URL string'i veya `''`.
 */
export function safeFileUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  if (url.startsWith('/uploads/') || url.startsWith('data:image/')) return url;
  try {
    const u = new URL(url, location.origin);
    if (u.origin === location.origin) return url;
  } catch { /* fall */ }
  return '';
}

// ── İsim yardımcıları ─────────────────────────────────────────────────────────

/**
 * Görünen isimden iki harfli baş harf üretir (avatar placeholder için).
 *
 * @param name - Kullanıcı adı veya ekran adı.
 * @returns İki karakterlik büyük harf string ("AY", "BR" vb.) veya `'?'`.
 *
 * @example
 * avatarEl.textContent = initials(user.displayName); // "AY"
 */
export function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Toast bildirimi ───────────────────────────────────────────────────────────

/**
 * Ekranın köşesinde kısa süreli bir bildirim (toast) gösterir.
 *
 * @param msg      - Gösterilecek mesaj metni.
 * @param type     - CSS sınıfı: `'success'` | `'error'` | `'info'` | `'warning'`
 * @param duration - Görünür kalma süresi (ms). Varsayılan: 3000.
 */
export function toast(msg: string, type = '', duration = 3000): void {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c?.appendChild(el);
  const fadeAt = Math.max(duration - 500, duration * 0.8);
  setTimeout(() => el.classList.add('fade-out'), fadeAt);
  setTimeout(() => el.remove(), duration);
}

// ── Modal yardımcıları ────────────────────────────────────────────────────────

/**
 * Verilen id'ye sahip modal'ı gizler.
 *
 * @param id - `document.getElementById` ile bulunacak modal öğesinin id'si.
 */
export function closeModal(id: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

/**
 * Kullanıcı modal'ın dışına tıkladığında modal'ı kapatır.
 * Genellikle modal backdrop öğesinin `onclick` handler'ına bağlanır.
 *
 * @param e  - Tıklama olayı.
 * @param id - Modal öğesinin id'si.
 */
export function closeModalOutside(e: MouseEvent, id: string): void {
  if ((e.target as HTMLElement)?.id === id) closeModal(id);
}
