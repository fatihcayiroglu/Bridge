// client/js/core/misc.js
// Bu dosya modüler bölme sonrası temiz bir koordinatör kabuğudur.
//
// Tüm işlevler ilgili modüllere taşınmıştır:
//   image-viewer.js    → openImageViewer, closeImageViewer, openFileArchive, scrollToMsg
//   unread.js          → incrementUnread, clearUnread, unreadCounts
//   music-player.js    → initMusicPlayer, showMusicPlayer, hideMusicPlayer, toggleMusicPause
//   socket-events.js   → bindSocketEvents, initStatusPicker, bridgeAppInterface
//   settings-modal.js  → openSettings, saveSettings, _loadAIStatusInSettings
//
// Yükleme sırası: index.html'de tüm modül script'leri misc.js'den ÖNCE yüklenmeli.
// Bu dosya sadece yükleme sağlığını loglar.

'use strict';

(function () {
  const EXPECTED_GLOBALS = [
    'openImageViewer',
    'initMusicPlayer',
    'bindSocketEvents',
    'openSettings',
    'incrementUnread',
  ];

  if (typeof window !== 'undefined') {
    window.addEventListener('DOMContentLoaded', () => {
      const missing = EXPECTED_GLOBALS.filter(g => typeof window[g] === 'undefined');
      if (missing.length) {
        console.warn('[Bridge misc] Eksik globals:', missing.join(', '),
          '— İlgili modül dosyalarının index.html\'de yüklendiğinden emin olun.');
      } else {
        console.log('[Bridge misc] Tüm modüller yüklendi ✓');
      }
    });
  }
})();

export const miscReady = true;
