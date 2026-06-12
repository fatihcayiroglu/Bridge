// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/InputPanel.svelte
//              client/js/core/input-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/messages/input.ts
// Mesaj gönderme, düzenleme, typing, text formatı
//
// Sprint 95: Offline mesaj kuyruğu entegrasyonu
//   - socket bağlı değilse / navigator.onLine false ise mesaj IndexedDB outbox'a alınır
//   - Optimistic render: mesaj anında görünür, sağ üstte ⏳ badge gösterilir
//   - Reconnect olduğunda outbox otomatik flush edilir (socket.ts'deki 'reconnect'
//     olayı ServiceWorker sync'i zaten tetikliyor; bu modül de socket üzerinden gönderir)
//   - Başarılı gönderimde ⏳ → ✓ geçiş animasyonu
//   - Kalıcı hata durumunda 🔴 badge + yeniden gönder butonu

import { BridgeRegistry }                         from '../bridge-registry.js';
import { getAPI, getMe, getCurrentChannel, getCurrentServer,
         getSocket, getServerEmojiCache }          from '../globals.js';
import { apiFetch }                                from '../api-fetch.js';
import { escHtml, toast }                          from '../utils.js';
import { scrollToBottom }                          from './scroll.js';
import { renderMessage }                           from './renderer.js';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ServerEmoji { name: string; url: string; }

interface PendingEntry {
  id:        string;   // geçici client-side id
  channelId: string;
  content:   string;
  replyToId: string | null;
  serverId:  string | null;
  ts:        number;
  attempts:  number;
}

// ── Pending mesaj store (in-memory, IndexedDB'ye senkronize edilir) ────────────

const _pending = new Map<string, PendingEntry>();

function _pendingKey(): string {
  return 'pending-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
}

async function _savePendingToIDB(entry: PendingEntry): Promise<void> {
  const cache = BridgeRegistry.get('bridgeOfflineCache') as
    { sendMessageWithOutbox?: Function } | null;
  // Mevcut outbox API'sine uyumlu: channelId + content + token + apiBase
  const me    = getMe() as { token?: string } | null;
  const token = me?.token ?? (localStorage.getItem('token') ?? '');
  await cache?.sendMessageWithOutbox?.(entry.channelId, entry.content, token, getAPI());
}

// ── Optimistic render yardımcıları ─────────────────────────────────────────────

function _renderPendingMessage(entry: PendingEntry): void {
  const me = getMe() as { _id?: string; username?: string; displayName?: string; avatar?: string } | null;
  const fakeMsg = {
    _id:         entry.id,
    content:     entry.content,
    userId:      me?._id ?? 'me',
    username:    me?.username ?? '…',
    displayName: me?.displayName ?? me?.username ?? '…',
    avatar:      me?.avatar ?? null,
    createdAt:   entry.ts,
    _pending:    true,
    replyToId:   entry.replyToId,
  };
  renderMessage(fakeMsg as Record<string, unknown>, false);

  // ⏳ badge ekle
  requestAnimationFrame(() => {
    const el = document.getElementById(`msg-${entry.id}`);
    if (!el) return;
    el.classList.add('msg-pending');
    const badge = document.createElement('span');
    badge.className  = 'msg-pending-badge';
    badge.id         = `pending-badge-${entry.id}`;
    badge.title      = 'Gönderiliyor…';
    badge.textContent = '⏳';
    el.appendChild(badge);
  });
}

function _markPendingSent(tmpId: string): void {
  const badge = document.getElementById(`pending-badge-${tmpId}`);
  if (badge) {
    badge.textContent = '✓';
    badge.classList.add('msg-pending-badge--sent');
    setTimeout(() => badge.remove(), 1200);
  }
  const el = document.getElementById(`msg-${tmpId}`);
  el?.classList.remove('msg-pending');
  _pending.delete(tmpId);
}

function _markPendingFailed(tmpId: string): void {
  const badge = document.getElementById(`pending-badge-${tmpId}`);
  if (badge) {
    badge.textContent = '🔴';
    badge.title       = 'Gönderilemedi — tekrar denemek için tıkla';
    badge.classList.add('msg-pending-badge--failed');
    const entry = _pending.get(tmpId);
    if (entry) {
      badge.style.cursor = 'pointer';
      badge.onclick = () => _retrySend(entry);
    }
  }
}

async function _retrySend(entry: PendingEntry): Promise<void> {
  const badge = document.getElementById(`pending-badge-${entry.id}`);
  if (badge) { badge.textContent = '⏳'; badge.classList.remove('msg-pending-badge--failed'); }
  entry.attempts++;
  await _dispatchSend(entry);
}

// ── Gönderim motoru ────────────────────────────────────────────────────────────

async function _dispatchSend(entry: PendingEntry): Promise<void> {
  const socket = getSocket() as { emit(ev: string, ...a: unknown[]): void; connected?: boolean } | null;
  const online = navigator.onLine !== false;

  if (socket?.connected && online) {
    // Normal yol: socket üzerinden gönder
    if (entry.replyToId) {
      socket.emit('message:reply', {
        channelId: entry.channelId,
        content:   entry.content,
        serverId:  entry.serverId,
        replyToId: entry.replyToId,
        // Sunucu tmpId'yi echo'layınca pending mesajı gerçeğiyle değiştireceğiz
        _tmpId:    entry.id,
      });
    } else {
      socket.emit('message:send', {
        channelId: entry.channelId,
        content:   entry.content,
        serverId:  entry.serverId,
        _tmpId:    entry.id,
      });
    }
    // Sunucudan 'message:ack' veya 'message:new' gelince _markPendingSent çağrılır.
    // Eğer 5 saniye içinde ack gelmezse outbox'a al.
    setTimeout(() => {
      if (_pending.has(entry.id)) {
        _savePendingToIDB(entry).catch(() => {});
        _markPendingFailed(entry.id);
      }
    }, 5000);
  } else {
    // Çevrimdışı: outbox'a al, kullanıcıya bildir
    await _savePendingToIDB(entry).catch(() => {});
    const badge = document.getElementById(`pending-badge-${entry.id}`);
    if (badge) {
      badge.textContent = '📤';
      badge.title       = 'Çevrimdışı — bağlantı kurulunca gönderilecek';
    }
  }
}

// ── Socket ack dinleyici (modül yüklenince bir kez kurulur) ───────────────────

let _ackListenerInstalled = false;

function _installAckListener(): void {
  if (_ackListenerInstalled) return;
  const socket = getSocket() as {
    on(ev: string, cb: (...a: unknown[]) => void): void;
    connected?: boolean;
  } | null;
  if (!socket) { setTimeout(_installAckListener, 300); return; }
  _ackListenerInstalled = true;

  // Sunucu mesajı işleyince _tmpId'yi echo'lamalı; yoksa userId+content eşleşmesi dener
  socket.on('message:ack', (data: unknown) => {
    // Sprint 96: server tmpId'yi echo'layınca pending mesajı teslim edildi işaretle.
    // tmpId hem sendAck (ackId ile birlikte) hem sendTmpAck (tek başına) ile gelir.
    const d = data as { tmpId?: string; ackId?: string };
    const tid = d?.tmpId;
    if (tid && _pending.has(tid)) _markPendingSent(tid);
  });

  // Reconnect sonrası bekleyen mesajları yeniden dene
  socket.on('reconnect', () => {
    for (const entry of _pending.values()) {
      entry.attempts++;
      _dispatchSend(entry).catch(() => {});
    }
  });
}

// ── FORMAT TEXT ───────────────────────────────────────────────────────────────

export function formatText(text: string): string {
  if (!text) return '';

  const codeBlocks: string[] = [];
  let safe = escHtml(text);

  safe = safe.replace(/```([\s\S]+?)```/g, (_, code: string) => {
    codeBlocks.push('<pre><code>' + code + '</code></pre>');
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });
  safe = safe.replace(/`([^`]+)`/g, (_, code: string) => {
    codeBlocks.push('<code>' + code + '</code>');
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });

  safe = safe
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g,    '<em>$1</em>')
    .replace(/__(.+?)__/g,         '<strong>$1</strong>')
    .replace(/_([^_\n]+?)_/g,      '<em>$1</em>')
    .replace(/~~(.+?)~~/g,         '<del>$1</del>')
    .replace(/__([^_]+)__/g,       '<u>$1</u>');

  safe = safe.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
  safe = safe.replace(/\n/g, '<br>');
  safe = safe.replace(/\x00CODE(\d+)\x00/g, (_, i: string) => codeBlocks[+i]);

  let html = safe;
  const emojiCache: ServerEmoji[] = getServerEmojiCache() as ServerEmoji[];
  if (emojiCache.length) {
    const cacheSize: number = BridgeRegistry.get('_emojiMapSize') ?? 0;
    if (!BridgeRegistry.get('_emojiMap') || cacheSize !== emojiCache.length) {
      BridgeRegistry.register('_emojiMap', new Map(emojiCache.map(e => [e.name, e])));
      BridgeRegistry.register('_emojiMapSize', emojiCache.length);
    }
    const emojiMap = BridgeRegistry.get('_emojiMap') as Map<string, ServerEmoji>;
    html = html.replace(/:[\\w.-]+:/g, (match: string) => {
      const name = match.slice(1, -1);
      const emoji = emojiMap?.get(name);
      if (!emoji) return match;
      const safeUrl  = encodeURI(getAPI() + emoji.url);
      const safeName = escHtml(emoji.name);
      return `<img src="${safeUrl}" alt=":${safeName}:" title=":${safeName}:" class="server-emoji">`;
    });
  }

  return html;
}

// ── SEND ──────────────────────────────────────────────────────────────────────

export function sendMessage(): void {
  const input   = document.getElementById('msg-input') as HTMLTextAreaElement | null;
  const content = input?.value.trim();
  const channel = getCurrentChannel() as { _id: string; serverId?: string; type?: string } | null;
  if (!content || !channel || channel.type !== 'text') return;
  if (content.length > 2000) { toast('Message too long (max 2000 characters)', 'error'); return; }

  const socket = getSocket() as { emit(ev: string, ...a: unknown[]): void } | null;

  // Slash commands
  if (content.startsWith('/') && BridgeRegistry.has('executeSlashCommand')) {
    if (BridgeRegistry.call('executeSlashCommand', content)) {
      if (input) { input.value = ''; input.style.height = 'auto'; }
      socket?.emit('typing:stop', { channelId: channel._id });
      return;
    }
  }

  const replyingTo: string | null = (BridgeRegistry.call('replyingTo') as string | null) ?? null;
  const server = getCurrentServer() as { _id: string } | null;

  // Pending entry oluştur
  const entry: PendingEntry = {
    id:        _pendingKey(),
    channelId: channel._id,
    content,
    replyToId: replyingTo,
    serverId:  server?._id ?? null,
    ts:        Date.now(),
    attempts:  0,
  };
  _pending.set(entry.id, entry);

  // Optimistic render
  _renderPendingMessage(entry);
  scrollToBottom(true);

  if (replyingTo) BridgeRegistry.call('cancelReply');

  // Input temizle
  if (input) { input.value = ''; input.style.height = 'auto'; }

  // Send button animasyonu
  const sendBtn = document.querySelector<HTMLElement>('.msg-input-btn.send');
  if (sendBtn) {
    sendBtn.classList.remove('send-pop');
    void sendBtn.offsetWidth;
    sendBtn.classList.add('send-pop');
  }

  socket?.emit('typing:stop', { channelId: channel._id });

  // Gönderim motoru (async, bloklamaz)
  _installAckListener();
  _dispatchSend(entry).catch(() => _markPendingFailed(entry.id));
}

export function handleMsgKey(e: KeyboardEvent): void {
  if (BridgeRegistry.has('handleSlashKey') && (BridgeRegistry.call('handleSlashKey', e) as boolean)) return;
  if (BridgeRegistry.has('handleMentionKey')) {
    const textarea = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    if ((BridgeRegistry.call('handleMentionKey', e, textarea) as boolean)) return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

let _typingTimer: ReturnType<typeof setTimeout> | null = null;

export function handleTypingInput(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 160) + 'px';

  const sendBtn = document.querySelector<HTMLElement>('.msg-input-btn.send');
  if (sendBtn) sendBtn.classList.toggle('send-has-content', el.value.trim().length > 0);

  const channel = getCurrentChannel() as { _id: string; serverId?: string } | null;
  if (!channel) return;

  const socket = getSocket() as { emit(ev: string, ...a: unknown[]): void } | null;
  socket?.emit('typing:start', { channelId: channel._id });

  if (_typingTimer) clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => socket?.emit('typing:stop', { channelId: channel._id }), 2000);

  BridgeRegistry.call('handleSlashInput', el.value);
  BridgeRegistry.call('handleMentionAutocomplete', el);
  if (channel) BridgeRegistry.call('saveDraft', channel._id, el.value);
}

// ── EDIT ──────────────────────────────────────────────────────────────────────

export function startEditMessage(msgId: string, _btn?: HTMLElement): void {
  if (BridgeRegistry.call('getEditingMessageId')) cancelEdit();
  BridgeRegistry.register('getEditingMessageId', () => msgId);

  const textEl =
    document.getElementById(`msgtext-${msgId}`) ??
    document.getElementById(`msg-${msgId}`)?.querySelector<HTMLElement>('.msg-text');
  if (!textEl) return;

  const original = (textEl as HTMLElement & { dataset: DOMStringMap }).dataset.raw ?? textEl.textContent?.replace(' (edited)', '').trim() ?? '';
  (textEl as HTMLElement & { dataset: DOMStringMap }).dataset.raw = original;

  textEl.innerHTML = `
    <div class="edit-wrap">
      <textarea class="edit-input" id="edit-input-${msgId}">${escHtml(original)}</textarea>
      <div class="edit-hint">
        <span>Press <kbd>Enter</kbd> to save, <kbd>Esc</kbd> to cancel</span>
        <div>
          <button class="btn-edit-cancel" onclick="cancelEdit()">Cancel</button>
          <button class="btn-edit-save" onclick="saveEdit('${msgId}')">Save</button>
        </div>
      </div>
    </div>`;

  const inp = document.getElementById(`edit-input-${msgId}`) as HTMLTextAreaElement | null;
  if (inp) {
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    inp.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msgId); }
      if (e.key === 'Escape') cancelEdit();
    });
  }
}

export async function saveEdit(msgId: string): Promise<void> {
  const inp = document.getElementById(`edit-input-${msgId}`) as HTMLTextAreaElement | null;
  if (!inp) return;
  const content = inp.value.trim();
  if (!content) return;

  const channel = getCurrentChannel() as { _id: string } | null;
  const socket  = getSocket() as { emit(ev: string, ...a: unknown[]): void } | null;
  socket?.emit('message:edit', { messageId: msgId, channelId: channel?._id, content });
  BridgeRegistry.register('getEditingMessageId', () => null);
}

export function cancelEdit(): void {
  const editingId: string | null = (BridgeRegistry.call('getEditingMessageId') as string | null) ?? null;
  if (!editingId) return;

  const textEl =
    document.getElementById(`msgtext-${editingId}`) ??
    document.getElementById(`msg-${editingId}`)?.querySelector<HTMLElement>('.msg-text');

  if (textEl && (textEl as HTMLElement & { dataset: DOMStringMap }).dataset.raw) {
    textEl.innerHTML = formatText((textEl as HTMLElement & { dataset: DOMStringMap }).dataset.raw);
  }
  BridgeRegistry.register('getEditingMessageId', () => null);
}

export function showDeleteMessageModal(msgId: string, channelId: string): void {
  BridgeRegistry.call('showConfirmModal', {
    title:       'Delete Message',
    message:     'This message will be permanently deleted.',
    confirmText: 'Delete',
    danger:      true,
    onConfirm:   () => {
      const socket = getSocket() as { emit(ev: string, ...a: unknown[]): void } | null;
      socket?.emit('message:delete', { messageId: msgId, channelId });
    },
  });
}

// ── SEARCH ────────────────────────────────────────────────────────────────────

export async function searchMessages(): Promise<void> {
  const q = (document.getElementById('search-input') as HTMLInputElement | null)?.value?.trim();
  const channel = getCurrentChannel() as { _id: string } | null;
  if (!q || !channel) return;

  const r = await apiFetch(
    `${getAPI()}/api/channels/${channel._id}/messages?q=${encodeURIComponent(q)}&limit=50`
  );
  const messages: Array<Record<string, unknown>> = await r.json();
  const area = document.getElementById('messages-area');
  if (!area) return;

  const headerDiv = document.createElement('div');
  headerDiv.className = 'day-sep';
  headerDiv.textContent = `Search: "${q}" (${messages.length})`;
  area.appendChild(headerDiv);

  if (!messages.length) {
    const e = document.createElement('div');
    e.style.cssText = 'padding:20px;color:var(--text-muted)';
    e.textContent = 'No messages found.';
    area.appendChild(e);
    return;
  }

  let lastUserId: string | null = null;
  for (const msg of messages) {
    renderMessage(msg, lastUserId === msg.userId);
    lastUserId = msg.userId as string;
  }
  scrollToBottom(false);
}

// ── TRANSLATE ─────────────────────────────────────────────────────────────────

export async function translateMessage(msgId: string): Promise<void> {
  const textEl =
    document.getElementById(`msgtext-${msgId}`) ??
    document.querySelector<HTMLElement>(`#msg-${msgId} .msg-text`);
  if (!textEl) return;

  const raw = (textEl as HTMLElement & { dataset: DOMStringMap }).dataset.raw ?? textEl.textContent?.replace(' (edited)', '').trim();
  if (!raw) return;

  const existing = textEl.querySelector('.msg-translation');
  if (existing) { existing.remove(); return; }

  const btn = document.querySelector<HTMLButtonElement>(`#msg-${msgId} .translate-btn`);
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

  try {
    let translatedText: string | null = null;
    const API = getAPI();
    const clientConfig = (BridgeRegistry.call('clientConfig') as Record<string, unknown>) ?? {};

    if (clientConfig.translateEnabled) {
      const r = await apiFetch(`${API}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: raw, target: 'tr' }),
      });
      if (r.ok) {
        const data = await r.json();
        translatedText = data.translatedText ?? null;
      }
    }

    if (!translatedText) {
      const r = await apiFetch(`${API}/api/ai/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw, targetLanguage: 'Turkish' }),
      });
      if (r.ok) {
        const data = await r.json();
        translatedText = data.translation ?? data.translatedText ?? null;
      }
    }

    if (!translatedText) { toast('Çeviri yapılamadı — AI API key gerekli', 'error'); return; }

    const div = document.createElement('div');
    div.className = 'msg-translation';
    div.innerHTML = `<span class="translation-label">🌐 Türkçe:</span> ${escHtml(translatedText)}`;
    textEl.appendChild(div);
  } catch {
    toast('Çeviri hatası', 'error');
  } finally {
    if (btn) { btn.textContent = '🌐'; btn.disabled = false; }
  }
}
