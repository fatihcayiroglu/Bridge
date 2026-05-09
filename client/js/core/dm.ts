export {};
// core/dm.js
// Direkt mesajlaÅŸma paneli

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
  window._currentDmUserId = conv.participants?.find(p => p !== window.me?.id) || other?._id || null;
  if (typeof resetDmE2E === 'function') resetDmE2E();
  document.getElementById('dm-panel').style.display = 'flex';
  document.getElementById('dm-chat-header').textContent = `ğŸ’¬ ${other.displayName}`;
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
  
  // E2EE: Şifreli mesaj göstergesi
  const isEncrypted = msg.e2e || (msg.content && msg.content.includes('🔒'));
  const lockBanner = isEncrypted 
    ? `<div style="display:inline-flex;align-items:center;gap:4px;background:rgba(35,165,90,0.15);border:1px solid rgba(35,165,90,0.3);border-radius:4px;padding:2px 6px;font-size:10px;color:#23a55a;margin-bottom:4px;"><span style="font-size:12px;">🔒</span><span>Uçtan uca şifreli</span></div>`
    : '';
  
  el.innerHTML = `<div class="dm-msg-avatar" style="background:${cssColor(msg.avatarColor)}">${initials(msg.displayName)}</div><div class="dm-msg-body"><div class="dm-msg-header"><span class="dm-msg-name">${escHtml(msg.displayName)}</span><span class="dm-msg-time">${time}</span></div>${lockBanner}<div class="dm-msg-text">${formatText(msg.content)}</div></div>`;
  
  // E2EE: Şifreli mesajı wrapper üzerinden çöz
  if (msg.e2e) {
    decryptIncoming(msg, el).catch(() => {}); // hata zaten içeride loglanıyor
  }
  
  return el;
}

async function sendDm() {
  if (!currentDm) return;
  const inp = document.getElementById('dm-input') as HTMLInputElement | null;
  if (!inp) return;
  const content = inp.value.trim();
  if (!content) return;
  if (content.length > 2000) return (window as any).toast?.('Message too long', 'error');

  // E2EE modu aktifse wrapper'ı kullan (input temizlemeyi de o halleder)
  if (_dmE2EActive) {
    try {
      await sendEncryptedMessage(content);
    } catch (err: any) {
      (window as any).toast?.(`[E2EE] ${err.message}`, 'error');
    }
    return;
  }

  // E2EE kapalı — düz metin gönder
  const recipientId = currentDm.participants?.find((p: string) => p !== (window as any).me?.id);
  (socket as any).emit('dm:send', {
    toUserId: recipientId,
    content,
    e2e: null,
  });
  inp.value = '';
}

function handleDmKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDm(); }
}

// â”€â”€ Live DM status dot updates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ DM / Group DM sekme deÄŸiÅŸtirici â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// app.js'den taÅŸÄ±ndÄ± (v modÃ¼ler)
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
// sendEncryptedMessage() — gönderici tarafı: alıcının public key'i ile şifreler,
//   ardından socket üzerinden dm:send event'ı atar.
// decryptIncoming()      — alıcı tarafı: gelen msg.e2e verisini çözer ve mesaj
//   elementindeki içeriği günceller.
//
// Kullanım (tarayıcıda):
//   await sendEncryptedMessage("Merhaba!");   // mevcut DM'e gönderir
//   await decryptIncoming(msg, domElement);  // gelen mesajı yerinde çözer
// ──────────────────────────────────────────────────────────────────────────────

// Konuşma başına E2EE durumu
let _dmE2EActive = false;

/**
 * Konuşma değiştiğinde E2EE durumunu sıfırlar ve UI'ı günceller.
 * openDm() tarafından her DM açılışında çağrılır.
 */
function resetDmE2E() {
  _dmE2EActive = false;
  _updateE2EBanner();
}

/**
 * E2EE DM banner'ını ve toggle butonunu mevcut duruma göre günceller.
 * BridgeE2E kurulu ve etkinse buton gösterilir; değilse gizlenir.
 */
function _updateE2EBanner() {
  const banner = document.getElementById('dm-e2e-banner');
  const toggleBtn = document.getElementById('dm-e2e-toggle');

  const e2eAvailable = !!(window as any).BridgeE2E?.getStatus?.().enabled;

  if (toggleBtn) {
    toggleBtn.style.display = e2eAvailable ? '' : 'none';
    toggleBtn.textContent = _dmE2EActive ? '🔒 Şifreli' : '🔓 Şifresiz';
    toggleBtn.title = _dmE2EActive
      ? 'E2EE aktif — tıklayarak kapat'
      : 'E2EE kapalı — tıklayarak aç';
    toggleBtn.classList.toggle('e2e-active', _dmE2EActive);
  }

  if (banner) {
    banner.style.display = _dmE2EActive ? 'flex' : 'none';
  }
}

/**
 * E2EE modunu açar/kapatır (toggle). DM giriş alanındaki kilit butonu tarafından çağrılır.
 */
function toggleDmE2E() {
  const e2eAvailable = !!(window as any).BridgeE2E?.getStatus?.().enabled;
  if (!e2eAvailable) {
    (window as any).toast?.('E2EE bu cihazda kurulmamış', 'error');
    return;
  }
  _dmE2EActive = !_dmE2EActive;
  _updateE2EBanner();
}
(window as any).toggleDmE2E = toggleDmE2E;

/**
 * Mevcut açık DM'e E2EE ile şifrelenmiş mesaj gönderir.
 * BridgeE2E kurulu ve alıcının public key'i varsa şifreli gönderir,
 * aksi hâlde düz metin olarak gönderir (sessiz fallback).
 */
async function sendEncryptedMessage(plaintext: string): Promise<void> {
  if (!currentDm) throw new Error('[E2EE] Açık bir DM konuşması yok');
  if (!plaintext || plaintext.length > 2000) throw new Error('[E2EE] Geçersiz mesaj');

  const recipientId = currentDm.participants?.find((p: string) => p !== (window as any).me?.id);
  if (!recipientId) throw new Error('[E2EE] Alıcı bulunamadı');

  let finalContent = plaintext;
  let e2eData: any = null;

  if ((window as any).BridgeE2E?.getStatus?.().enabled) {
    try {
      const encrypted = await (window as any).BridgeE2E.encryptDM(
        plaintext, recipientId, (window as any).me.id
      );
      if (encrypted.encrypted) {
        finalContent = encrypted.content; // "🔒 Şifreli mesaj"
        e2eData = encrypted.e2e;
      }
    } catch (err: any) {
      console.warn('[E2EE] sendEncryptedMessage — şifreleme başarısız, düz metin gönderiliyor:', err.message);
    }
  }

  // socket global olarak tanımlı (diğer DM fonksiyonlarıyla tutarlı)
  (socket as any).emit('dm:send', {
    toUserId: recipientId,
    content: finalContent,
    e2e: e2eData,
  });

  // Input'u temizle (sendDm() ile tutarlı)
  const inp = document.getElementById('dm-input') as HTMLInputElement | null;
  if (inp) inp.value = '';
}

/**
 * Gelen bir DM mesajının e2e alanını çözer ve verilen DOM elementinin
 * `.dm-msg-text` içeriğini günceller.
 * Çözme başarılı olursa düz metin döner, aksi hâlde null.
 */
async function decryptIncoming(
  msg: { e2e?: any; userId?: string; content?: string },
  el: HTMLElement
): Promise<string | null> {
  if (!msg.e2e) return null; // Şifresiz mesaj — dokunma

  const myUserId = (window as any).me?.id;
  if (!myUserId) return null;

  // BridgeE2E yoksa veya kapalıysa
  if (!(window as any).BridgeE2E?.getStatus?.().enabled) {
    console.warn('[E2EE] decryptIncoming — E2EE etkin değil');
    return null;
  }

  try {
    const plaintext = await (window as any).BridgeE2E.decryptDM(msg.e2e, myUserId);
    if (!plaintext) return null;

    // DOM'u yerinde güncelle
    const textEl = el.querySelector('.dm-msg-text') as HTMLElement | null;
    if (textEl) textEl.innerHTML = (window as any).formatText?.(plaintext) ?? plaintext;

    return plaintext;
  } catch (err: any) {
    console.warn('[E2EE] decryptIncoming — şifre çözme hatası:', err.message);
    return null;
  }
}

// Dışa aç (vanilla-JS bundle'ı için window'a da yaz)
(window as any).sendEncryptedMessage = sendEncryptedMessage;
(window as any).decryptIncoming      = decryptIncoming;
