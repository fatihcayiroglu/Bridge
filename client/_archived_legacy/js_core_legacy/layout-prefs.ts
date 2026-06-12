// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/LayoutPrefsPanel.svelte
//              client/js/core/layout-prefs-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
/**
 * Bridge layout modu — Discord üç sütunundan görsel ayrışma.
 * classic | focus | compact
 */

export type BridgeLayoutMode = 'classic' | 'focus' | 'compact';

const STORAGE_KEY = 'bridgeLayout';
const VALID: BridgeLayoutMode[] = ['classic', 'focus', 'compact'];

export function getLayoutMode(): BridgeLayoutMode {
  try {
    const v = localStorage.getItem(STORAGE_KEY) as BridgeLayoutMode | null;
    if (v && VALID.includes(v)) return v;
  } catch { /* private mode */ }
  return 'classic';
}

export function setLayoutMode(mode: BridgeLayoutMode): void {
  if (!VALID.includes(mode)) return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch { /* ignore */ }
  applyLayoutMode(mode);
}

export function applyLayoutMode(mode?: BridgeLayoutMode): void {
  const m = mode ?? getLayoutMode();
  if (m === 'classic') {
    document.body.removeAttribute('data-layout');
  } else {
    document.body.setAttribute('data-layout', m);
  }
}

export function initLayoutPrefs(): void {
  applyLayoutMode();
}
