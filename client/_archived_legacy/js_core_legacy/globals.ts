// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/GlobalsPanel.svelte
//              client/js/core/globals-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/globals.ts
// Uygulama genelinde paylaşılan global değişkenler ve klavye kısayolları.
//
// Sprint 31: window._bridgeGlobals köprüsü kaldırıldı.
//            Tüm değişkenler ESM export — import { socket } from './globals.js'
//            window.BRIDGE_API → getAPI() helper ile erişilir.
//
// Sprint 41: User arayüzü eklendi. getMe() artık User | null döner.
//            activity.ts'teki (getMe() as any) castleri kaldırıldı.
//
// YENİ KOD: window.* yerine import + BridgeState.setState() kullanın.
// Bu dosya yükleme sırasında chunk-boot içinde ilk çalışır.

'use strict';

// ── Uygulama Tipleri ───────────────────────────────────────────────────────────

/** Giriş yapmış kullanıcı nesnesi. */
export interface User {
  _id: string;
  id?: string; // bazı response'larda _id yerine id gelir — geriye-dönük uyumluluk
  username: string;
  displayName?: string;
  email?: string;
  avatar?: string;
  avatarColor?: string;
  statusText?:  string;
  statusEmoji?: string;
  status?: 'online' | 'offline' | 'idle' | 'dnd';
  activity?: {
    type: string;
    name?: string;
    detail?: string;
  } | null;
  tokenVersion?: number;
  roles?: string[];
  /** Herhangi bir sunucudaki üyelik verileri vs. ek alanlar */
  [key: string]: unknown;
}

/** Kanal nesnesi (text, voice, stage). */
export interface Channel {
  _id: string;
  name: string;
  type?: 'text' | 'voice' | 'stage' | string;
  topic?: string;
  serverId?: string;
  [key: string]: unknown;
}

/** Sunucu nesnesi. */
export interface Server {
  _id: string;
  name: string;
  icon?: string;
  ownerId?: string;
  [key: string]: unknown;
}

// ── API base URL ───────────────────────────────────────────────────────────────
const _API = (typeof window !== 'undefined' ? (window as { BRIDGE_API?: string }).BRIDGE_API : undefined)
  || 'http://localhost:3001';

/** Uygulama genelinde API base URL'yi döner. window.API yerine bunu kullanın. */
export function getAPI(): string { return _API; }


// ── Uygulama durumu ────────────────────────────────────────────────────────────
export let socket:       unknown = null;
export let rtc:          unknown = null;
export let me:           User | null = null;
export let token:        string | null = null;
export let refreshToken: string | null = null;

export let currentServer:  Server | null = null;
export let currentChannel: Channel | null = null;

export let typingTimer:       ReturnType<typeof setTimeout> | null = null;
export let typingUsers:       Map<string, ReturnType<typeof setTimeout>> = new Map();
export let memberListVisible  = true;
export let voiceChannelPeers: Map<string, unknown> = new Map();
export let serverEmojiCache:  Array<{ _id: string; name: string; url: string; serverId: string }> = [];

// ── Setter yardımcıları ────────────────────────────────────────────────────────
// ESM'de `export let` re-assign edilemiyor — setter fonksiyonları kullan.
// Sprint 32'de tüketici modüller bu setter'lara geçer.
export function setSocket(v: unknown):       void { socket = v; }
export function setRtc(v: unknown):          void { rtc = v; }
export function setMe(v: User | null):       void { me = v; }
export function setToken(v: string | null):  void { token = v; }
export function setRefreshToken(v: string | null): void { refreshToken = v; }
export function setCurrentServer(v: Server | null):  void { currentServer = v; }
export function setCurrentChannel(v: Channel | null): void { currentChannel = v; }
export function setMemberListVisible(v: boolean): void { memberListVisible = v; }
export function setTypingTimer(v: ReturnType<typeof setTimeout> | null): void { typingTimer = v; }

// ── UI durumu ──────────────────────────────────────────────────────────────────
export let localVideoEl:       HTMLVideoElement | null = null;
export let editingMessageId:   string | null = null;
export let unreadMentions      = 0;

export function setLocalVideoEl(v: HTMLVideoElement | null): void { localVideoEl = v; }
export function setEditingMessageId(v: string | null): void { editingMessageId = v; }
export function setUnreadMentions(v: number): void { unreadMentions = v; }

const _savedCollapsed = (() => {
  try { return JSON.parse(localStorage.getItem('bridge_collapsed_cats') || '[]') as string[]; } catch { return [] as string[]; }
})();
export let collapsedCategories = new Set<string>(_savedCollapsed);

export function _persistCollapsedCategories(): void {
  try { localStorage.setItem('bridge_collapsed_cats', JSON.stringify([...collapsedCategories])); } catch { /**/ }
}

export let pinnedPanelOpen = false;
export let replyingTo:     unknown = null;

export function setPinnedPanelOpen(v: boolean): void { pinnedPanelOpen = v; }
export function setReplyingTo(v: unknown): void { replyingTo = v; }

// ── İstemci yapılandırması ────────────────────────────────────────────────────
export let clientConfig = {
  maxFileSizeMB:    5120,
  chunkSizeMB:      5,
  tenorEnabled:     false,
  translateEnabled: false,
};

export function setClientConfig(patch: Partial<typeof clientConfig>): void {
  clientConfig = { ...clientConfig, ...patch };
}

// ── Sunucu emoji yardımcıları ─────────────────────────────────────────────────
export function loadServerEmojis(serverId: string): void {
  if (!serverId) return;
  const api = getAPI();
  fetch(`${api}/api/servers/${serverId}/emojis/all`)
    .then(r => r.json())
    .then((emojis: typeof serverEmojiCache) => { serverEmojiCache = emojis || []; _emojiMap = null; })
    .catch(() => {
      fetch(`${api}/api/servers/${serverId}/emojis`)
        .then(r => r.json())
        .then((emojis: typeof serverEmojiCache) => { serverEmojiCache = emojis || []; _emojiMap = null; })
        .catch(() => { /**/ });
    });
}

// _emojiMap: iç önbellek, applyServerEmojis tarafından kullanılır
let _emojiMap: Map<string, unknown> | null = null;
export function getEmojiMap(): Map<string, unknown> | null { return _emojiMap; }
export function getServerEmojiCache(): typeof serverEmojiCache { return serverEmojiCache; }

export function applyServerEmojis(text: string): string {
  if (!serverEmojiCache.length || !text) return escHtml(text);
  let result = escHtml(text);
  const api = getAPI();
  for (const emoji of serverEmojiCache) {
    const re       = new RegExp(`:${emoji.name}:`, 'g');
    const safeUrl  = encodeURI(api + emoji.url);
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
// Bunlar globals modülü yüklendiğinde bağlanır (chunk-boot).
// closeModal, closeDmPanel, cancelEdit, cancelReply, toggleMemberList
// Sprint 32'de import ile gelecek; şimdilik global scope'tan okunuyor (geçiş şimi).

import { escHtml, closeModal } from './utils.js';

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
      if (el && el.style.display !== 'none') { closeModal(id); return; }
    }
    const dmPanel = document.getElementById('dm-panel');
    if (dmPanel && dmPanel.style.display !== 'none') {
      // Sprint 32: import { closeDmPanel } from './dm.js'
      (window as unknown as Record<string, unknown>).closeDmPanel?.();
      return;
    }
    if (editingMessageId) {
      // Sprint 32: import { cancelEdit } from './messages.js'
      (window as unknown as Record<string, unknown>).cancelEdit?.();
      return;
    }
    if (replyingTo) {
      // Sprint 32: import { cancelReply } from './messages.js'
      (window as unknown as Record<string, unknown>).cancelReply?.();
      return;
    }
    const ep = document.getElementById('emoji-picker');
    if (ep && ep.style.display !== 'none') { ep.style.display = 'none'; return; }
  }

  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const sw = document.getElementById('search-wrap');
    if (sw) {
      sw.style.display = sw.style.display === 'none' ? 'flex' : 'none';
      if (sw.style.display !== 'none') document.getElementById('search-input')?.focus();
    }
    return;
  }

  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'M') {
    e.preventDefault();
    // Sprint 32: import { toggleMemberList } from './members.js'
    (window as unknown as Record<string, unknown>).toggleMemberList?.();
    return;
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

// ── Getter'lar (Sprint 32) ────────────────────────────────────────────────────
// socket.js / servers.js / channel-list.ts / dm.ts etc. artık bunları kullanır.
export function getSocket():         unknown { return socket; }
export function getRtc():            unknown { return rtc; }
export function getMe():             User | null { return me; }
export function getCurrentChannel(): Channel | null { return currentChannel; }
export function getCurrentServer():  Server | null { return currentServer; }

// ── Sprint 33 FIX: BridgeRegistry kayıtları ──────────────────────────────────
// threads.ts ve diğer IIFE modülleri BridgeRegistry.call() ile bu değerlere erişir.
// globals.ts chunk-boot içinde ilk yüklendiği için kayıt burada güvenli.
import { BridgeRegistry } from './bridge-registry.js';

// getCurrentUser — me nesnesinin tamamı (displayName, avatarColor, id vs.)
BridgeRegistry.register('getCurrentUser', () => me);

// getCurrentUserId — sadece ID string'i
BridgeRegistry.register('getCurrentUserId', () => me?._id ?? me?.id ?? null);

// getCurrentChannel — aktif kanal nesnesi
BridgeRegistry.register('getCurrentChannel', () => currentChannel);

// getMe — getCurrentUser ile aynı, geriye-dönük uyumluluk için
BridgeRegistry.register('getMe', () => me);

// getCurrentServer — aktif sunucu nesnesi (slash.ts vb. için)
BridgeRegistry.register('getCurrentServer', () => currentServer);

// getCurrentMember — aktif sunucudaki kullanıcının üyelik nesnesi
// currentServerMembers'dan me._id ile bulunur
BridgeRegistry.register('getCurrentMember', () => {
  const myId = me?._id ?? me?.id;
  if (!myId) return null;
  return currentServerMembers.find(
    (m: Record<string, unknown>) => m.userId === myId || m._id === myId
  ) ?? null;
});

// setMeField — me nesnesindeki bir alanı günceller (slash /nick vb. için)
BridgeRegistry.register('setMeField', (field: string, value: unknown) => {
  if (me && field) (me as Record<string, unknown>)[field] = value;
});
export function getClientConfig():   typeof clientConfig { return clientConfig; }
export function getEditingMessageId(): string | null { return editingMessageId; }
export function getReplyingTo():     unknown { return replyingTo; }
export function getTypingUsers():    Map<string, ReturnType<typeof setTimeout>> { return typingUsers; }
export function getUnreadMentions(): number { return unreadMentions; }
export function getVoiceChannelPeers(): Map<string, unknown> { return voiceChannelPeers; }
export function getNsfwAccepted():   Set<string> {
  // currentServerChannels ve _nsfwAccepted için geçiş yardımcısı
  return (window as unknown as Record<string, unknown>)._nsfwAccepted as Set<string> || new Set();
}

// ── Sunucu kanal önbelleği (Sprint 32) ────────────────────────────────────────
export let currentServerChannels: Array<Record<string, unknown>> = [];
export let currentServerMembers:  Array<Record<string, unknown>> = [];
export function setCurrentServerChannels(v: Array<Record<string, unknown>>): void {
  currentServerChannels = v;
  // window.currentServerChannels köprüsü — channel-list.test.ts tüketicisi var; Sprint 81+ hedefi
  (window as unknown as Record<string, unknown>).currentServerChannels = v;
}
export function setCurrentServerMembers(v: Array<Record<string, unknown>>): void {
  currentServerMembers = v;
  (window as unknown as Record<string, unknown>).currentServerMembers = v;
}

// ── _nsfwAccepted — module-level Set (Sprint 32) ───────────────────────────
export const _nsfwAccepted = new Set<string>(
  (() => { try { return JSON.parse(localStorage.getItem('bridge_nsfw_accepted') || '[]') as string[]; } catch { return []; } })()
);
export function addNsfwAccepted(channelId: string): void {
  _nsfwAccepted.add(channelId);
  // window._nsfwAccepted köprüsü — Sprint 81+ hedefi
  ((window as unknown as Record<string, unknown>)._nsfwAccepted as Set<string>)?.add(channelId);
}

// ── _contextCommands (Sprint 32) ────────────────────────────────────────────
export let contextCommands: unknown[] = [];
export function setContextCommands(v: unknown[]): void {
  contextCommands = v;
  (window as unknown as Record<string, unknown>)._contextCommands = v;
}

// ── _friendsCache (Sprint 32) ────────────────────────────────────────────────
export let friendsCache: unknown[] = [];
export function setFriendsCache(v: unknown[]): void {
  friendsCache = v;
  (window as unknown as Record<string, unknown>)._friendsCache = v;
}

// ── _currentDmUserId (Sprint 32) ─────────────────────────────────────────────
export let currentDmUserId: string | null = null;
export function setCurrentDmUserId(v: string | null): void {
  currentDmUserId = v;
  (window as unknown as Record<string, unknown>)._currentDmUserId = v;
}

// ── _blockedUserIds (Sprint 32) ──────────────────────────────────────────────
export const blockedUserIds = new Set<string>();
export function addBlockedUserId(id: string): void {
  blockedUserIds.add(id);
  ((window as unknown as Record<string, unknown>)._blockedUserIds as Set<string>)?.add(id);
}
export function initBlockedUserIds(): void {
  (window as unknown as Record<string, unknown>)._blockedUserIds = blockedUserIds;
}
