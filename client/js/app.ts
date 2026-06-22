// client/js/app.ts — Uygulama giriş noktası (koordinatör)
// ─────────────────────────────────────────────────────────────────────────────
// Sprint 30: window.* global erişimleri kaldırıldı; socket/bindGroupDmSocketEvents import.
// Sprint 31: Boot katmanı ESM'e geçti. Yeni import'lar:
//   - errorBoundary → error-boundary.ts
//   - BridgeState   → state.ts
//   - loadTheme     → theme.ts
//   - getAPI        → globals.ts
//
// Yükleme sırası (scripts/build.js CHUNKS tanımına bakın):
//   chunk-boot     → error-boundary, utils, theme, i18n, state, globals, auth
//   chunk-core     → offline, servers, channel-list, messages,
//                    upload, members, socket, ui, settings, emoji
//   chunk-comms    → dm, dm-call, group-dm, voice, emoji-picker
//   chunk-webrtc   → noise-suppression, webrtc-sfu, webrtc, video
//   chunk-features → server-settings, discord-ui-kit, channel-perms,
//                    e2e, ai, search, friends, moderation, ...
//   chunk-pages    → app (bu dosya), federation, threads, slash, ...
//   chunk-heavy    → discord-import, bot-marketplace, admin
// ─────────────────────────────────────────────────────────────────────────────

import { socket }                   from './core/socket-svelte.ts';
import { bindGroupDmSocketEvents }   from './core/group-dm-core-svelte.ts';
import { errorBoundary }             from './core/error-boundary-svelte.ts';
import { BridgeState }               from './core/state-svelte.ts';
import { loadTheme }                 from './core/theme-svelte.ts';
import { getAPI }                    from './core/globals-svelte.ts';
import './core/auth-compat.ts';
import { BridgeRegistry }            from './core/bridge-registry.ts';
import { onNativePushLogin }         from './core/mobile-ux-svelte.ts';  // Sprint 98: native push entegrasyonu
import './core/empty-server-start-svelte.ts';

import { createLogger } from './core/logger.ts';
import { initA11yWcagAA } from './core/a11y-wcag-aa-svelte.ts'; // Sprint 108: WCAG AA başlatma
import { initDesktopUpdater } from './core/desktop-updater.ts'; // Desktop: Discord benzeri otomatik güncelleme UI
// Sprint 82: Yeni özellik modülleri
// import { initActivities }    from './core/activities/index.ts';
// import { initSuperReactions } from './core/super-reactions/index.ts';
// import { initClips }         from './core/clips/index.ts';
// import { initStickers }      from './core/stickers/index.ts';
import { initStageVideoGrid } from './core/stage-video-grid-svelte.ts'; // Sprint 83
import { applyBoostFeatures }  from './core/boost-svelte.ts';         // Sprint 92: feature gates
import './core/desktop-voice-bar-svelte.ts';                               // Sprint 92: desktop ses bar
import './core/boost-ui-svelte.ts';                                        // Sprint 93: Boost panel UI
import './core/spotify-widget-svelte.ts';                                  // Sprint 93: Spotify OAuth + now playing
import './core/e2ee-toggle-svelte.ts';                                     // Sprint 93: E2EE production toggle
import './core/analytics-dashboard-svelte.ts';                             // Sprint 94: Topluluk analitiği
import './core/announcement-ui-svelte.ts';                                 // Sprint 94: Announcement crosspost
import './core/settings-modal-voice-svelte.ts';                            // Sprint 92: ses ayarları UI
const log = createLogger('App');


// Group DM socket olaylarını socket hazır olunca bağla
document.addEventListener('bridge:socket-ready', () => {
  if (typeof bindGroupDmSocketEvents === 'function' && socket) {
    bindGroupDmSocketEvents(socket);
  }
});

// İlk girişte boş sunucu listesini kontrol et.
// bridge:auth-success event'i auth.ts tarafından login sonrası tetiklenir
document.addEventListener('bridge:auth-success', () => {
  // Kısa gecikme: app shell render ve oturum depolaması tamamlansın.
  setTimeout(() => {
    void BridgeRegistry.call('checkEmptyServerStart');
  }, 800);
  onNativePushLogin(); // Sprint 98: Capacitor ortamında push token'ı register et (IS_CAPACITOR guard içeriyor)
});

// Boot hatalarını yakala
errorBoundary.wrap(async () => {
  await loadTheme();
  BridgeState.initState();
  // Sprint 82: Yeni özellikler
  initStageVideoGrid(); // Sprint 83: Stage video grid
  initA11yWcagAA();     // Sprint 108: WCAG 2.1 AA — skip-link, landmark, reduced-motion
  initDesktopUpdater();  // Desktop: otomatik güncelleme durumu + yeniden başlatma akışı
  log.log(`[Bridge] Boot tamamlandı — API: ${getAPI()}`);
}, 'app:boot')();
