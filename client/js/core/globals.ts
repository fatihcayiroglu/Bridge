// core/globals.ts
// ─────────────────────────────────────────────────────────────────────────────
// Uygulama genelinde paylaşılan global değişkenler ve
// klavye kısayolları.
//
// Yükleme sırası: chunk-boot içinde error-boundary → utils →
//   theme → i18n → state → globals → api (auth) → auth
//
// YENİ KOD: window.* yerine BridgeState.setState() kullanın.
// Bu dosya geriye dönük uyumluluk için mevcuttur.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';

declare global {
  interface Window {
    BRIDGE_API?: string;
    _emojiMap?: Map<string, unknown> | null;
    _bridgeGlobals?: {
      socket: unknown;
      rtc: unknown;
      me: unknown;
      token: string | null;
      refreshToken: string | null;
      currentServer: unknown;
      currentChannel: unknown;
    };
  }
  // Functions declared globally for backward compat
  function escHtml(s: unknown): string;
  function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
  function closeDmPanel(): void;
  function cancelEdit(): void;
  function cancelReply(): void;
  function toggleMemberList(): void;
}

// ── API base URL ──────────────────────────────────────────────────────────────
const API = window.BRIDGE_API || 'http://localhost:3001';

// ── Uygulama durumu ───────────────────────────────────────────────────────────
let socket:       unknown = null;
let rtc:          unknown = null;
let me:           unknown = null;
let token:        string | null = null;
let refreshToken: string | null = null;

let currentServer:  unknown = null;
let currentChannel: unknown = null;

let typingTimer:       ReturnType<typeof setTimeout> | null = null;
let typingUsers:       Map<string, ReturnType<typeof setTimeout>> = new Map();
let memberListVisible  = true;
let voiceChannelPeers: Map<string, unknown> = new Map();
let serverEmojiCache:  Array<{ _id: string; name: string; url: string; serverId: string }> = [];

// ── UI durumu ─────────────────────────────────────────────────────────────────
let localVideoEl:       HTMLVideoElement | null = null;
let editingMessageId:   string | null = null;
let unreadMentions      = 0;

const _savedCollapsed = (() => {
  try { return JSON.parse(localStorage.getItem('bridge_collapsed_cats') || '[]') as string[]; } catch { return [] as string[]; }
})();
let collapsedCategories = new Set<string>(_savedCollapsed);

function _persistCollapsedCategories(): void {
  try { localStorage.setItem('bridge_collapsed_cats', JSON.stringify([...collapsedCategories])); } catch { /**/ }
}

let pinnedPanelOpen = false;
let replyingTo:     unknown = null;

// ── İstemci yapılandırması ────────────────────────────────────────────────────
let clientConfig = {
  maxFileSizeMB:    2048,
  chunkSizeMB:      5,
  tenorEnabled:     false,
  translateEnabled: false,
};

// ── Sunucu emoji yardımcıları ─────────────────────────────────────────────────

function loadServerEmojis(serverId: string): void {
  if (!serverId) return;
  apiFetch(`${API}/api/servers/${serverId}/emojis/all`)
    .then(r => r.json())
    .then((emojis: typeof serverEmojiCache) => { serverEmojiCache = emojis || []; window._emojiMap = null; })
    .catch(() => {
      apiFetch(`${API}/api/servers/${serverId}/emojis`)
        .then(r => r.json())
        .then((emojis: typeof serverEmojiCache) => { serverEmojiCache = emojis || []; window._emojiMap = null; })
        .catch(() => { /**/ });
    });
}

function applyServerEmojis(text: string): string {
  if (!serverEmojiCache.length || !text) return escHtml(text);
  let result = escHtml(text);
  for (const emoji of serverEmojiCache) {
    const re       = new RegExp(`:${emoji.name}:`, 'g');
    const safeUrl  = encodeURI(API + emoji.url);
    const safeName = emoji.name.replace(/[&<>"']/g,
      (c: string) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
    result = result.replace(re,
      `<img src="${safeUrl}" alt=":${safeName}:" title=":${safeName}:" class="server-emoji" ` +
      `style="width:22px;height:22px;vertical-align:middle;display:inline-block;border-radius:3px;">`
    );
  }
  return result;
}

// ── Klavye kısayolları ────────────────────────────────────────────────────────

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Tab') {
    const openModal = [...document.querySelectorAll<HTMLElement>('.modal-overlay')]
      .find(el => getComputedStyle(el).display !== 'none');
    if (openModal) {
      const focusable = openModal.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), ' +
        'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length) {
        const first = focusable[0] as HTMLElement | undefined;
        const last  = focusable[focusable.length - 1] as HTMLElement | undefined;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first?.focus();
        }
      }
    }
  }

  if (e.key === 'Escape') {
    const modals = [
      'settings-modal', 'addserver-modal', 'invite-modal',
      'file-archive-modal', 'schedule-modal', 'bridge-modal', 'server-gif-modal',
    ];
    for (const id of modals) {
      const el = document.getElementById(id);
      if (el && (el as HTMLElement).style.display !== 'none') { closeModal(id); return; }
    }
    const dmPanel = document.getElementById('dm-panel');
    if (dmPanel && (dmPanel as HTMLElement).style.display !== 'none') {
      closeDmPanel(); return;
    }
    if (editingMessageId) { cancelEdit(); return; }
    if (replyingTo)       { cancelReply(); return; }
    const ep = document.getElementById('emoji-picker');
    if (ep && (ep as HTMLElement).style.display !== 'none') { (ep as HTMLElement).style.display = 'none'; return; }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const sw = document.getElementById('search-wrap');
    if (sw) {
      const swEl = sw as HTMLElement;
      swEl.style.display = swEl.style.display === 'none' ? 'flex' : 'none';
      if (swEl.style.display !== 'none') (document.getElementById('search-input') as HTMLElement | null)?.focus();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
    e.preventDefault(); toggleMemberList(); return;
  }

  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    const items = [...document.querySelectorAll<HTMLElement>('.ch-item')];
    if (!items.length) return;
    const idx  = items.findIndex(el => el.classList.contains('active'));
    const next = e.key === 'ArrowDown'
      ? items[Math.min(idx + 1, items.length - 1)]
      : items[Math.max(idx - 1, 0)];
    if (next) next.click();
    return;
  }
});

// closeModal comes from utils.ts (globally declared)
export { API, serverEmojiCache, loadServerEmojis, applyServerEmojis, clientConfig,
         socket, rtc, me, token, refreshToken, currentServer, currentChannel,
         typingTimer, typingUsers, memberListVisible, voiceChannelPeers,
         localVideoEl, editingMessageId, unreadMentions, collapsedCategories,
         _persistCollapsedCategories, pinnedPanelOpen, replyingTo };
