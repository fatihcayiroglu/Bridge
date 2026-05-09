// client/js/core/misc.js
// Bu dosya modÃ¼ler bÃ¶lme sonrasÄ± temiz bir koordinatÃ¶r kabuÄŸudur.
//
// TÃ¼m iÅŸlevler ilgili modÃ¼llere taÅŸÄ±nmÄ±ÅŸtÄ±r:
//   image-viewer.js    â†’ openImageViewer, closeImageViewer, openFileArchive, scrollToMsg
//   unread.js          â†’ incrementUnread, clearUnread, unreadCounts
//   music-player.js    â†’ initMusicPlayer, showMusicPlayer, hideMusicPlayer, toggleMusicPause
//   socket-events.js   â†’ bindSocketEvents, initStatusPicker, bridgeAppInterface
//   settings-modal.js  â†’ openSettings, saveSettings, _loadAIStatusInSettings
//
// YÃ¼kleme sÄ±rasÄ±: index.html'de tÃ¼m modÃ¼l script'leri misc.js'den Ã–NCE yÃ¼klenmeli.
// Bu dosya sadece yÃ¼kleme saÄŸlÄ±ÄŸÄ±nÄ± loglar.

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
          'â€” Ä°lgili modÃ¼l dosyalarÄ±nÄ±n index.html\'de yÃ¼klendiÄŸinden emin olun.');
      } else {
        console.log('[Bridge misc] TÃ¼m modÃ¼ller yÃ¼klendi âœ“');
      }
    });
  }
})();

