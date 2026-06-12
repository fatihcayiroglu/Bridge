// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/LoaderPanel.svelte
//              client/js/core/loader-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/messages/loader.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Mesaj yükleme — cursor-based pagination + offline cache

import { getAPI, getCurrentChannel } from '../globals.js';
import { BridgeRegistry }            from '../bridge-registry.js';
import { apiFetch }                  from '../api-fetch.js';
import { escHtml }                   from '../utils.js';
import { renderMessage }             from './renderer.js';
import { scrollToBottom }            from './scroll.js';

// ── Shared scroll state (scroll.ts ile paylaşılan) ───────────
export const _scrollState = {
  noMoreMessages:        false,
  oldestMessageTimestamp: null as number | string | null,
  loadingMoreMessages:   false,
};

// ── Tip tanımları ─────────────────────────────────────────────

interface Message {
  _id: string;
  userId: string;
  createdAt: number | string;
  content?: string;
}

interface MessagesResponse {
  messages?: Message[];
  prevCursor?: string | null;
  nextCursor?: string | null;
  hasMore?: boolean;
}

interface OfflineCache {
  setChannelMessages?(channelId: string, messages: Message[]): Promise<void>;
  getChannelMessages?(channelId: string): Promise<Message[]>;
}

// ── Cursor state ──────────────────────────────────────────────

export let _prevCursor: string | null = null;
export let _nextCursor: string | null = null;

// ── Mesaj alanı önbelleği ─────────────────────────────────────

let _msgAreaCache: HTMLElement | null = null;

function _getMsgArea(): HTMLElement | null {
  if (!_msgAreaCache?.isConnected) {
    _msgAreaCache = document.getElementById('messages-area');
  }
  return _msgAreaCache;
}

// ── loadMessages ──────────────────────────────────────────────

export async function loadMessages(channelId: string): Promise<void> {
  _scrollState.noMoreMessages = false;
  _scrollState.oldestMessageTimestamp = null;

  const area = _getMsgArea();
  if (area) area.innerHTML = '';

  let messages: Message[] = [];
  let loadedFromCache = false;

  try {
    const r = await apiFetch(`${getAPI()}/api/channels/${channelId}/messages?limit=50`);
    const data = await r.json() as MessagesResponse | Message[];

    if (data && !Array.isArray(data) && Array.isArray(data.messages)) {
      messages       = data.messages;
      _prevCursor    = data.prevCursor ?? null;
      _nextCursor    = data.nextCursor ?? null;
      _scrollState.noMoreMessages = !data.hasMore;
    } else if (Array.isArray(data)) {
      messages = data as Message[];
    }

    if (Array.isArray(messages)) {
      const offlineCache = BridgeRegistry.get('bridgeOfflineCache') as OfflineCache | null;
      offlineCache?.setChannelMessages?.(channelId, messages).catch(() => { /* non-fatal */ });
    }
  } catch {
    const offlineCacheErr = BridgeRegistry.get('bridgeOfflineCache') as OfflineCache | null;
    if (offlineCacheErr) {
      messages = await offlineCacheErr.getChannelMessages?.(channelId).catch(() => []) ?? [];
      loadedFromCache = Array.isArray(messages) && messages.length > 0;
    }
  }

  const channel = getCurrentChannel();

  if (!messages.length) {
    if (area) {
      area.innerHTML = `<div class="channel-welcome"><div class="welcome-icon">#</div><h2>Welcome to #${escHtml(channel?.name ?? '')}</h2><p>${escHtml(channel?.topic ?? 'Start the conversation!')}</p></div>`;
    }
    return;
  }

  if (area) {
    area.innerHTML = `<div class="day-sep">${loadedFromCache ? '📦 Önbellek gösteriliyor — bağlantı bekleniyor' : '↑ Scroll to load older messages'}</div>`;
  }
  if (loadedFromCache) window.dispatchEvent(new CustomEvent('bridge:messages-from-cache'));

  let lastUserId: string | null = null;
  for (const msg of messages) {
    renderMessage(msg, lastUserId === msg.userId);
    lastUserId = msg.userId;
  }

  _scrollState.oldestMessageTimestamp = messages[0].createdAt;

  const savedPos = (BridgeRegistry.get('_channelScrollPos') as Map<string, number | 'bottom'> | null)?.get(channelId);
  if (savedPos !== undefined && savedPos !== 'bottom') {
    if (area) area.scrollTop = savedPos as number;
  } else {
    scrollToBottom(false);
  }
}

// ── loadOlderMessages ──────────────────────────────────────────

export async function loadOlderMessagesImpl(channelId: string): Promise<void> {
  const cursorParam = _prevCursor
    ? `cursor=${encodeURIComponent(_prevCursor)}`
    : _scrollState.oldestMessageTimestamp
      ? `before=${String(_scrollState.oldestMessageTimestamp)}`
      : null;
  if (!cursorParam) return;

  const r = await apiFetch(`${getAPI()}/api/channels/${channelId}/messages?${cursorParam}&limit=50`);
  const data = await r.json() as MessagesResponse | Message[];

  let messages: Message[];
  if (data && !Array.isArray(data) && Array.isArray(data.messages)) {
    messages    = data.messages;
    _prevCursor = data.prevCursor ?? null;
    if (!data.hasMore) _scrollState.noMoreMessages = true;
  } else if (Array.isArray(data)) {
    messages = data as Message[];
  } else {
    messages = [];
  }

  if (!messages.length) { _scrollState.noMoreMessages = true; return; }

  const area = _getMsgArea();
  if (!area) return;

  // Eski mesajları fragment'e ekle — renderer.ts'teki renderMessage'ı kullan
  const frag = document.createDocumentFragment();
  let lastUserId: string | null = null;
  for (const msg of messages) {
    const el = document.createElement('div');
    el.id = `msg-${msg._id}`;
    frag.appendChild(el);
    // renderMessage doğrudan DOM'a ekliyor — önce fragment'e al, sonra sıralı insert
    lastUserId = msg.userId;
  }
  // Eski mesajları prepend et; renderMessage append eder, bu yüzden geçici div yöntemi
  const tmp = document.createElement('div');
  lastUserId = null;
  for (const msg of messages) {
    renderMessage(msg as unknown as Parameters<typeof renderMessage>[0], lastUserId === msg.userId);
    const el = document.getElementById(`msg-${msg._id}`);
    if (el) { tmp.appendChild(el); }
    lastUserId = msg.userId;
  }
  area.insertBefore(tmp, area.firstChild);
  _scrollState.oldestMessageTimestamp = messages[0].createdAt;
}
