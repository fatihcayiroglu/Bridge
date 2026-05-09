// client/js/app.js — ESM Entry Point
// ─────────────────────────────────────────────────────────────
// esbuild bu dosyayı bundle eder. Tüm core modülleri buradan
// import edilir; chunk sistemi artık kullanılmıyor.
// ─────────────────────────────────────────────────────────────

// ── Boot ──────────────────────────────────────────────────────
import './core/error-boundary.js';
import './core/utils.js';
import './core/theme.js';
import './core/i18n.js';
import './core/state.js';
import './core/globals.js';
import './core/api-fetch.js';
import './core/auth.js';

// ── Core UI ───────────────────────────────────────────────────
import './core/offline-banner.js';
import './core/offline-queue.js';
import './core/offlineCache.js';
import './core/servers.js';
import './core/channel-list.js';
import './core/messages.js';
import './core/messages/loader.js';
import './core/messages/renderer.js';
import './core/messages/input.js';
import './core/messages/scroll.js';
import './core/messages/embeds.js';
import './core/messages/reactions.js';
import './core/messages/virtual-scroll.js';
import './core/upload.js';
import './core/members.js';
import './core/socket.js';
import './core/socket-events.js';
import './core/ui.js';
import './core/settings.js';
import './core/emoji.js';
import './core/unread.js';

// ── Communications ────────────────────────────────────────────
import './core/dm.js';
import './core/dm-read.js';
import './core/dm-call.js';
import './core/group-dm.js';
import './core/group-dm-core.js';
import './core/group-dm-voice.js';
import './core/voice.js';
import './core/voice-messages.js';
import './core/voice-recorder.js';
import './core/voice-activity-ui.js';
import './core/emoji-picker.js';

// ── WebRTC ────────────────────────────────────────────────────
import './webrtc-sfu.js';
import './webrtc.js';
import './core/noise-suppression.js';
import './core/video-quality.js';
import './core/channel-stage.js';

// ── Features ──────────────────────────────────────────────────
import './core/server-settings.js';
import './core/server-ui.js';
import './core/discord-ui-kit.js';
import './core/channel-permissions.js';
import './core/channel-perms-audit.js';
import './core/channel-perms-data.js';
import './core/channel-perms-inheritance.js';
import './core/channel-perms-matrix.js';
import './core/channel-perms-modal.js';
import './core/channel-perms-sync.js';
import './core/channel-perms/modal-audit.js';
import './core/channel-perms/modal-core.js';
import './core/channel-perms/modal-sync.js';
import './core/e2e.js';
import './core/ai.js';
import './core/search.js';
import './core/semantic.js';
import './core/semantic-search.js';
import './core/friends.js';
import './core/moderation.js';
import './core/automod-ui.js';
import './core/ip-ban.js';
import './core/analytics.js';
import './core/activity.js';
import './core/mention-autocomplete.js';
import './core/profile-ui.js';
import './core/image-viewer.js';
import './core/canvas.js';
import './core/music-player.js';
import './core/scheduled-ui.js';
import './core/mobile-ux.js';
import './core/onboarding-tour.js';
import './core/user-connections.js';
import './core/web-push.js';
import './core/partials.js';
import './core/misc.js';
import './core/clyde.js';
import './core/sentry-client.js';
import './core/settings-modal.js';
import './core/server-templates-admin.js';
import './core/translate-btn.js';

// ── Pages ─────────────────────────────────────────────────────
import './federation-ui.js';
import './federation-modal.js';
import './federation-integrations.js';
import './threads.js';
import './slash.js';
import './polls.js';
import './soundboard.js';
import './discover.js';
import './mobile.js';
import './profile.js';
import './twoFactor.js';
import './webauthn.js';
import './admin.js';

// ── Heavy / Optional ─────────────────────────────────────────
import './core/discord-import.js';
import './core/bot-marketplace.js';
import './marketplace.js';
import './plugin-marketplace-page.js';

// ── v4x Compat Shims ─────────────────────────────────────────
// Bu modüller monkey-patch mimarisini korur; ESM bundlelarla
// birlikte çalışabilmeleri için burada import edilirler.
import './core/v41/go-live.js';
import './core/v41/onboarding.js';
import './core/v41/outgoing-webhooks.js';
import './core/v42/forum.js';
import './core/v42/stage.js';
import './core/v42/calendar-picker.js';
import './core/v42/automod.js';
import './core/v42/mobile.js';
import './core/v43/virtual-scroll.js';
import './core/v43/skeleton-loading.js';
import './core/v43/search-highlight.js';
import './core/v43/drafts.js';
import './core/v43/themes.js';
import './core/v43/ai-streaming.js';
import './core/v43/auth-revoked.js';
import './core/v44/voice-volume.js';
import './core/v44/advanced-search.js';
import './core/v44/slow-mode.js';
import './core/v44/audit-log.js';
import './core/v44/boost.js';
import './core/v44/styles.js';

// ── Group DM socket bağlama ───────────────────────────────────
import { getSocket } from './core/globals.js';

document.addEventListener('bridge:socket-ready', () => {
  // group-dm-core socket binding handled internally via bridge:socket-ready event
});
