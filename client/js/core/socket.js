// core/socket.js (split from app.js)
import { getAPI, getSocket, getRtc, getMe, getCurrentChannel,
         getCurrentServer, getClientConfig }                    from './globals.js';
import { apiFetch, getToken }                                    from './api-fetch.js';
import { escHtml, toast }                                        from './utils.js';
import { renderMessage }                                         from './messages/renderer.js';
import { renderEmbed }                                           from './messages/embeds.js';
import { renderReactionsHtml }                                   from './messages/reactions.js';
import { scrollToBottom, initInfiniteScroll }                    from './messages/scroll.js';
import { loadMessages }                                          from './messages/loader.js';

function bindSocketEvents() {
  socket.on('message:new', (msg) => {
    if (currentChannel?._id !== msg.channelId) {
      incrementUnread(msg.channelId);
//       Channels sekmesine bildirim noktası
      if (typeof window.setMobileNavPip === 'function') {
        window.setMobileNavPip('channels', true);
      }
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
  socket.on('message:pinned', ({ messageId, pinned }) => {
    const el = document.getElementById(`msg-${messageId}`); if (!el) return;
    el.classList.toggle('pinned-msg', pinned);
    const badge = el.querySelector('.pin-badge'); if (badge) badge.style.display = pinned ? '' : 'none';
  });
  socket.on('message:deleted', ({ id }) => {
    document.getElementById(`msg-${id}`)?.remove();
    if (currentChannel?._id && window.bridgeOfflineCache) {
      window.bridgeOfflineCache.removeMessage(currentChannel._id, id).catch(() => {});
    }
  });
  socket.on('message:edited', (msg) => {
    const el = document.getElementById(`msg-${msg._id}`); if (!el) return;
    const textEl = el.querySelector('.msg-text') || el.querySelector(`#msgtext-${msg._id}`);
    if (textEl) textEl.innerHTML = formatText(msg.content) + `<span class="msg-edited">(edited)</span>`;
    if (editingMessageId === msg._id) editingMessageId = null;
  });
  socket.on('message:reaction', ({ messageId, reactions }) => {
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
//   Sesli mesaj transkripsiyonu hazır olunca güncelle
  socket.on('message:transcript', ({ messageId, transcript }) => {
    const vtEl = document.getElementById(`vt-${messageId}`);
    if (vtEl) {
      vtEl.classList.remove('voice-transcript--pending');
      vtEl.innerHTML = `<span class="vt-icon">📝</span><span class="vt-text">${escHtml(transcript)}</span>`;
    }
  });

//   Link önizleme embed güncellemesi
  socket.on('message:embedUpdate', ({ messageId, embeds }) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return;
    let embedWrap = el.querySelector('.msg-embeds');
    if (!embedWrap) {
      embedWrap = document.createElement('div');
      embedWrap.className = 'msg-embeds';
      el.querySelector('.msg-body')?.appendChild(embedWrap);
    }
    if (Array.isArray(embeds) && embeds.length) {
      embedWrap.innerHTML = embeds.map(e => renderEmbed(e)).join('');
    }
  });

//   Üye takma adı güncellendi
  socket.on('member:nicknameUpdate', ({ userId, nickname }) => {
    if (currentServer) loadMembers(currentServer._id);
    // Mesajlardaki displayName'i güncelle (sadece bu oturumda)
    document.querySelectorAll(`.msg-author[data-uid="${userId}"]`).forEach(el => {
      if (nickname) el.dataset.nickname = nickname;
    });
  });

//   Kanal ayarları güncellendi (nsfw, bitrate vb.)
  socket.on('channel:update', (updatedChannel) => {
    if (window.currentServerChannels) {
      const idx = window.currentServerChannels.findIndex(c => c._id === updatedChannel._id);
      if (idx !== -1) window.currentServerChannels[idx] = updatedChannel;
    }
//     aktif ses kanalının bitrate'i değiştiyse hemen uygula
    if (updatedChannel.type === 'voice' && rtc?.isInVoice() && rtc.currentChannelId === updatedChannel._id) {
      const newBitrate = updatedChannel.bitrate || 64000;
      if (rtc.channelBitrate !== newBitrate) rtc.setChannelBitrate(newBitrate);
    }
    if (currentServer) loadChannels(currentServer._id);
  });

//   Bot modal gösterme
  socket.on('bot:showModal', ({ modal }) => {
    if (!modal?.customId || !modal?.title) return;
    _showBotModal(modal);
  });

  socket.on('mention:received', ({ fromUser, preview }) => {
    unreadMentions++; updateMentionBadge();
    toast(`@${fromUser.displayName} mentioned you: ${preview.slice(0, 60)}`, 'mention');
    const orig = document.title; document.title = `🔔 Mention! — Bridge`; setTimeout(() => { document.title = orig; }, 4000);
  });
  socket.on('voice:full', ({ max }) => { toast(`Voice channel is full (max ${max} people)`, 'error'); leaveVoice(); });

//   Admin sistem duyurusu
  socket.on('system_announcement', ({ message, from, ts }) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:99999;background:#5865f2;color:#fff;padding:14px 24px;border-radius:10px;font-size:14px;font-weight:600;box-shadow:0 4px 20px rgba(0,0,0,.4);max-width:500px;text-align:center;';
    el.innerHTML = `📢 <strong>Sistem Duyurusu</strong><br><span style="font-weight:400;">${escHtml(message)}</span>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 8000);
  });
  socket.on('typing:update', ({ userId, displayName, typing }) => {
    if (typing) typingUsers.set(userId, displayName); else typingUsers.delete(userId); updateTypingBar();
  });
  socket.on('user:status', ({ userId, status }) => {
    const rows = document.querySelectorAll('#member-list-content .member-row');
    for (const row of rows) {
      const dmBtn = row.querySelector('.dm-btn'); const uid = dmBtn?.dataset?.uid;
      const isTarget = uid === userId || (!dmBtn && userId === me?.id); if (!isTarget) continue;
      const dot = row.querySelector('.m-status'); if (!dot) continue;
      dot.className = 'm-status ' + (status === 'idle' ? 'idle' : status === 'dnd' ? 'dnd' : status === 'offline' ? 'offline' : 'online');
      const nameEl = row.querySelector('.member-name'); if (nameEl) nameEl.classList.toggle('is-online', status !== 'offline');
      break;
    }
  });
  socket.on('voice:room-update', ({ channelId, peers }) => { const el = document.getElementById(`vc-${channelId}`); if (el) el.textContent = peers.length > 0 ? peers.length : ''; });
  socket.on('connect_error', (e) => {
    console.warn('Socket error:', e.message);
    if (e.message === 'IP banned') {
      const d = e.data || {};
      const mins = d.remainingSeconds ? Math.ceil(d.remainingSeconds / 60) : null;
      const msg = mins
        ? `🚫 IP adresiniz ${mins} dakika engellendi: ${d.reason || ''}`
        : `🚫 IP adresiniz engellendi: ${d.reason || ''}`;
      toast(msg, 'error');
    } else if (e.message === 'Too many connections') {
      const d = e.data || {};
      toast(`⏱️ Çok fazla bağlantı girişimi. ${d.retryAfter || 60}sn sonra tekrar deneyin.`, 'error');
    } else {
      toast('Connection error. Reconnecting...', 'error');
    }
  });
  socket.on('reconnect', async () => {
    toast('🟢 Reconnected!', 'success');
    if (currentServer) loadMembers(currentServer._id);

    // ── Offline mesaj kuyruğunu flush et (SW outbox) ──────────
    // Service Worker Background Sync'i tetikle
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready
        .then(reg => reg.sync?.register('bridge-outbox'))
        .catch(() => {});
    }

    // ── Kaçırılan mesajları senkronize et ─────────────────────
    // Reconnect öncesi gönderilen mesajlar socket üzerinden gelmemiş
    // olabilir. Aktif kanalı yeniden yükle.
    if (currentChannel?._id && typeof loadMessages === 'function') {
      try {
        await loadMessages(currentChannel._id);
      } catch { /* sessizce geç — zaten bağlantı yeni kuruldu */ }
    }

    // ── Bekleyen in-memory kuyruk mesajlarını gönder ──────────
    _flushPendingQueue();
  });
  socket.on('dm:message', (msg) => {
    if (currentDm && msg.dmId === currentDm._id) {
      const area = document.getElementById('dm-messages');
      const el = renderDmMessage(msg);
      area.appendChild(el);
      area.scrollTop = area.scrollHeight;
      // E2EE: şifreli mesajı yerinde çöz
      if (msg.e2e && typeof window.decryptIncoming === 'function') {
        window.decryptIncoming(msg, el);
      }
    } else if (msg.userId !== getMe()?.id) {
      // Şifreli mesajsa toast'ta içeriği gösterme
      const previewText = msg.e2e ? '🔒 Şifreli mesaj' : msg.content.slice(0, 60);
      toast(`💬 DM from ${msg.displayName}: ${previewText}`, 'mention');
    }
  });
  socket.on('channel:created', () => { if (currentServer) loadChannels(currentServer._id); });
  socket.on('channel:deleted', ({ channelId }) => {
    if (currentChannel?._id === channelId) { currentChannel = null; document.getElementById('messages-area').innerHTML = '<div class="channel-welcome"><div class="welcome-icon">#</div><h2>Channel deleted</h2></div>'; }
    if (currentServer) loadChannels(currentServer._id);
  });
  socket.on('channel:updated', () => { if (currentServer) loadChannels(currentServer._id); });
  initMusicPlayer();
  initInfiniteScroll();
//   polls + soundboard socket handlers
  if (typeof initPollSocket    === 'function') initPollSocket(socket);
  if (typeof initSoundboardSocket === 'function') initSoundboardSocket(socket);
//   stage channel events
  if (typeof initStageSocketEvents === 'function') initStageSocketEvents();
  // DM call events
  if (typeof DmCall !== 'undefined') DmCall.bindSocketEvents(socket);
  // forum real-time events
  if (typeof registerForumSocketEvents === 'function') registerForumSocketEvents(socket);
}

function updateMentionBadge() {
  let badge = document.getElementById('mention-badge');
  if (!badge) { badge = document.createElement('div'); badge.id = 'mention-badge'; badge.className = 'mention-badge'; document.getElementById('my-avatar')?.appendChild(badge); }
  badge.textContent = unreadMentions > 9 ? '9+' : unreadMentions; badge.style.display = unreadMentions > 0 ? '' : 'none';
}

function updateTypingBar() {
  const bar = document.getElementById('typing-bar'); const txt = document.getElementById('typing-text');
  const others = [...typingUsers.entries()].filter(([id]) => id !== me?.id);
  if (others.length === 0) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  if (others.length === 1) txt.textContent = `${others[0][1]} is typing...`;
  else if (others.length === 2) txt.textContent = `${others[0][1]} and ${others[1][1]} are typing...`;
  else txt.textContent = `Several people are typing...`;
}

// ══════════════════════════════════════════════════
// VOICE CONTROLS
// ══════════════════════════════════════════════════
function toggleMute() {
  const muted = !rtc.muted; rtc.setMuted(muted);
  document.getElementById('btn-mute').classList.toggle('active', muted);
}

// ── v38: Bot Modal Renderer ─────────────────────────────────
function _showBotModal(modal) {
  document.getElementById('_bot-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = '_bot-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'z-index:9999';

  const FIELD_TYPES = { paragraph: 'textarea', short: 'input', text: 'input' };

  const fieldsHtml = (modal.fields || []).map((f, i) => {
    const tag  = FIELD_TYPES[f.type] || 'input';
    const req  = f.required ? ' required' : '';
    const ph   = escHtml(f.placeholder || '');
    const inp  = tag === 'textarea'
      ? `<textarea id="bm-field-${i}" class="input-field" placeholder="${ph}" rows="3"${req} style="resize:vertical"></textarea>`
      : `<input type="text" id="bm-field-${i}" class="input-field" placeholder="${ph}"${req}>`;
    return `<div class="form-group" style="margin-bottom:12px">
      <label style="font-size:13px;font-weight:600;margin-bottom:4px;display:block">${escHtml(f.label || `Alan ${i+1}`)}</label>
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
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  document.getElementById('_bm-submit').onclick = async () => {
    const modalData = {};
    (modal.fields || []).forEach((f, i) => {
      const el = document.getElementById(`bm-field-${i}`);
      if (el) modalData[f.id || `field_${i}`] = el.value;
    });
    overlay.remove();
    await apiFetch(`${API}/api/interactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'modal_submit',
        customId: modal.customId,
        channelId: currentChannel?._id,
        serverId: currentServer?._id,
        modalData,
      }),
    });
  };
}

// ─────────────────────────────────────────────────────────────
// FAZ 2: ESM Export + setSocket (servers.js döngüsü kırma)
// ─────────────────────────────────────────────────────────────

// servers.js socket instance'ını bu setter ile bildirir
let _socketInstance = null;
export function setSocket(instance) {
  _socketInstance = instance;
  // globals.js compat — getSocket() da güncellenir
}
export function getSocketInstance() { return _socketInstance; }

export {
  bindSocketEvents,
  updateMentionBadge,
  updateTypingBar,
  toggleMute,
};

