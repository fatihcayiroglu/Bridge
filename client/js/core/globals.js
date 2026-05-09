// core/globals.js
// ─────────────────────────────────────────────────────────────
// Uygulama genelinde paylaşılan global değişkenler ve
// klavye kısayolları.
//
// Yükleme sırası: error-boundary → utils →
//   theme → i18n → state → globals → api (auth) → auth
//
// YENİ KOD: window.* yerine BridgeState.setState() kullanın.
// Bu dosya geriye dönük uyumluluk için mevcuttur.
// ─────────────────────────────────────────────────────────────

'use strict';

// ── API base URL ──────────────────────────────────────────────
// Sunucu tarafından window.BRIDGE_API enjekte edilebilir,
// aksi takdirde localhost:3001 kullanılır.
const API = window.BRIDGE_API || 'http://localhost:3001';

// ── Uygulama durumu ───────────────────────────────────────────
let socket       = null;   // Socket.io instance
let rtc          = null;   // BridgeRTC instance
let me           = null;   // Mevcut kullanıcı (alias: currentUser)

let currentServer  = null; // { _id, name, icon, ... }
let currentChannel = null; // { _id, name, type, ... }

let typingTimer       = null;
let typingUsers       = new Map(); // userId → timer
let memberListVisible = true;
let voiceChannelPeers = new Map();
let serverEmojiCache  = [];        // [{ _id, name, url, serverId }]

// ── UI durumu ─────────────────────────────────────────────────
let localVideoEl       = null;
let editingMessageId   = null;
let unreadMentions     = 0;
// collapsedCategories — localStorage ile kalıcı (sayfa yenilenince sıfırlanmaz)
const _savedCollapsed = (() => {
  try { return JSON.parse(localStorage.getItem('bridge_collapsed_cats') || '[]'); } catch { return []; }
})();
let collapsedCategories = new Set(_savedCollapsed);
function _persistCollapsedCategories() {
  try { localStorage.setItem('bridge_collapsed_cats', JSON.stringify([...collapsedCategories])); } catch {}
}
let pinnedPanelOpen    = false;
let replyingTo         = null;

// ── İstemci yapılandırması ────────────────────────────────────
// loadClientConfig() (auth.js) ile sunucudan güncellenir.
let clientConfig = {
  maxFileSizeMB:    2048,
  chunkSizeMB:      5,
  tenorEnabled:     false,
  translateEnabled: false,
};

// ── Sunucu emoji yardımcıları ─────────────────────────────────

/**
 * Aktif sunucunun (ve üye olunan tüm sunucuların) özel
 * emojilerini serverEmojiCache'e yükler.
 * @param {string} serverId
 */
function loadServerEmojis(serverId) {
  if (!serverId) return;
  apiFetch(`${API}/api/servers/${serverId}/emojis/all`)
    .then(r => r.json())
    .then(emojis => { serverEmojiCache = emojis || []; window._emojiMap = null; })
    .catch(() => {
      // Fallback: sadece mevcut sunucunun emojileri
      apiFetch(`${API}/api/servers/${serverId}/emojis`)
        .then(r => r.json())
        .then(emojis => { serverEmojiCache = emojis || []; window._emojiMap = null; })
        .catch(() => {});
    });
}

/**
 * Ham metindeki :emoji_adı: kısayollarını <img> etiketleriyle değiştirir.
 * @param {string} text - Ham (HTML-encode edilmemiş) metin
 * @returns {string} - HTML çıktısı
 */
function applyServerEmojis(text) {
  if (!serverEmojiCache.length || !text) return escHtml(text);
  let result = escHtml(text);
  for (const emoji of serverEmojiCache) {
    const re       = new RegExp(`:${emoji.name}:`, 'g');
    const safeUrl  = encodeURI(API + emoji.url);
    const safeName = emoji.name.replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    result = result.replace(re,
      `<img src="${safeUrl}" alt=":${safeName}:" title=":${safeName}:" class="server-emoji" ` +
      `style="width:22px;height:22px;vertical-align:middle;display:inline-block;border-radius:3px;">`
    );
  }
  return result;
}

// ── Klavye kısayolları ────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  // Tab tuzağı — açık modal içinde focus döngüsü
  if (e.key === 'Tab') {
    const openModal = [...document.querySelectorAll('.modal-overlay')]
      .find(el => getComputedStyle(el).display !== 'none');
    if (openModal) {
      const focusable = openModal.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length) {
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }
  }

  // Escape — modal / panel / edit / reply kapat
  if (e.key === 'Escape') {
    const modals = [
      'settings-modal', 'addserver-modal', 'invite-modal',
      'file-archive-modal', 'schedule-modal', 'bridge-modal', 'server-gif-modal',
    ];
    for (const id of modals) {
      const el = document.getElementById(id);
      if (el && el.style.display !== 'none') { closeModal(id); return; }
    }
    if (document.getElementById('dm-panel')?.style.display !== 'none') {
      closeDmPanel(); return;
    }
    if (editingMessageId) { cancelEdit(); return; }
    if (replyingTo)       { cancelReply(); return; }
    const ep = document.getElementById('emoji-picker');
    if (ep && ep.style.display !== 'none') { ep.style.display = 'none'; return; }
  }

  // Ctrl/Cmd+K — arama aç/kapat
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const sw = document.getElementById('search-wrap');
    if (sw) {
      sw.style.display = sw.style.display === 'none' ? 'flex' : 'none';
      if (sw.style.display !== 'none') document.getElementById('search-input')?.focus();
    }
    return;
  }

  // Ctrl/Cmd+Shift+M — üye listesi aç/kapat
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
    e.preventDefault(); toggleMemberList(); return;
  }

  // Alt+↑/↓ — kanal gezinme
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const items = [...document.querySelectorAll('.ch-item')];
    if (!items.length) return;
    const idx  = items.findIndex(el => el.classList.contains('active'));
    const next = e.key === 'ArrowDown'
      ? items[Math.min(idx + 1, items.length - 1)]
      : items[Math.max(idx - 1, 0)];
    if (next) next.click();
    return;
  }
});

// Getter'lar — her okumada güncel değeri döner
export const getAPI            = () => API;
export const getSocket         = () => socket;
export const getRtc            = () => rtc;
export const getMe             = () => me;
export const getCurrentServer  = () => currentServer;
export const getCurrentChannel = () => currentChannel;
export const getClientConfig   = () => clientConfig;
export const getServerEmojiCache = () => serverEmojiCache;

// Yardımcı fonksiyonlar — doğrudan export edilebilir
export {
  loadServerEmojis,
  applyServerEmojis,
  _persistCollapsedCategories,
};

