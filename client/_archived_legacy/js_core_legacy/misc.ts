// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MiscPanel.svelte
//              client/js/core/misc-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//

import { createLogger } from './logger.js';
const log = createLogger('Misc');

// client/js/core/misc.ts
// Sprint 43: JS→TS geçişi
// Koordinatör kabuğu — tüm işlevler modüllere taşınmış

// Sprint 57: 'openSettings' kaldırıldı — artık BridgeRegistry.call('openSettingsModal') kullanılır
const EXPECTED_GLOBALS = [
  'openImageViewer',
  'initMusicPlayer',
  'bindSocketEvents',
  'incrementUnread',
] as const;

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    import('./layout-prefs.js').then(({ initLayoutPrefs }) => initLayoutPrefs()).catch(() => {});
    const missing = EXPECTED_GLOBALS.filter(
      g => typeof (window as Record<string, unknown>)[g] === 'undefined'
    );
    if (missing.length) {
      log.warn('[Bridge misc] Eksik globals:', missing.join(', '));
    }
  });
}

export const miscReady = true as const;
