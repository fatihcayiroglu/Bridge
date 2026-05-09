// client/js/core/friends.js
// misc.js'den Ã§Ä±karÄ±ldÄ±: ArkadaÅŸ sistemi, voice activity, status

'use strict';
export {};

// â”€â”€ ARKADAÅLAR PANELÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openFriendsPanel() {
  document.getElementById('friends-panel').style.display = 'flex';
  loadFriends();
}

function closeFriendsPanel() {
  document.getElementById('friends-panel').style.display = 'none';
}

function switchFriendsTab(tab, btn) {
  document.querySelectorAll('.fn-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  renderFriendsTab(tab);
}

async function loadFriends() {
  try {
    const [fr, pr] = await Promise.all([
      apiFetch(`${API}/api/friends`).then(r => r.json()),
      apiFetch(`${API}/api/friends/pending`).then(r => r.json()),
    ]);
    friendsList    = fr;
    pendingRequests = pr;

    // Pending badge
    const badge = document.getElementById('pending-badge');
    if (badge) {
      badge.textContent = pr.length;
      badge.style.display = pr.length ? '' : 'none';
    }

    renderFriendsTab('online');
  } catch { toast('ArkadaÅŸlar yÃ¼klenemedi', 'error'); }
}

function renderFriendsTab(tab) {
  const list = document.getElementById('friends-list');
  if (!list) return;

  if (tab === 'add') {
    list.innerHTML = `
      <div style="padding:16px">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">KullanÄ±cÄ± adÄ± ile arkadaÅŸ ekle:</p>
        <div style="display:flex;gap:8px">
          <input id="friend-add-input" type="text" placeholder="kullanici_adi"
            class="input" style="flex:1;"
            onkeydown="if(event.key==='Enter')sendFriendRequest()">
          <button class="btn" onclick="sendFriendRequest()">GÃ¶nder</button>
        </div>
      </div>`;
    return;
  }

  let displayed = [];

  if (tab === 'pending') {
    displayed = pendingRequests;
  } else if (tab === 'all') {
    displayed = friendsList;
  } else { // online
    displayed = friendsList.filter(f => f.status && f.status !== 'offline');
  }

  if (!displayed.length) {
    const emptyMsg = {
      online:  'ğŸ˜´ Åu an Ã§evrimiÃ§i arkadaÅŸÄ±n yok',
      all:     'ğŸ‘¥ HenÃ¼z arkadaÅŸÄ±n yok',
      pending: 'âœ… Bekleyen istek yok',
    };
    list.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);">
      <div style="font-size:32px;margin-bottom:8px">${tab === 'online' ? 'ğŸ˜´' : tab === 'all' ? 'ğŸ‘¥' : 'âœ…'}</div>
      <p>${emptyMsg[tab] || ''}</p>
    </div>`;
    return;
  }

  if (tab === 'pending') {
    list.innerHTML = displayed.map(req => `
      <div class="friend-item">
        <div class="friend-avatar" style="background:${req.avatarColor || '#4f8ef7'}">${initials(req.displayName)}</div>
        <div class="friend-info">
          <div class="friend-name">${escHtml(req.displayName)}</div>
          <div class="friend-status">@${escHtml(req.username)}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:12px;" onclick="acceptFriend('${req._id}')">âœ…</button>
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="rejectFriend('${req._id}')">âœ•</button>
        </div>
      </div>`).join('');
  } else {
    list.innerHTML = displayed.map(f => {
      const statusColors = { online: 'var(--green)', idle: 'var(--yellow)', dnd: 'var(--red)', offline: 'var(--text-muted)' };
      const statusLabels = { online: 'Ã‡evrimiÃ§i', idle: 'Uzakta', dnd: 'RahatsÄ±z Etme', offline: 'Ã‡evrimdÄ±ÅŸÄ±' };
      const activity = f.activity ? ` â€¢ ${f.activity.name || ''}` : '';
      return `
        <div class="friend-item">
          <div style="position:relative">
            <div class="friend-avatar" style="background:${f.avatarColor || '#4f8ef7'}">${initials(f.displayName)}</div>
            <div style="position:absolute;bottom:-2px;right:-2px;width:12px;height:12px;border-radius:50%;background:${statusColors[f.status] || 'var(--text-muted)'};border:2px solid var(--bg-2)"></div>
          </div>
          <div class="friend-info">
            <div class="friend-name">${escHtml(f.displayName)}</div>
            <div class="friend-status" style="color:${statusColors[f.status] || 'var(--text-muted)'}">
              ${statusLabels[f.status] || 'Ã‡evrimdÄ±ÅŸÄ±'}${escHtml(activity)}
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="icon-btn" title="Mesaj gÃ¶nder" onclick="openDmWithUser('${f._id}','${escHtml(f.displayName)}','${f.avatarColor || '#4f8ef7'}')">ğŸ’¬</button>
            <button class="icon-btn" title="ArkadaÅŸlÄ±ktan Ã§Ä±kar" onclick="removeFriend('${f._id}','${escHtml(f.displayName)}')">âœ•</button>
          </div>
        </div>`;
    }).join('');
  }
}

async function sendFriendRequest() {
  const username = document.getElementById('friend-add-input')?.value?.trim();
  if (!username) return toast('KullanÄ±cÄ± adÄ± gerekli', 'error');
  try {
    const r    = await apiFetch(`${API}/api/friends/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Hata', 'error');
    toast(`${username} kullanÄ±cÄ±sÄ±na istek gÃ¶nderildi!`, 'success');
    const input = document.getElementById('friend-add-input');
    if (input) input.value = '';
  } catch { toast('BaÄŸlantÄ± hatasÄ±', 'error'); }
}

async function acceptFriend(userId) {
  try {
    const r = await apiFetch(`${API}/api/friends/accept/${userId}`, { method: 'POST' });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Hata', 'error');
    toast('ArkadaÅŸlÄ±k isteÄŸi kabul edildi!', 'success');
    await loadFriends();
  } catch { toast('Hata', 'error'); }
}

async function rejectFriend(userId) {
  try {
    const r = await apiFetch(`${API}/api/friends/reject/${userId}`, { method: 'POST' });
    if (!r.ok) return toast('Hata', 'error');
    toast('Ä°stek reddedildi', 'info');
    await loadFriends();
  } catch { toast('Hata', 'error'); }
}

async function removeFriend(userId, displayName) {
  if (!confirm(`${displayName} ile arkadaÅŸlÄ±ÄŸÄ± bitir?`)) return;
  try {
    const r = await apiFetch(`${API}/api/friends/${userId}`, { method: 'DELETE' });
    if (!r.ok) return toast('Hata', 'error');
    toast('ArkadaÅŸlÄ±k sonlandÄ±rÄ±ldÄ±', 'info');
    await loadFriends();
  } catch { toast('Hata', 'error'); }
}

// â”€â”€ VOICE ACTIVITY DETECTOR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startVoiceActivityDetection(stream) {
  try {
    const ctx     = new AudioContext();
    const source  = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;

    const tick = () => {
      analyser.getByteFrequencyData(data);
      const avg       = data.reduce((a, b) => a + b, 0) / data.length;
      const isSpeaking = avg > 15;
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        if (socket?.currentVoiceChannel) {
          socket.emit('voice:activity', { channelId: socket.currentVoiceChannel, speaking });
        }
        const myPeerEl = document.querySelector('.voice-peer.local');
        if (myPeerEl) myPeerEl.classList.toggle('speaking', speaking);
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch { /* AudioContext kullanÄ±lamÄ±yor */ }
}

// â”€â”€ RICH STATUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openStatusPicker(e) {
  e?.stopPropagation();
  const picker = document.getElementById('status-picker');
  if (!picker) return;
  const rect = document.getElementById('my-status-dot')?.getBoundingClientRect() || { bottom: 100, left: 100 };
  picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  picker.style.left   = rect.left + 'px';
  picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
  const stInput = document.getElementById('status-text-input');
  if (stInput) stInput.value = currentStatusText || '';
  setTimeout(() => document.addEventListener('click', () => { picker.style.display = 'none'; }, { once: true }), 50);
}

function setRichStatus(status) {
  const stInput  = document.getElementById('status-text-input');
  const statusText = stInput?.value || '';
  currentStatusText = statusText;
  socket?.emit('status:update', { status, statusText, statusEmoji: '' });
  const myDot = document.getElementById('my-status-dot');
  if (myDot) myDot.className = `status-dot ${status === 'offline' ? 'offline' : status}`;
  const myTag = document.getElementById('my-tag');
  if (myTag) myTag.textContent = statusText || status;
  document.getElementById('status-picker').style.display = 'none';
  toast('Durum gÃ¼ncellendi', 'success');
}

function saveStatusText() {
  const val = document.getElementById('status-text-input')?.value || '';
  currentStatusText = val;
  socket?.emit('status:update', { status: 'online', statusText: val, statusEmoji: '' });
  document.getElementById('status-picker').style.display = 'none';
  const myTag = document.getElementById('my-tag');
  if (myTag) myTag.textContent = val || 'Online';
  toast('Durum mesajÄ± gÃ¼ncellendi', 'success');
}

// â”€â”€ STATUS DOT CLICK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function initStatusPicker() {
  const dot = document.getElementById('my-status-dot');
  if (dot) dot.addEventListener('click', openStatusPicker);
}

// CSS â€” friend list styles
const friendStyle = document.createElement('style');
friendStyle.textContent = `
  .friend-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .friend-item:hover { background: var(--bg-hover); }
  .friend-avatar {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 13px;
    font-weight: 700;
    color: white;
    flex-shrink: 0;
  }
  .friend-info { flex: 1; min-width: 0; }
  .friend-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .friend-status { font-size: 12px; color: var(--text-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
document.head.appendChild(friendStyle);

