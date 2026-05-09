// client/js/core/group-dm.js
// Grup DM: liste, oluÅŸturma, mesajlaÅŸma, Ã¼ye yÃ¶netimi, sesli/gÃ¶rÃ¼ntÃ¼lÃ¼ arama

'use strict';
export {};

let currentGroupDm    = null;
let _gdmGroups        = [];

// â”€â”€ GDM Voice Call State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _gdmCallActive    = false;   // aramada mÄ±yÄ±z?
let _gdmCallGroupId   = null;    // hangi grup
let _gdmCallType      = 'voice'; // 'voice' | 'video'
let _gdmCallPeers     = new Map(); // socketId â†’ { userId, displayName, avatarColor, stream, pc }
let _gdmLocalStream   = null;
const GDM_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// â”€â”€ Panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openGroupDmPanel() {
  document.getElementById('dm-panel').style.display = 'flex';
  loadGroupDmList();
}

async function loadGroupDmList() {
  const r = await apiFetch(`${API}/api/gdm`);
  if (!r.ok) return;
  _gdmGroups = await r.json();
  renderGroupDmList();
}

function renderGroupDmList() {
  const container = document.getElementById('gdm-list');
  if (!container) return;
  container.innerHTML = '';

  if (!_gdmGroups.length) {
    container.innerHTML = '<div style="padding:10px 12px;color:var(--text-muted);font-size:13px">Grup DM yok. <a href="#" onclick="openCreateGroupDmModal();return false" style="color:var(--brand)">OluÅŸtur â†’</a></div>';
    return;
  }

  for (const g of _gdmGroups) {
    const el = document.createElement('div');
    el.className = 'dm-item';
    el.dataset.gid = g._id;
    const preview = g.lastMessage?.content
      ? escHtml(g.lastMessage.content.slice(0, 40))
      : '<span style="color:var(--text-muted)">HenÃ¼z mesaj yok</span>';
    el.innerHTML = `
      <div style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:18px">
        ${g.icon || 'ğŸ‘¥'}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);flex-shrink:0">${g.memberCount || 0} Ã¼ye</div>`;
    el.onclick = () => openGroupDm(g);
    container.appendChild(el);
  }
}

// â”€â”€ Open / Switch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openGroupDm(group) {
  currentGroupDm = group;

  // Show DM panel (reuse existing panel structure)
  document.getElementById('dm-panel').style.display = 'flex';
  if (header) {
    header.innerHTML = `
      <span style="font-size:18px">${group.icon || 'ğŸ‘¥'}</span>
      <span style="font-weight:700;font-size:15px;margin-left:6px">${escHtml(group.name)}</span>
      <span style="font-size:12px;color:var(--text-muted);margin-left:8px">${group.memberCount || group.members?.length || 0} Ã¼ye</span>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn btn-sm" onclick="openGroupDmInfo()" title="Grup bilgisi">â„¹ï¸</button>
        ${group.ownerId === me?.id ? `<button class="btn btn-sm" onclick="openGroupDmSettings()" title="Ayarlar">âš™ï¸</button>` : ''}
        <button class="btn btn-sm" style="color:var(--danger)" onclick="leaveGroupDm('${group._id}')" title="${group.ownerId === me?.id ? 'Grubu daÄŸÄ±t' : 'Gruptan ayrÄ±l'}">ğŸšª</button>
      </div>`;
  }

  // Hide 1:1 DM call buttons â€” GDM has its own call UI
  const voiceBtn = document.getElementById('dm-call-voice-btn');
  const videoBtn = document.getElementById('dm-call-video-btn');
  if (voiceBtn) voiceBtn.style.display = 'none';
  if (videoBtn) videoBtn.style.display = 'none';

  // GDM call buttons â€” header'a eklendi
  const existingCallBar = document.getElementById('gdm-call-bar');
  if (existingCallBar) existingCallBar.remove();

  const header = document.getElementById('dm-chat-header');
  if (header) {
    // Call buttons â€” header actions area'ya ekle
    const actions = header.querySelector('div[style*="margin-left:auto"]');
    if (actions) {
      // Mevcut arama butonu varsa temizle
      actions.querySelectorAll('.gdm-call-btn').forEach(b => b.remove());
      const vBtn = document.createElement('button');
      vBtn.className = 'btn btn-sm gdm-call-btn';
      vBtn.title = 'Sesli Arama';
      vBtn.innerHTML = 'ğŸ™ï¸';
      vBtn.onclick = () => startGdmCall('voice');

      const vidBtn = document.createElement('button');
      vidBtn.className = 'btn btn-sm gdm-call-btn';
      vidBtn.title = 'GÃ¶rÃ¼ntÃ¼lÃ¼ Arama';
      vidBtn.innerHTML = 'ğŸ“¹';
      vidBtn.onclick = () => startGdmCall('video');

      actions.prepend(vidBtn);
      actions.prepend(vBtn);
    }
  }

  socket.emit('gdm:join', group._id);
  await loadGroupDmMessages(group._id);
}

async function loadGroupDmMessages(groupId) {
  const area = document.getElementById('dm-messages');
  if (!area) return;
  area.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">YÃ¼kleniyor...</div>';

  const r = await apiFetch(`${API}/api/gdm/${groupId}/messages?limit=50`);
  const messages = r.ok ? await r.json() : [];
  area.innerHTML = '';
  for (const msg of messages) area.appendChild(renderGdmMessage(msg));
  area.scrollTop = area.scrollHeight;
  document.getElementById('dm-input-area').style.display = 'flex';
}

function renderGdmMessage(msg) {
  const el = document.createElement('div');
  const isOwn = msg.userId === me?.id;
  el.className = 'dm-msg' + (isOwn ? ' dm-own' : '');

  if (msg.type === 'system') {
    el.className = '';
    el.style.cssText = 'text-align:center;color:var(--text-muted);font-size:12px;padding:4px 0;font-style:italic';
    el.textContent = msg.content;
    return el;
  }

  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="dm-msg-avatar" style="background:${cssColor(msg.avatarColor)}">${initials(msg.displayName)}</div>
    <div class="dm-msg-body">
      <div class="dm-msg-header">
        <span class="dm-msg-name">${escHtml(msg.displayName)}</span>
        <span class="dm-msg-time">${time}</span>
      </div>
      <div class="dm-msg-text">${formatText(msg.content)}</div>
    </div>`;
  return el;
}

function sendGroupDm() {
  if (!currentGroupDm) return;
  const inp = document.getElementById('dm-input');
  const content = inp.value.trim();
  if (!content) return;
  if (content.length > 2000) return toast('Mesaj Ã§ok uzun', 'error');
  socket.emit('gdm:send', { groupId: currentGroupDm._id, content });
  inp.value = '';
}

// â”€â”€ Create Group DM Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openCreateGroupDmModal() {
  _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:95%">
      <h2>ğŸ‘¥ Yeni Grup DM</h2>
      <div class="form-group">
        <label>Grup AdÄ±</label>
        <input type="text" id="gdm-name-input" class="input-field" placeholder="ArkadaÅŸlarÄ±m..." maxlength="64">
      </div>
      <div class="form-group">
        <label>Emoji (opsiyonel)</label>
        <input type="text" id="gdm-icon-input" class="input-field" placeholder="ğŸ‘¥" maxlength="4" style="width:80px">
      </div>
      <div class="form-group">
        <label>Ãœyeler (kullanÄ±cÄ± adÄ±, virgÃ¼lle ayÄ±r)</label>
        <input type="text" id="gdm-members-input" class="input-field" placeholder="ali, veli, ...">
        <div id="gdm-members-preview" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="gdm-create-btn">OluÅŸtur</button>
        <button class="btn" onclick="_destroyTempModal()">Ä°ptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
  document.getElementById('gdm-name-input').focus();
  document.getElementById('gdm-create-btn').onclick = createGroupDm;
}

async function createGroupDm() {
  const name = (document.getElementById('gdm-name-input') as HTMLInputElement | null)?.value ?? ''.trim();
  const icon = (document.getElementById('gdm-icon-input') as HTMLInputElement | null)?.value ?? ''.trim();
  const raw  = (document.getElementById('gdm-members-input') as HTMLInputElement | null)?.value ?? ''.trim();

  if (!name) return toast('Grup adÄ± gerekli', 'error');
  if (!raw)  return toast('En az 1 Ã¼ye ekle', 'error');

  // Resolve usernames to IDs
  const usernames = raw.split(',').map(u => u.trim()).filter(Boolean);
  const memberIds = [];
  for (const uname of usernames) {
    // Use friends list if available, otherwise search
    const found = (window._friendsCache || []).find(f => f.username?.toLowerCase() === uname.toLowerCase());
    if (found) { memberIds.push(found._id || found.id); continue; }
    toast(`"${uname}" bulunamadÄ± â€” Ã¶nce arkadaÅŸ olmalÄ±sÄ±nÄ±z`, 'warning');
    return;
  }

  const btn = document.getElementById('gdm-create-btn');
  btn.disabled = true;
  btn.textContent = 'OluÅŸturuluyor...';

  const r = await apiFetch(`${API}/api/gdm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon: icon || null, memberIds }),
  });
  const data = await r.json();
  if (!r.ok) { toast(data.error || 'OluÅŸturulamadÄ±', 'error'); btn.disabled = false; btn.textContent = 'OluÅŸtur'; return; }

  _destroyTempModal();
  toast(`"${name}" grubu oluÅŸturuldu! ğŸ‰`, 'success');
  await loadGroupDmList();
  openGroupDm(data);
}

// â”€â”€ Group Info Popover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openGroupDmInfo() {
  if (!currentGroupDm) return;
  _destroyTempModal();
  const g = currentGroupDm;
  const members = g.members || [];
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:360px;width:95%">
      <h2>${g.icon || 'ğŸ‘¥'} ${escHtml(g.name)}</h2>
      <p style="color:var(--text-muted);font-size:13px">${members.length} Ã¼ye Â· ${g.ownerId === me?.id ? 'Sen sahipsin' : 'Ãœyesin'}</p>
      <div style="max-height:240px;overflow-y:auto;margin:12px 0">
        ${members.map(u => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="width:32px;height:32px;border-radius:50%;background:${cssColor(u.avatarColor)};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0">${initials(u.displayName)}</div>
            <span style="font-size:14px">${escHtml(u.displayName)}</span>
            ${u._id === g.ownerId ? '<span style="font-size:11px;background:var(--brand);color:#fff;border-radius:3px;padding:1px 5px;margin-left:auto">Sahip</span>' : ''}
            ${g.ownerId === me?.id && u._id !== me?.id ? `<button class="btn btn-sm" style="color:var(--danger);margin-left:auto;font-size:11px" onclick="kickGroupDmMember('${g._id}','${u._id}','${escHtml(u.displayName)}')">Ã‡Ä±kar</button>` : ''}
          </div>`).join('')}
      </div>
      ${g.ownerId === me?.id ? `
      <div style="margin-top:8px">
        <input type="text" id="gdm-add-member" class="input-field" placeholder="KullanÄ±cÄ± adÄ± ekle..." style="width:100%;margin-bottom:6px">
        <button class="btn btn-primary" style="width:100%" onclick="addGroupDmMember('${g._id}')">+ Ãœye Ekle</button>
      </div>` : ''}
      <div class="modal-footer"><button class="btn" onclick="_destroyTempModal()">Kapat</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
}

async function addGroupDmMember(groupId) {
  const uname = (document.getElementById('gdm-add-member') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!uname) return;
  const found = (window._friendsCache || []).find(f => f.username?.toLowerCase() === uname.toLowerCase());
  if (!found) return toast(`"${uname}" bulunamadÄ±`, 'error');

  const r = await apiFetch(`${API}/api/gdm/${groupId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: found._id || found.id }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Eklenemedi', 'error');
  toast(`${uname} gruba eklendi!`, 'success');
  _destroyTempModal();
  // Refresh group
  const gr = await apiFetch(`${API}/api/gdm/${groupId}`);
  if (gr.ok) { currentGroupDm = await gr.json(); openGroupDmInfo(); }
}

async function kickGroupDmMember(groupId, userId, name) {
  if (!confirm(`${name} kullanÄ±cÄ±sÄ±nÄ± gruptan Ã§Ä±karmak istediÄŸinizden emin misiniz?`)) return;
  const r = await apiFetch(`${API}/api/gdm/${groupId}/members/${userId}`, { method: 'DELETE' });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Ã‡Ä±karÄ±lamadÄ±', 'error');
  toast(`${name} gruptan Ã§Ä±karÄ±ldÄ±`, 'success');
  _destroyTempModal();
  await loadGroupDmList();
  if (currentGroupDm?._id === groupId) {
    const gr = await apiFetch(`${API}/api/gdm/${groupId}`);
    if (gr.ok) currentGroupDm = await gr.json();
  }
}

// â”€â”€ Group DM Settings (rename/icon) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openGroupDmSettings() {
  if (!currentGroupDm || currentGroupDm.ownerId !== me?.id) return;
  _destroyTempModal();
  const g = currentGroupDm;
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:380px;width:95%">
      <h2>âš™ï¸ Grup AyarlarÄ±</h2>
      <div class="form-group">
        <label>Grup AdÄ±</label>
        <input type="text" id="gdm-settings-name" class="input-field" value="${escHtml(g.name)}" maxlength="64">
      </div>
      <div class="form-group">
        <label>Emoji</label>
        <input type="text" id="gdm-settings-icon" class="input-field" value="${escHtml(g.icon || '')}" maxlength="4" style="width:80px">
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveGroupDmSettings('${g._id}')">Kaydet</button>
        <button class="btn" onclick="_destroyTempModal()">Ä°ptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
}

async function saveGroupDmSettings(groupId) {
  const name = (document.getElementById('gdm-settings-name') as HTMLInputElement | null)?.value ?? ''.trim();
  const icon = (document.getElementById('gdm-settings-icon') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!name) return toast('Grup adÄ± boÅŸ olamaz', 'error');

  const r = await apiFetch(`${API}/api/gdm/${groupId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon: icon || null }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'GÃ¼ncellenemedi', 'error');

  currentGroupDm = { ...currentGroupDm, name, icon };
  toast('Grup gÃ¼ncellendi', 'success');
  _destroyTempModal();
  await loadGroupDmList();
  openGroupDm(currentGroupDm);
}

async function leaveGroupDm(groupId) {
  const g = currentGroupDm;
  const msg = g?.ownerId === me?.id
    ? 'Grubu daÄŸÄ±tmak istediÄŸinizden emin misiniz? TÃ¼m mesajlar silinecek.'
    : 'Gruptan ayrÄ±lmak istediÄŸinizden emin misiniz?';
  if (!confirm(msg)) return;

  const r = g?.ownerId === me?.id
    ? await apiFetch(`${API}/api/gdm/${groupId}`, { method: 'DELETE' })
    : await apiFetch(`${API}/api/gdm/${groupId}/members/${me.id}`, { method: 'DELETE' });

  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Ä°ÅŸlem baÅŸarÄ±sÄ±z', 'error');

  currentGroupDm = null;
  document.getElementById('dm-chat-header').textContent = '';
  document.getElementById('dm-messages').innerHTML = '';
  document.getElementById('dm-input-area').style.display = 'none';
  toast(g?.ownerId === me?.id ? 'Grup daÄŸÄ±tÄ±ldÄ±' : 'Gruptan ayrÄ±ldÄ±nÄ±z', 'success');
  await loadGroupDmList();
}

// â”€â”€ GDM Voice Call UI & WebRTC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _gdmCallBar() {
  let bar = document.getElementById('gdm-call-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'gdm-call-bar';
    bar.style.cssText = [
      'position:fixed;bottom:0;left:0;right:0;z-index:9000',
      'background:var(--bg-2,#2b2d31);border-top:1px solid var(--border,#3f4147)',
      'display:flex;align-items:center;gap:8px;padding:8px 16px',
      'min-height:56px',
    ].join(';');
    document.body.appendChild(bar);
  }
  return bar;
}

function _renderCallBar() {
  const bar = _gdmCallBar();
  const g = _gdmGroups.find(g => g._id === _gdmCallGroupId) || currentGroupDm || {};
  const icon = _gdmCallType === 'video' ? 'ğŸ“¹' : 'ğŸ™ï¸';
  const peerCount = _gdmCallPeers.size;

  bar.innerHTML = `
    <span style="font-size:18px">${icon}</span>
    <span style="font-weight:600;font-size:13px">${escHtml(g.name || 'Grup AramasÄ±')}</span>
    <span id="gdm-call-timer" style="font-size:12px;color:var(--text-muted,#9d9fa8);min-width:40px">0:00</span>
    <div id="gdm-call-peers-bar" style="display:flex;gap:4px;flex:1;overflow:hidden"></div>
    <button id="gdm-call-mute-btn" class="btn btn-sm" title="Mikrofon" style="font-size:16px">ğŸ™ï¸</button>
    ${_gdmCallType === 'video' ? '<button id="gdm-call-video-toggle" class="btn btn-sm" title="Kamera" style="font-size:16px">ğŸ“¹</button>' : ''}
    <button id="gdm-call-expand-btn" class="btn btn-sm" title="BÃ¼yÃ¼t" style="font-size:16px" onclick="openGdmCallModal()">â›¶</button>
    <button class="btn btn-sm" style="background:var(--danger,#ed4245);color:#fff;padding:6px 14px;font-weight:700" onclick="leaveGdmCall()">Kapat</button>
  `;
  bar.style.display = 'flex';

  // Mute toggle
  let _muted = false;
  document.getElementById('gdm-call-mute-btn')?.addEventListener('click', () => {
    _muted = !_muted;
    if (_gdmLocalStream) {
      _gdmLocalStream.getAudioTracks().forEach(t => { t.enabled = !_muted; });
    }
    const btn = document.getElementById('gdm-call-mute-btn');
    if (btn) btn.textContent = _muted ? 'ğŸ”‡' : 'ğŸ™ï¸';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: _muted, video: _gdmCallType === 'video' });
  });

  // Video toggle
  let _videoOff = false;
  document.getElementById('gdm-call-video-toggle')?.addEventListener('click', () => {
    _videoOff = !_videoOff;
    if (_gdmLocalStream) {
      _gdmLocalStream.getVideoTracks().forEach(t => { t.enabled = !_videoOff; });
    }
    const btn = document.getElementById('gdm-call-video-toggle');
    if (btn) btn.textContent = _videoOff ? 'ğŸš«' : 'ğŸ“¹';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: false, video: !_videoOff });
  });

  _renderCallPeersBar();
  _startCallTimer();
}

let _callTimerInterval = null;
let _callStartTime     = null;

function _startCallTimer() {
  clearInterval(_callTimerInterval);
  _callStartTime = Date.now();
  _callTimerInterval = setInterval(() => {
    const el = document.getElementById('gdm-call-timer');
    if (!el) return;
    const s = Math.floor((Date.now() - _callStartTime) / 1000);
    const m = Math.floor(s / 60);
    el.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function _renderCallPeersBar() {
  const bar = document.getElementById('gdm-call-peers-bar');
  if (!bar) return;
  bar.innerHTML = '';
  for (const [socketId, peer] of _gdmCallPeers) {
    const dot = document.createElement('div');
    dot.dataset.gdmPeer = socketId;
    dot.title = peer.displayName || '';
    dot.style.cssText = [
      `width:28px;height:28px;border-radius:50%`,
      `background:${cssColor(peer.avatarColor)};color:#fff`,
      `display:flex;align-items:center;justify-content:center`,
      `font-size:11px;font-weight:700;flex-shrink:0`,
      `border:2px solid transparent;transition:border-color .15s`,
    ].join(';');
    dot.textContent = initials(peer.displayName || '?');
    if (peer.muted) dot.style.opacity = '0.5';
    bar.appendChild(dot);
  }
}

// â”€â”€ Expanded Call Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function openGdmCallModal() {
  _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.style.zIndex = '9500';

  const g = _gdmGroups.find(g => g._id === _gdmCallGroupId) || currentGroupDm || {};
  const icon = _gdmCallType === 'video' ? 'ğŸ“¹' : 'ğŸ™ï¸';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:600px;width:95%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="font-size:20px">${icon}</span>
        <h2 style="margin:0">${escHtml(g.name || 'Grup AramasÄ±')}</h2>
        <span id="gdm-modal-timer" style="font-size:13px;color:var(--text-muted);margin-left:8px">0:00</span>
        <button class="btn btn-sm" style="margin-left:auto" onclick="_destroyTempModal()">âœ•</button>
      </div>
      <div id="gdm-call-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;flex:1;overflow-y:auto;padding-bottom:8px"></div>
      <div style="display:flex;gap:8px;justify-content:center;padding-top:12px;border-top:1px solid var(--border)">
        <button class="btn btn-sm" id="gdm-modal-mute">ğŸ™ï¸ Mikrofon</button>
        ${_gdmCallType === 'video' ? '<button class="btn btn-sm" id="gdm-modal-video">ğŸ“¹ Kamera</button>' : ''}
        <button class="btn btn-sm" style="background:var(--danger);color:#fff" onclick="leaveGdmCall();_destroyTempModal()">ğŸ“µ Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };

  _renderCallGrid();

  // Sync timer
  const syncTimer = setInterval(() => {
    const el = document.getElementById('gdm-modal-timer');
    if (!el) { clearInterval(syncTimer); return; }
    if (!_callStartTime) return;
    const s = Math.floor((Date.now() - _callStartTime) / 1000);
    el.textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }, 1000);

  // Mute/video controls in modal
  let _muted = false, _videoOff = false;
  document.getElementById('gdm-modal-mute')?.addEventListener('click', function() {
    _muted = !_muted;
    if (_gdmLocalStream) _gdmLocalStream.getAudioTracks().forEach(t => { t.enabled = !_muted; });
    this.textContent = _muted ? 'ğŸ”‡ Mikrofon' : 'ğŸ™ï¸ Mikrofon';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: _muted, video: _gdmCallType === 'video' && !_videoOff });
  });
  document.getElementById('gdm-modal-video')?.addEventListener('click', function() {
    _videoOff = !_videoOff;
    if (_gdmLocalStream) _gdmLocalStream.getVideoTracks().forEach(t => { t.enabled = !_videoOff; });
    this.textContent = _videoOff ? 'ğŸš« Kamera' : 'ğŸ“¹ Kamera';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: _muted, video: !_videoOff });
  });
}

function _renderCallGrid() {
  const grid = document.getElementById('gdm-call-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Local tile
  const localTile = _makePeerTile({
    socketId:    'local',
    userId:      me?.id,
    displayName: me?.displayName || 'Sen',
    avatarColor: me?.avatarColor || '#5865f2',
    stream:      _gdmLocalStream,
    isLocal:     true,
    muted:       false,
  });
  grid.appendChild(localTile);

  // Remote peers
  for (const [socketId, peer] of _gdmCallPeers) {
    grid.appendChild(_makePeerTile({ ...peer, socketId }));
  }
}

function _makePeerTile({ socketId, displayName, avatarColor, stream, isLocal, muted }) {
  const tile = document.createElement('div');
  tile.dataset.gdmTile = socketId;
  tile.style.cssText = [
    'border-radius:8px;background:var(--bg-3,#1e1f22);overflow:hidden',
    'aspect-ratio:4/3;position:relative;display:flex;align-items:center;justify-content:center',
  ].join(';');

  const hasVideo = stream && stream.getVideoTracks().some(t => t.enabled);
  if (hasVideo && stream) {
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = !!isLocal;
    vid.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
    vid.srcObject = stream;
    tile.appendChild(vid);
  } else {
    const avatar = document.createElement('div');
    avatar.style.cssText = [
      `width:64px;height:64px;border-radius:50%`,
      `background:${cssColor(avatarColor)};color:#fff`,
      `display:flex;align-items:center;justify-content:center`,
      `font-size:24px;font-weight:700`,
    ].join(';');
    avatar.textContent = initials(displayName || '?');
    tile.appendChild(avatar);
  }

  // Name bar
  const nameBar = document.createElement('div');
  nameBar.style.cssText = [
    'position:absolute;bottom:0;left:0;right:0;padding:4px 8px',
    'background:rgba(0,0,0,.55);display:flex;align-items:center;gap:4px',
    'font-size:12px;color:#fff',
  ].join(';');
  nameBar.innerHTML = `
    <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(displayName || '?')}${isLocal ? ' (Sen)' : ''}</span>
    <span class="gdm-peer-mute-icon" style="display:${muted ? 'inline' : 'none'}">ğŸ”‡</span>
  `;
  tile.appendChild(nameBar);

  // Speaking ring (driven by voice:activity-like event, wired below)
  tile.style.outline = '2px solid transparent';
  tile.style.transition = 'outline-color .1s';

  return tile;
}

// â”€â”€ WebRTC helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function _createPeerConnection(socketId, peer) {
  const pc = new RTCPeerConnection({ iceServers: GDM_ICE_SERVERS });

  // Add local tracks
  if (_gdmLocalStream) {
    _gdmLocalStream.getTracks().forEach(track => pc.addTrack(track, _gdmLocalStream));
  }

  // ICE candidates â†’ server relay
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('gdm:call:ice', { groupId: _gdmCallGroupId, targetSocketId: socketId, candidate });
    }
  };

  // Remote stream
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream) return;
    if (_gdmCallPeers.has(socketId)) {
      _gdmCallPeers.get(socketId).stream = stream;
    }
    // Update tile if modal is open
    const tile = document.querySelector(`[data-gdm-tile="${socketId}"]`);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = stream;
    }
    // Audio playback (non-video)
    if (!document.querySelector(`audio[data-gdm-audio="${socketId}"]`)) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.gdmAudio = socketId;
      audio.srcObject = stream;
      document.body.appendChild(audio);
    } else {
      document.querySelector(`audio[data-gdm-audio="${socketId}"]`).srcObject = stream;
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      _removePeer(socketId);
    }
  };

  peer.pc = pc;
  return pc;
}

async function _initiatePeerOffer(socketId) {
  const peer = _gdmCallPeers.get(socketId);
  if (!peer) return;
  const pc = peer.pc || await _createPeerConnection(socketId, peer);
  peer.pc = pc;

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: _gdmCallType === 'video' });
  await pc.setLocalDescription(offer);
  socket.emit('gdm:call:offer', { groupId: _gdmCallGroupId, targetSocketId: socketId, offer });
}

function _removePeer(socketId) {
  const peer = _gdmCallPeers.get(socketId);
  if (!peer) return;
  peer.pc?.close();
  _gdmCallPeers.delete(socketId);
  // Remove audio element
  document.querySelector(`audio[data-gdm-audio="${socketId}"]`)?.remove();
  _renderCallPeersBar();
  const tile = document.querySelector(`[data-gdm-tile="${socketId}"]`);
  tile?.remove();
}

function _stopLocalStream() {
  if (_gdmLocalStream) {
    _gdmLocalStream.getTracks().forEach(t => t.stop());
    _gdmLocalStream = null;
  }
}

function _cleanupCall() {
  for (const [sid, peer] of _gdmCallPeers) {
    peer.pc?.close();
    document.querySelector(`audio[data-gdm-audio="${sid}"]`)?.remove();
  }
  _gdmCallPeers.clear();
  _stopLocalStream();
  clearInterval(_callTimerInterval);
  _callTimerInterval = null;
  _callStartTime     = null;
  _gdmCallActive     = false;
  _gdmCallGroupId    = null;
  const bar = document.getElementById('gdm-call-bar');
  if (bar) bar.remove();
}

// â”€â”€ Public call actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function startGdmCall(type = 'voice') {
  if (!currentGroupDm) return;
  if (_gdmCallActive) return toast('Zaten bir aramadayken baÅŸka arama baÅŸlatÄ±lamaz', 'error');

  try {
    _gdmLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video',
    });
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Mikrofon/kamera izni reddedildi'
      : `Medya eriÅŸim hatasÄ±: ${err.message}`;
    return toast(msg, 'error');
  }

  _gdmCallActive  = true;
  _gdmCallGroupId = currentGroupDm._id;
  _gdmCallType    = type;

  socket.emit('gdm:call:start', { groupId: currentGroupDm._id, type });
}

async function joinGdmCall(groupId, type = 'voice') {
  if (_gdmCallActive) return; // zaten aramada

  try {
    _gdmLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video',
    });
  } catch {
    return toast('Mikrofon/kamera izni gerekli', 'error');
  }

  _gdmCallActive  = true;
  _gdmCallGroupId = groupId;
  _gdmCallType    = type;

  socket.emit('gdm:call:join', { groupId, type });
}

function leaveGdmCall() {
  if (!_gdmCallActive || !_gdmCallGroupId) return;
  socket.emit('gdm:call:leave', { groupId: _gdmCallGroupId });
  _cleanupCall();
}

// â”€â”€ Incoming call popup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _showIncomingCallPopup({ groupId, type, callerDisplayName, callerAvatarColor }) {
  const existing = document.getElementById('gdm-incoming-call');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'gdm-incoming-call';
  popup.style.cssText = [
    'position:fixed;top:16px;right:16px;z-index:9800',
    'background:var(--bg-2,#2b2d31);border:1px solid var(--border,#3f4147)',
    'border-radius:12px;padding:16px 20px;min-width:260px',
    'box-shadow:0 8px 32px rgba(0,0,0,.45)',
    'display:flex;flex-direction:column;gap:10px',
  ].join(';');

  const g = _gdmGroups.find(g => g._id === groupId) || { name: 'Grup AramasÄ±' };
  const icon = type === 'video' ? 'ğŸ“¹' : 'ğŸ™ï¸';

  popup.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:40px;height:40px;border-radius:50%;background:${cssColor(callerAvatarColor)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0">${initials(callerDisplayName)}</div>
      <div>
        <div style="font-weight:700;font-size:14px">${escHtml(callerDisplayName)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${icon} ${escHtml(g.name)} Â· ${type === 'video' ? 'GÃ¶rÃ¼ntÃ¼lÃ¼' : 'Sesli'} arama</div>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-sm" style="flex:1;background:var(--green,#57f287);color:#000;font-weight:700" onclick="joinGdmCall('${groupId}','${type}');document.getElementById('gdm-incoming-call')?.remove()">ğŸ“ YanÄ±tla</button>
      <button class="btn btn-sm" style="flex:1;background:var(--danger,#ed4245);color:#fff;font-weight:700" onclick="document.getElementById('gdm-incoming-call')?.remove()">ğŸ“µ Reddet</button>
    </div>
  `;
  document.body.appendChild(popup);

  // Otomatik kapat 30 sn sonra
  setTimeout(() => popup.remove(), 30_000);
}

// â”€â”€ Socket Events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function bindGroupDmSocketEvents(socket) {
  socket.on('gdm:created', async (group) => {
    const idx = _gdmGroups.findIndex(g => g._id === group._id);
    if (idx === -1) _gdmGroups.unshift(group);
    else _gdmGroups[idx] = group;
    renderGroupDmList();
  });

  socket.on('gdm:message', (msg) => {
    // Update last message in list
    const g = _gdmGroups.find(g => g._id === msg.groupId);
    if (g) { g.lastMessage = msg; renderGroupDmList(); }

    // Append to open conversation
    if (currentGroupDm?._id === msg.groupId) {
      const area = document.getElementById('dm-messages');
      if (area) {
        area.appendChild(renderGdmMessage(msg));
        if (area.scrollHeight - area.scrollTop < 300) area.scrollTop = area.scrollHeight;
      }
    }
  });

  socket.on('gdm:updated', (group) => {
    const idx = _gdmGroups.findIndex(g => g._id === group._id);
    if (idx !== -1) { _gdmGroups[idx] = { ..._gdmGroups[idx], ...group }; renderGroupDmList(); }
    if (currentGroupDm?._id === group._id) currentGroupDm = { ...currentGroupDm, ...group };
  });

  socket.on('gdm:deleted', ({ groupId }) => {
    _gdmGroups = _gdmGroups.filter(g => g._id !== groupId);
    renderGroupDmList();
    if (currentGroupDm?._id === groupId) {
      currentGroupDm = null;
      document.getElementById('dm-messages').innerHTML = '';
      document.getElementById('dm-input-area').style.display = 'none';
    }
  });

  socket.on('gdm:typing', ({ groupId, displayName }) => {
    if (currentGroupDm?._id !== groupId) return;
    const area = document.getElementById('dm-messages');
    if (!area) return;
    let tip = area.querySelector('.gdm-typing-indicator');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'gdm-typing-indicator';
      tip.style.cssText = 'font-size:12px;color:var(--text-muted);padding:4px 12px;font-style:italic';
      area.appendChild(tip);
    }
    tip.textContent = `${escHtml(displayName)} yazÄ±yor...`;
    clearTimeout(tip._timer);
    tip._timer = setTimeout(() => tip.remove(), 3000);
  });

  // â”€â”€ GDM Voice Call Events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Arama baÅŸlatÄ±ldÄ± (biz baÅŸlattÄ±k) â€” call bar gÃ¶ster
  socket.on('gdm:call:started', ({ groupId, type }) => {
    _gdmCallGroupId = groupId;
    _gdmCallType    = type;
    _gdmCallActive  = true;
    _renderCallBar();
  });

  // BaÅŸka biri arama baÅŸlattÄ± â€” gelen arama popup'Ä± gÃ¶ster
  socket.on('gdm:call:incoming', ({ groupId, type, callerDisplayName, callerAvatarColor }) => {
    if (_gdmCallActive) return; // zaten aramadaysa gÃ¶sterme
    _showIncomingCallPopup({ groupId, type, callerDisplayName, callerAvatarColor });
  });

  // Biz aramaya katÄ±ldÄ±k (gdm:call:join sonrasÄ± server onayÄ±)
  socket.on('gdm:call:joined', ({ groupId, type }) => {
    _gdmCallGroupId = groupId;
    _gdmCallType    = type;
    _gdmCallActive  = true;
    _renderCallBar();
  });

  // Mevcut peer listesi â€” aramaya yeni katÄ±ldÄ±ÄŸÄ±mÄ±zda server gÃ¶nderir
  socket.on('gdm:call:existing:peers', async ({ groupId, peers }) => {
    if (groupId !== _gdmCallGroupId) return;
    for (const peer of peers) {
      if (!_gdmCallPeers.has(peer.socketId)) {
        _gdmCallPeers.set(peer.socketId, {
          userId:      peer.userId,
          displayName: peer.displayName || 'KullanÄ±cÄ±',
          avatarColor: peer.avatarColor || '#5865f2',
          stream:      null,
          pc:          null,
          muted:       false,
        });
        // Biz teklif (offer) gÃ¶ndeririz â€” taker modeli
        const pc = await _createPeerConnection(peer.socketId, _gdmCallPeers.get(peer.socketId));
        _gdmCallPeers.get(peer.socketId).pc = pc;
        await _initiatePeerOffer(peer.socketId);
      }
    }
    _renderCallPeersBar();
    _renderCallGrid();
  });

  // Yeni peer katÄ±ldÄ± â€” onlar bize offer gÃ¶nderecek, biz sadece peer kaydedelim
  socket.on('gdm:call:peer:joined', async ({ groupId, userId, displayName, avatarColor, socketId }) => {
    if (groupId !== _gdmCallGroupId) return;
    if (socketId === socket.id) return; // kendimiz
    if (!_gdmCallPeers.has(socketId)) {
      _gdmCallPeers.set(socketId, {
        userId, displayName: displayName || 'KullanÄ±cÄ±',
        avatarColor: avatarColor || '#5865f2',
        stream: null, pc: null, muted: false,
      });
      // Peer connection'Ä± hazÄ±rla â€” karÅŸÄ± taraf offer gÃ¶nderecek
      const pc = await _createPeerConnection(socketId, _gdmCallPeers.get(socketId));
      _gdmCallPeers.get(socketId).pc = pc;
    }
    _renderCallPeersBar();
    _renderCallGrid();
    toast(`${escHtml(displayName)} aramaya katÄ±ldÄ± ğŸ™ï¸`, 'info');
  });

  // Peer ayrÄ±ldÄ±
  socket.on('gdm:call:peer:left', ({ groupId, socketId }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(socketId);
    if (peer) toast(`${escHtml(peer.displayName)} aramadan ayrÄ±ldÄ±`, 'info');
    _removePeer(socketId);
    _renderCallGrid();
  });

  // Arama tamamen bitirildi (biri gdm:call:end emit etti)
  socket.on('gdm:call:ended', ({ groupId }) => {
    if (groupId !== _gdmCallGroupId) return;
    _destroyTempModal();
    _cleanupCall();
    toast('Grup aramasÄ± sona erdi', 'info');
  });

  // Biz aramadan Ã§Ä±ktÄ±k (kendi emit'imizin onayÄ± â€” socket auto-leave)
  socket.on('gdm:call:left', ({ groupId }) => {
    if (groupId !== _gdmCallGroupId) return;
    // _cleanupCall zaten leaveGdmCall()'da Ã§aÄŸrÄ±ldÄ±
  });

  // WebRTC Signaling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // Gelen offer â€” answer oluÅŸtur
  socket.on('gdm:call:offer', async ({ groupId, fromSocketId, offer }) => {
    if (groupId !== _gdmCallGroupId) return;
    let peer = _gdmCallPeers.get(fromSocketId);
    if (!peer) {
      // Peer henÃ¼z eklenmemiÅŸse (race condition) geÃ§ici kayÄ±t
      peer = { userId: null, displayName: 'KullanÄ±cÄ±', avatarColor: '#5865f2', stream: null, pc: null, muted: false };
      _gdmCallPeers.set(fromSocketId, peer);
    }
    if (!peer.pc) {
      peer.pc = await _createPeerConnection(fromSocketId, peer);
    }
    const pc = peer.pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('gdm:call:answer', { groupId, targetSocketId: fromSocketId, answer });
    } catch (err) {
      console.error('[GDM Voice] offer iÅŸleme hatasÄ±:', err);
    }
  });

  // Gelen answer â€” remote description olarak kaydet
  socket.on('gdm:call:answer', async ({ groupId, fromSocketId, answer }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(fromSocketId);
    if (!peer?.pc) return;
    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error('[GDM Voice] answer iÅŸleme hatasÄ±:', err);
    }
  });

  // Gelen ICE candidate
  socket.on('gdm:call:ice', async ({ groupId, fromSocketId, candidate }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(fromSocketId);
    if (!peer?.pc) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[GDM Voice] ICE candidate hatasÄ±:', err);
    }
  });

  // Peer mute/video durum gÃ¼ncellemesi
  socket.on('gdm:call:peer:state', ({ groupId, socketId, muted, video }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(socketId);
    if (!peer) return;
    peer.muted = muted;
    peer.video = video;

    // Mini bar gÃ¼ncelle
    const dot = document.querySelector(`[data-gdm-peer="${socketId}"]`);
    if (dot) dot.style.opacity = muted ? '0.5' : '1';

    // Modal tile gÃ¼ncelle
    const muteIcon = document.querySelector(`[data-gdm-tile="${socketId}"] .gdm-peer-mute-icon`);
    if (muteIcon) muteIcon.style.display = muted ? 'inline' : 'none';
  });
}

