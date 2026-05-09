import { getMe } from './globals.js';
// core/dm.js
// Direkt mesajlaşma paneli

let currentDm = null;

function openDmPanel() {
  document.getElementById('dm-panel').style.display = 'flex';
  loadDmList();
}

function closeDmPanel() {
  document.getElementById('dm-panel').style.display = 'none';
  currentDm = null;
}

async function loadDmList() {
  const r = await apiFetch(`${API}/api/dm`);
  const convs = await r.json();
  const list = document.getElementById('dm-list');
  list.innerHTML = '';
  if (!convs.length) {
    list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px">No DMs yet.</div>';
    return;
  }
  for (const conv of convs) {
    const el = document.createElement('div');
    el.className = 'dm-item';
    el.dataset.uid = conv.other._id || conv.other.id || '';
    const otherStatus = conv.other.status || 'offline';
    const statusDot = `<span class="dm-status-dot dm-status-${otherStatus}"></span>`;
    el.innerHTML = `
      <div style="position:relative;flex-shrink:0">
        <div class="dm-avatar" style="background:${cssColor(conv.other.avatarColor)}">${initials(conv.other.displayName)}</div>
        ${statusDot}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(conv.other.displayName)}</div>
        ${conv.lastMessage ? `<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px">${escHtml(conv.lastMessage.content || '').slice(0,40)}</div>` : ''}
      </div>
    `;
    el.onclick = () => openDm(conv, conv.other);
    list.appendChild(el);
  }
}

async function openDmWithUser(userId, displayName, avatarColor) {
  const r = await apiFetch(`${API}/api/dm/${userId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const conv = await r.json();
  if (!r.ok) return toast(conv.error, 'error');
  openDm(conv, conv.other || { displayName, avatarColor });
}

async function openDm(conv, other) {
  currentDm = conv;
//   track current DM partner for E2EE and reset E2EE mode on conversation switch
  window._currentDmUserId = conv.participants?.find(p => p !== getMe()?.id) || other?._id || null;
  if (typeof resetDmE2E === 'function') resetDmE2E();
  document.getElementById('dm-panel').style.display = 'flex';
  document.getElementById('dm-chat-header').textContent = `💬 ${other.displayName}`;
  socket.emit('dm:join', conv._id);
  const area = document.getElementById('dm-messages');
  area.innerHTML = '';
  const r = await apiFetch(`${API}/api/dm/${conv._id}/messages?limit=50`);
  const messages = await r.json();
  for (const msg of messages) area.appendChild(renderDmMessage(msg));
  area.scrollTop = area.scrollHeight;
  document.getElementById('dm-input-area').style.display = 'flex';

  // Show call buttons and wire them to the current DM partner
  const voiceBtn = document.getElementById('dm-call-voice-btn');
  const videoBtn = document.getElementById('dm-call-video-btn');
  if (voiceBtn) voiceBtn.style.display = '';
  if (videoBtn) videoBtn.style.display = '';

  const _otherUserId   = window._currentDmUserId;
  const _otherName     = other?.displayName || '';
  const _otherColor    = other?.avatarColor  || '#5865f2';

  window._dmCallVoice = () => {
    if (window.DmCall && _otherUserId) DmCall.startCall(_otherUserId, _otherName, _otherColor, 'voice');
  };
  window._dmCallVideo = () => {
    if (window.DmCall && _otherUserId) DmCall.startCall(_otherUserId, _otherName, _otherColor, 'video');
  };
}

function renderDmMessage(msg) {
  const el = document.createElement('div');
  el.className = 'dm-msg' + (msg.userId === me?.id ? ' dm-own' : '');
  el.id = `dm-msg-${msg._id}`;
  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `<div class="dm-msg-avatar" style="background:${cssColor(msg.avatarColor)}">${initials(msg.displayName)}</div><div class="dm-msg-body"><div class="dm-msg-header"><span class="dm-msg-name">${escHtml(msg.displayName)}</span><span class="dm-msg-time">${time}</span></div><div class="dm-msg-text">${formatText(msg.content)}</div></div>`;
  return el;
}

function sendDm() {
  if (!currentDm) return;
  const inp = document.getElementById('dm-input');
  const content = inp.value.trim();
  if (!content) return;
  if (content.length > 2000) return toast('Message too long', 'error');
  socket.emit('dm:send', {
    toUserId: currentDm.participants.find(p => p !== me.id),
    content,
  });
  inp.value = '';
}

function handleDmKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDm(); }
}

// ── Live DM status dot updates ──────────────────────────────
// Called from socket-events or socket.js when user:status fires
function updateDmStatusDot(userId, status) {
  const el = document.querySelector(`#dm-list .dm-item[data-uid="${userId}"] .dm-status-dot`);
  if (!el) return;
  el.className = `dm-status-dot dm-status-${status}`;
}
// Hook into existing user:status socket event
if (typeof socket !== 'undefined') {
  socket.on('user:status', ({ userId, status }) => updateDmStatusDot(userId, status));
}

// ── DM / Group DM sekme değiştirici ──────────────────────────
// app.js'den taşındı (v modüler)
function switchDmTab(tab) {
  const isDm = tab === 'dm';
  document.getElementById('dm-list-wrap').style.display  = isDm ? '' : 'none';
  document.getElementById('gdm-list-wrap').style.display = isDm ? 'none' : '';
  document.getElementById('dm-tab-btn').style.borderBottomColor  = isDm ? 'var(--brand)' : 'transparent';
  document.getElementById('dm-tab-btn').style.color              = isDm ? 'var(--brand)' : 'var(--text-muted)';
  document.getElementById('gdm-tab-btn').style.borderBottomColor = isDm ? 'transparent' : 'var(--brand)';
  document.getElementById('gdm-tab-btn').style.color             = isDm ? 'var(--text-muted)' : 'var(--brand)';
  if (!isDm) loadGroupDmList();
}

// ──────────────────────────────────────────────────────────────────────────────
// E2EE DM WRAPPER'LARI
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Mevcut açık DM'e E2EE ile şifrelenmiş mesaj gönderir.
 */
async function sendEncryptedMessage(plaintext) {
  if (!currentDm) throw new Error('[E2EE] Açık bir DM konuşması yok');
  if (!plaintext || plaintext.length > 2000) throw new Error('[E2EE] Geçersiz mesaj');

  const recipientId = currentDm.participants?.find(p => p !== getMe()?.id);
  if (!recipientId) throw new Error('[E2EE] Alıcı bulunamadı');

  let finalContent = plaintext;
  let e2eData = null;

  if (window.BridgeE2E?.getStatus?.().enabled) {
    try {
      const encrypted = await window.BridgeE2E.encryptDM(plaintext, recipientId, getMe().id);
      if (encrypted.encrypted) {
        finalContent = encrypted.content;
        e2eData = encrypted.e2e;
      }
    } catch (err) {
      console.warn('[E2EE] sendEncryptedMessage — şifreleme başarısız, düz metin gönderiliyor:', err.message);
    }
  }

  socket.emit('dm:send', { toUserId: recipientId, content: finalContent, e2e: e2eData });

  // Input'u temizle (sendDm() ile tutarlı)
  const inp = document.getElementById('dm-input');
  if (inp) inp.value = '';
}

/**
 * Gelen bir DM mesajının e2e alanını çözer ve DOM elementini günceller.
 */
async function decryptIncoming(msg, el) {
  if (!msg.e2e) return null;
  const myUserId = getMe()?.id;
  if (!myUserId) return null;
  if (!window.BridgeE2E?.getStatus?.().enabled) return null;

  try {
    const plaintext = await window.BridgeE2E.decryptDM(msg.e2e, myUserId);
    if (!plaintext) return null;
    const textEl = el.querySelector('.dm-msg-text');
    if (textEl) textEl.innerHTML = typeof formatText === 'function' ? formatText(plaintext) : plaintext;
    return plaintext;
  } catch (err) {
    console.warn('[E2EE] decryptIncoming — şifre çözme hatası:', err.message);
    return null;
  }
}

export {
  closeDmPanel,
  decryptIncoming,
  handleDmKey,
  loadDmList,
  openDm,
  openDmPanel,
  openDmWithUser,
  renderDmMessage,
  sendDm,
  sendEncryptedMessage,
  switchDmTab,
  updateDmStatusDot,
};

