// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MobilePanel.svelte
//              client/js/core/mobile-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/mobile.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Mobil swipe iyileştirme + bottom nav düzeltmeleri

/** Mobil breakpoint (px) */
const PHONE = 480;

/** Ekran mobil genişlikte mi? */
const isMobile = (): boolean => window.innerWidth <= PHONE;

/**
 * Kısa titreşim geri bildirimi verir.
 * @param ms - Titreşim süresi (ms)
 */
function haptic(ms = 10): void {
  try { window.navigator?.vibrate?.(ms); } catch { /* ignore */ }
}

// ── Swipe state ───────────────────────────────────────────────

let _swTouchX = 0;
let _swTouchY = 0;
let _swipeDir: 'horizontal' | 'vertical' | null = null;
let _swipeOverlay: HTMLDivElement | null = null;

/** Swipe overlay elementini döndürür; yoksa oluşturur. */
function _getSwipeOverlay(): HTMLDivElement {
  if (_swipeOverlay) return _swipeOverlay;
  const el = document.createElement('div');
  el.id = 'swipe-overlay';
  el.style.cssText = `
    position:fixed;top:0;left:0;width:100%;height:100%;
    z-index:9999;pointer-events:none;transition:opacity .2s;
    background:rgba(0,0,0,.18);opacity:0;
  `;
  document.body.appendChild(el);
  _swipeOverlay = el as HTMLDivElement;
  return _swipeOverlay;
}

// ── Swipe handlers ────────────────────────────────────────────

function _onTouchStart(e: TouchEvent): void {
  if (!isMobile()) return;
  _swTouchX = e.touches[0].clientX;
  _swTouchY = e.touches[0].clientY;
  _swipeDir = null;
}

function _onTouchMove(e: TouchEvent): void {
  if (!isMobile()) return;
  const dx = e.touches[0].clientX - _swTouchX;
  const dy = e.touches[0].clientY - _swTouchY;

  if (!_swipeDir) {
    if (Math.abs(dx) > Math.abs(dy) + 5) _swipeDir = 'horizontal';
    else if (Math.abs(dy) > Math.abs(dx) + 5) _swipeDir = 'vertical';
    else return;
  }

  if (_swipeDir !== 'horizontal') return;

  const sidebar  = document.getElementById('sidebar');
  const rightPanel = document.getElementById('member-list');

  // Sola swipe → sidebar'ı kapat, sağ paneli aç
  if (dx < -40 && sidebar?.classList.contains('mobile-open')) {
    sidebar.classList.remove('mobile-open');
    _getSwipeOverlay().style.opacity = '0';
    haptic();
  }

  // Sağa swipe → sidebar'ı aç
  if (dx > 40 && !sidebar?.classList.contains('mobile-open') && _swTouchX < 30) {
    sidebar?.classList.add('mobile-open');
    _getSwipeOverlay().style.opacity = '1';
    haptic();
  }

  // Sol'dan sağa swipe → sağ paneli kapat
  if (dx < -40 && rightPanel?.classList.contains('mobile-open')) {
    rightPanel.classList.remove('mobile-open');
    haptic();
  }
}

function _onTouchEnd(): void {
  _swipeDir = null;
  _getSwipeOverlay().style.opacity = '0';
}

// ── Bottom nav aktif tab yönetimi ─────────────────────────────

function _syncBottomNav(): void {
  const items = document.querySelectorAll<HTMLElement>('.bottom-nav-item');
  const current = window.location.hash || '#home';
  items.forEach(item => {
    item.classList.toggle('active', item.dataset.tab === current);
  });
}

// ── Init ──────────────────────────────────────────────────────

function init(): void {
  if (!isMobile()) return;

  document.addEventListener('touchstart', _onTouchStart, { passive: true });
  document.addEventListener('touchmove',  _onTouchMove,  { passive: true });
  document.addEventListener('touchend',   _onTouchEnd,   { passive: true });

  // Overlay tıklanınca sidebar'ı kapat
  _getSwipeOverlay().addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.remove('mobile-open');
    _getSwipeOverlay().style.opacity = '0';
  });
  _getSwipeOverlay().style.pointerEvents = 'auto';

  // Bottom nav sync
  window.addEventListener('hashchange', _syncBottomNav);
  _syncBottomNav();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

export { init, isMobile, haptic };
