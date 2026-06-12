// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SocketPanel.svelte
//              client/js/core/socket-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/socket.ts
// Sprint 43: JS→TS geçişi
// Realtime socket event bağlama katmanı

import { getAPI, getCurrentChannel, getCurrentServer,
         getMe, currentServerChannels, setCurrentServerChannels }  from './globals.js';
import { apiFetch }                                                  from './api-fetch.js';
import { escHtml, toast }                                           from './utils.js';
import { renderMessage }                                            from './messages/renderer.js';
import { renderEmbed }                                              from './messages/embeds.js';
import { renderReactionsHtml }                                      from './messages/reactions.js';
import { scrollToBottom, initInfiniteScroll }                       from './messages/scroll.js';
import { loadMessages, loadOlderMessagesImpl,
         _scrollState }                                             from './messages/loader.js';
import { getBridgeOfflineCache }                                    from './offlineCache.js';
import { BridgeRegistry }                                           from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('Socket');


// Runtime-injected instances (BridgeRegistry üzerinden erişilir)
type SocketInstance = {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  disconnect?(): void;
  currentVoiceChannel?: string;
};

type RtcInstance = {
  muted?: boolean;
  setMuted(v: boolean): void;
  isInVoice?(): boolean;
  currentChannelId?: string;
  channelBitrate?: number;
  setChannelBitrate(v: number): void;
};

let _socketInstance: SocketInstance | null = null;
export function setSocket(instance: SocketInstance | null): void { _socketInstance = instance; }
export function getSocketInstance(): SocketInstance | null { return _socketInstance; }

function getRtcInstance(): RtcInstance | null {
  return BridgeRegistry.get('rtcInstance') as RtcInstance | null
    ?? (window as Window & { rtc?: RtcInstance }).rtc
    ?? null;
}

function getCurrentDm(): unknown {
  return BridgeRegistry.get('currentDm') ?? (window as Window & { currentDm?: unknown }).currentDm ?? null;
}

function getTypingUsersMap(): Map<string, string> {
  return (window as Window & { typingUsers?: Map<string, string> }).typingUsers ?? new Map();
}

function getUnreadMentions(): number {
  return (window as Window & { unreadMentions?: number }).unreadMentions ?? 0;
}

function incrementUnreadMentions(): void {
  const w = window as Window & { unreadMentions?: number };
  w.unreadMentions = (w.unreadMentions ?? 0) + 1;
}

function incrementUnread(_channelId: string): void {
  // Kanal okunmamış sayacı — channel-list.ts'e devredildi
  BridgeRegistry.call('incrementUnread', _channelId);
}

export function bindSocketEvents(): void {
  const socket = getSocketInstance();
  if (!socket) return;

  socket.on('message:new', (msg: { channelId: string; _id: string }) => {
    const currentChannel = getCurrentChannel();
    if (currentChannel?._id !== msg.channelId) {
      incrementUnread(msg.channelId);
      BridgeRegistry.call('setMobileNavPip', 'channels', true);
      return;
    }
    renderMessage(msg, false); scrollToBottom();
    const el = document.getElementById(`msg-${msg._id}`);
    if (el) {
      el.classList.remove('msg-enter');
      void el.offsetWidth;
      el.classList.add('msg-enter');
    }
  });

  socket.on('message:pinned', ({ messageId, pinned }: { messageId: string; pinned: boolean }) => {
    const el = document.getElementById(`msg-${messageId}`); if (!el) return;
    el.classList.toggle('pinned-msg', pinned);
    const badge = el.querySelector<HTMLElement>('.pin-badge');
    if (badge) badge.style.display = pinned ? '' : 'none';
  });

  socket.on('message:deleted', ({ id }: { id: string }) => {
    document.getElementById(`msg-${id}`)?.remove();
    const currentChannel = getCurrentChannel();
    const cache = getBridgeOfflineCache();
    if (currentChannel?._id && cache) {
      cache.removeMessage(currentChannel._id, id).catch(() => {});
    }
  });

  socket.on('message:edited', (msg: { _id: string; content: string }) => {
    const el = document.getElementById(`msg-${msg._id}`); if (!el) return;
    const textEl = el.querySelector<HTMLElement>('.msg-text') ?? el.querySelector<HTMLElement>(`#msgtext-${msg._id}`);
    if (textEl) textEl.innerHTML = formatText(msg.content) + `<span class="msg-edited">(edited)</span>`;
  });

  socket.on('message:reaction', ({ messageId, reactions }: { messageId: string; reactions: unknown }) => {
    const reactEl = document.getElementById(`reactions-${messageId}`);
    if (reactEl) {
      reactEl.outerHTML = renderReactionsHtml(messageId, reactions);
      const next = document.getElementById(`reactions-${messageId}`);
      if (next) {
        next.classList.remove('reaction-pop');
        void next.offsetWidth;
        next.classList.add('reaction-pop');
      }
    }
  });

  socket.on('message:transcript', ({ messageId, transcript }: { messageId: string; transcript: string }) => {
    const vtEl = document.getElementById(`vt-${messageId}`);
    if (vtEl) {
      vtEl.classList.remove('voice-transcript--pending');
      vtEl.innerHTML = `<span class="vt-icon">📝</span><span class="vt-text">${escHtml(transcript)}</span>`;
    }
  });

  socket.on('message:embedUpdate', ({ messageId, embeds }: { messageId: string; embeds: unknown[] }) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    let embedWrap = el.querySelector<HTMLElement>('.msg-embeds');
    if (!embedWrap) {
      embedWrap = document.createElement('div');
      embedWrap.className = 'msg-embeds';
      el.querySelector('.msg-body')?.appendChild(embedWrap);
    }
    if (Array.isArray(embeds) && embeds.length) {
      embedWrap.innerHTML = embeds.map(e => renderEmbed(e)).join('');
    }
  });

  socket.on('member:nicknameUpdate', ({ userId, nickname }: { userId: string; nickname?: string }) => {
    const currentServer = getCurrentServer();
    if (currentServer) BridgeRegistry.call('loadMembers', currentServer._id);
    document.querySelectorAll<HTMLElement>(`.msg-author[data-uid="${userId}"]`).forEach(el => {
      if (nickname) el.dataset['nickname'] = nickname;
    });
  });

  socket.on('channel:update', (updatedChannel: { _id: string; type?: string; bitrate?: number }) => {
    const idx = currentServerChannels.findIndex(c => c._id === updatedChannel._id);
    if (idx !== -1) {
      const updated = [...currentServerChannels];
      updated[idx] = updatedChannel;
      setCurrentServerChannels(updated);
    }
    const rtc = getRtcInstance();
    if (updatedChannel.type === 'voice' && rtc?.isInVoice?.() && rtc.currentChannelId === updatedChannel._id) {
      const newBitrate = updatedChannel.bitrate ?? 64000;
      if (rtc.channelBitrate !== newBitrate) rtc.setChannelBitrate(newBitrate);
    }
    const currentServer = getCurrentServer();
    if (currentServer) BridgeRegistry.call('loadChannels', currentServer._id);
  });

  socket.on('bot:showModal', ({ modal }: { modal: unknown }) => {
    if (!(modal as { customId?: string; title?: string })?.customId) return;
    _showBotModal(modal as BotModal);
  });

  socket.on('mention:received', ({ fromUser, preview }: { fromUser: { displayName: string }; preview: string }) => {
    incrementUnreadMentions(); updateMentionBadge();
    toast(`@${fromUser.displayName} mentioned you: ${preview.slice(0, 60)}`, 'mention');
    const orig = document.title; document.title = `🔔 Mention! — Bridge`; setTimeout(() => { document.title = orig; }, 4000);
  });

  socket.on('voice:full', ({ max }: { max: number }) => { toast(`Voice channel is full (max ${max} people)`, 'error'); BridgeRegistry.call('leaveVoice'); });

  socket.on('system_announcement', ({ message }: { message: string }) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#2d9cdb;color:#fff;padding:14px 24px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:500px;text-align:center;';
    el.innerHTML = `📢 <strong>Sistem Duyurusu</strong><br><span style="font-weight:400;">${escHtml(message)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  });

  socket.on('typing:update', ({ userId, displayName, typing }: { userId: string; displayName: string; typing: boolean }) => {
    const typingUsers = getTypingUsersMap();
    if (typing) typingUsers.set(userId, displayName); else typingUsers.delete(userId);
    updateTypingBar();
  });

  socket.on('user:status', ({ userId, status }: { userId: string; status: string }) => {
    const rows = document.querySelectorAll<HTMLElement>('#member-list-content .member-row');
    for (const row of rows) {
      const dmBtn = row.querySelector<HTMLElement>('.dm-btn');
      const uid = dmBtn?.dataset?.['uid'];
      const me = getMe() as { id?: string } | null;
      const isTarget = uid === userId || (!dmBtn && userId === me?.id);
      if (!isTarget) continue;
      const dot = row.querySelector<HTMLElement>('.m-status'); if (!dot) continue;
      dot.className = 'm-status ' + (['idle','dnd','offline'].includes(status) ? status : 'online');
      row.querySelector<HTMLElement>('.member-name')?.classList.toggle('is-online', status !== 'offline');
      break;
    }
  });

  socket.on('voice:room-update', ({ channelId, peers }: { channelId: string; peers: unknown[] }) => {
    const el = document.getElementById(`vc-${channelId}`);
    if (el) el.textContent = peers.length > 0 ? String(peers.length) : '';
  });

  socket.on('connect_error', (e: { message: string; data?: { remainingSeconds?: number; reason?: string; retryAfter?: number } }) => {
    log.warn('Socket error:', e.message);
    if (e.message === 'IP banned') {
      const d = e.data ?? {};
      const mins = d.remainingSeconds ? Math.ceil(d.remainingSeconds / 60) : null;
      toast(mins ? `🚫 IP adresiniz ${mins} dakika engellendi: ${d.reason ?? ''}` : `🚫 IP adresiniz engellendi: ${d.reason ?? ''}`, 'error');
    } else if (e.message === 'Too many connections') {
      toast(`⏱️ Çok fazla bağlantı girişimi. ${e.data?.retryAfter ?? 60}sn sonra tekrar deneyin.`, 'error');
    } else {
      toast('Connection error. Reconnecting...', 'error');
    }
  });

  socket.on('reconnect', async () => {
    toast('🟢 Reconnected!', 'success');
    const currentServer = getCurrentServer();
    if (currentServer) BridgeRegistry.call('loadMembers', currentServer._id);
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => (reg.sync as { register?: (tag: string) => Promise<void> })?.register?.('bridge-outbox')).catch(() => {});
    }
    const currentChannel = getCurrentChannel();
    if (currentChannel?._id) {
      try { await loadMessages(currentChannel._id); } catch { /* sessizce geç */ }
    }
    BridgeRegistry.call('_flushPendingQueue');
  });

  socket.on('dm:message', (msg: { dmId: string; e2e?: boolean; userId: string; content: string; displayName: string }) => {
    const currentDm = getCurrentDm() as { _id: string } | null;
    if (currentDm && msg.dmId === currentDm._id) {
      const area = document.getElementById('dm-messages');
      const el = BridgeRegistry.call('renderDmMessage', msg) as HTMLElement | null;
      if (area && el) {
        area.appendChild(el);
        area.scrollTop = area.scrollHeight;
        if (msg.e2e) {
          // decryptIncoming — window köprüsü; dm.ts export ediyor ama circular import riski var. Sprint 81 hedefi.
          const decrypt = (window as Window & { decryptIncoming?: (msg: unknown, el: HTMLElement) => void }).decryptIncoming;
          if (typeof decrypt === 'function') decrypt(msg, el);
        }
      }
    } else if (msg.userId !== (getMe() as { id?: string } | null)?.id) {
      const previewText = msg.e2e ? '🔒 Şifreli mesaj' : msg.content.slice(0, 60);
      toast(`💬 DM from ${msg.displayName}: ${previewText}`, 'mention');
    }
  });

  socket.on('channel:created', () => { const s = getCurrentServer(); if (s) BridgeRegistry.call('loadChannels', s._id); });
  socket.on('channel:deleted', ({ channelId }: { channelId: string }) => {
    const currentChannel = getCurrentChannel();
    if (currentChannel?._id === channelId) {
      const area = document.getElementById('messages-area');
      if (area) area.innerHTML = '<div class="channel-welcome"><div class="welcome-icon">#</div><h2>Channel deleted</h2></div>';
    }
    const s = getCurrentServer(); if (s) BridgeRegistry.call('loadChannels', s._id);
  });
  socket.on('channel:updated', () => { const s = getCurrentServer(); if (s) BridgeRegistry.call('loadChannels', s._id); });

  BridgeRegistry.call('initMusicPlayer');
  initInfiniteScroll(loadOlderMessagesImpl, _scrollState);
  BridgeRegistry.call('initPollSocket', socket);
  BridgeRegistry.call('initSoundboardSocket', socket);
  BridgeRegistry.call('initStageSocketEvents');
  BridgeRegistry.call('DmCall.bindSocketEvents', socket);
  BridgeRegistry.call('registerForumSocketEvents', socket);
}

export function updateMentionBadge(): void {
  const unreadMentions = getUnreadMentions();
  let badge = document.getElementById('mention-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'mention-badge';
    badge.className = 'mention-badge';
    document.getElementById('my-avatar')?.appendChild(badge);
  }
  badge.textContent = unreadMentions > 9 ? '9+' : String(unreadMentions);
  badge.style.display = unreadMentions > 0 ? '' : 'none';
}

export function updateTypingBar(): void {
  const bar = document.getElementById('typing-bar');
  const txt = document.getElementById('typing-text');
  const typingUsers = getTypingUsersMap();
  const me = getMe() as { id?: string } | null;
  const others = [...typingUsers.entries()].filter(([id]) => id !== me?.id);
  if (!bar) return;
  if (others.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (txt) {
    if (others.length === 1) txt.textContent = `${others[0][1]} is typing...`;
    else if (others.length === 2) txt.textContent = `${others[0][1]} and ${others[1][1]} are typing...`;
    else txt.textContent = `Several people are typing...`;
  }
}

export function toggleMute(): void {
  const rtc = getRtcInstance();
  if (!rtc) return;
  const muted = !rtc.muted;
  rtc.setMuted(muted);
  document.getElementById('btn-mute')?.classList.toggle('active', muted);
}

// ── BOT MODAL ─────────────────────────────────────────────────────────────────
interface BotModalField {
  type: 'paragraph' | 'short' | 'text' | string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  id?: string;
}

interface BotModal {
  customId: string;
  title: string;
  fields?: BotModalField[];
}

function _showBotModal(modal: BotModal): void {
  document.getElementById('_bot-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = '_bot-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'z-index:9999';
  const FIELD_TYPES: Record<string, string> = { paragraph: 'textarea', short: 'input', text: 'input' };
  const fieldsHtml = (modal.fields ?? []).map((f, i) => {
    const tag = FIELD_TYPES[f.type] ?? 'input';
    const req = f.required ? ' required' : '';
    const ph  = escHtml(f.placeholder ?? '');
    const inp = tag === 'textarea'
      ? `<textarea id="bm-field-${i}" class="input-field" placeholder="${ph}" rows="3"${req} style="resize:vertical"></textarea>`
      : `<input type="text" id="bm-field-${i}" class="input-field" placeholder="${ph}"${req}>`;
    return `<div class="form-group" style="margin-bottom:12px">
      <label style="font-size:13px;font-weight:600;margin-bottom:4px;display:block">${escHtml(f.label ?? `Alan ${i + 1}`)}</label>
      ${inp}
    </div>`;
  }).join('');

  overlay.innerHTML = `
    <div class="modal-card" style="max-width:440px;width:95%;border-radius:12px">
      <h2 style="margin:0 0 16px;font-size:18px">${escHtml(modal.title)}</h2>
      ${fieldsHtml}
      <div class="modal-footer" style="margin-top:16px;display:flex;gap:8px">
        <button class="btn btn-primary" id="_bm-submit">Gönder</button>
        <button class="btn" onclick="document.getElementById('_bot-modal')?.remove()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e: MouseEvent) => { if (e.target === overlay) overlay.remove(); };

  const submitBtn = document.getElementById('_bm-submit');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const modalData: Record<string, string> = {};
      (modal.fields ?? []).forEach((f, i) => {
        const el = document.getElementById(`bm-field-${i}`) as HTMLInputElement | HTMLTextAreaElement | null;
        if (el) modalData[f.id ?? `field_${i}`] = el.value;
      });
      overlay.remove();
      await apiFetch(`${getAPI()}/api/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'modal_submit',
          customId: modal.customId,
          channelId: getCurrentChannel()?._id,
          serverId: getCurrentServer()?._id,
          modalData,
        }),
      });
    };
  }
}

// formatText — runtime'da globals veya utils'den gelir
function formatText(content: string): string {
  return (BridgeRegistry.get('formatText') as ((s: string) => string) | null)?.(content) ?? escHtml(content);
}
