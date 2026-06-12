// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/GroupDmPanel.svelte
//              client/js/core/group-dm-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { friendsCache } from './globals.js';
// client/js/core/group-dm.ts
// Grup DM: liste, oluşturma, mesajlaşma, üye yönetimi, sesli/görüntülü arama

'use strict';

import { createLogger } from './logger.js';
const log = createLogger('GroupDM');

export {};

let currentGroupDm    = null;
let _gdmGroups        = [];

// ── GDM Voice Call State ─────────────────────────────────────
let _gdmCallActive    = false;   // aramada mıyız?
let _gdmCallGroupId   = null;    // hangi grup
let _gdmCallType      = 'voice'; // 'voice' | 'video'
let _gdmCallPeers     = new Map(); // socketId → { userId, displayName, avatarColor, stream, pc }
let _gdmLocalStream   = null;
const GDM_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// ── Panel ───────────────────────────────────────────────────────
function openGroupDmPanel() {
  document.getElementById('dm-panel')?.style.display = 'flex';
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
    container.innerHTML = '<div style="padding:10px 12px;color:var(--text-muted);font-size:13px">Grup DM yok. <a href="#" onclick="openCreateGroupDmModal();return false" style="color:var(--brand)">Oluştur →</a></div>';
    return;
  }

  for (const g of _gdmGroups) {
    const el = document.createElement('div');
    el.className = 'dm-item';
    el.dataset.gid = g._id;
    const preview = g.lastMessage?.content
      ? escHtml(g.lastMessage.content.slice(0, 40))
      : '<span style="color:var(--text-muted)">Henüz mesaj yok</span>';
    el.innerHTML = `
      <div style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:18px">
        ${g.icon || 'ğŸ‘¥'}
      </div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);flex-shrink:0">${g.memberCount || 0} üye</div>`;
    el.onclick = () => openGroupDm(g);
    container.appendChild(el);
  }
}

// ── Open / Switch ───────────────────────────────────────────────
async function openGroupDm(group) {
  currentGroupDm = group;

  // Show DM panel (reuse existing panel structure)
  document.getElementById('dm-panel')?.style.display = 'flex';
  if (header) {
    header.innerHTML = `
      <span style="font-size:18px">${group.icon || 'ğŸ‘¥'}</span>
      <span style="font-weight:700;font-size:15px;margin-left:6px">${escHtml(group.name)}</span>
      <span style="font-size:12px;color:var(--text-muted);margin-left:8px">${group.memberCount || group.members?.length || 0} üye</span>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn btn-sm" onclick="openGroupDmInfo()" title="Grup bilgisi">â„¹ï¸</button>
        ${group.ownerId === me?.id ? `<button class="btn btn-sm" onclick="openGroupDmSettings()" title="Ayarlar">âš™ï¸</button>` : ''}
        <button class="btn btn-sm" style="color:var(--danger)" onclick="leaveGroupDm('${group._id}')" title="${group.ownerId === me?.id ? 'Grubu dağıt' : 'Gruptan ayrıl'}">ğŸšª</button>
      </div>`;
  }

  // Hide 1:1 DM call buttons — GDM has its own call UI
  const voiceBtn = document.getElementById('dm-call-voice-btn');
  const videoBtn = document.getElementById('dm-call-video-btn');
  if (voiceBtn) voiceBtn.style.display = 'none';
  if (videoBtn) videoBtn.style.display = 'none';

  // GDM call buttons — header'a eklendi
  const existingCallBar = document.getElementById('gdm-call-bar');
  if (existingCallBar) existingCallBar.remove();

  const header = document.getElementById('dm-chat-header');
  if (header) {
    // Call buttons — header actions area'ya ekle
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
      vidBtn.title = 'Görüntülü Arama';
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
  area.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Yükleniyor...</div>';

  const r = await apiFetch(`${API}/api/gdm/${groupId}/messages?limit=50`);
  const messages = r.ok ? await r.json() : [];
  area.innerHTML = '';
  for (const msg of messages) area.appendChild(renderGdmMessage(msg));
  area.scrollTop = area.scrollHeight;
  document.getElementById('dm-input-area')?.style.display = 'flex';
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
  if (content.length > 2000) return toast('Mesaj çok uzun', 'error');
  socket.emit('gdm:send', { groupId: currentGroupDm._id, content });
  inp.value = '';
}

// ── Create Group DM Modal ──────────────────────────────────────
function openCreateGroupDmModal() {
  _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:95%">
      <h2>ğŸ‘¥ Yeni Grup DM</h2>
      <div class="form-group">
        <label>Grup Adı</label>
        <input type="text" id="gdm-name-input" class="input-field" placeholder="Arkadaşlarım..." maxlength="64">
      </div>
      <div class="form-group">
        <label>Emoji (opsiyonel)</label>
        <input type="text" id="gdm-icon-input" class="input-field" placeholder="ğŸ‘¥" maxlength="4" style="width:80px">
      </div>
      <div class="form-group">
        <label>Üyeler (kullanıcı adı, virgülle ayır)</label>
        <input type="text" id="gdm-members-input" class="input-field" placeholder="ali, veli, ...">
        <div id="gdm-members-preview" style="margin-top:6px;font-size:12px;color:var(--text-muted)"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="gdm-create-btn">Oluştur</button>
        <button class="btn" onclick="_destroyTempModal()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
  document.getElementById('gdm-name-input')?.focus();
  document.getElementById('gdm-create-btn')?.onclick = createGroupDm;
}

async function createGroupDm() {
  const name = (document.getElementById('gdm-name-input') as HTMLInputElement | null)?.value ?? ''.trim();
  const icon = (document.getElementById('gdm-icon-input') as HTMLInputElement | null)?.value ?? ''.trim();
  const raw  = (document.getElementById('gdm-members-input') as HTMLInputElement | null)?.value ?? ''.trim();

  if (!name) return toast('Grup adı gerekli', 'error');
  if (!raw)  return toast('En az 1 üye ekle', 'error');

  // Resolve usernames to IDs
  const usernames = raw.split(',').map(u => u.trim()).filter(Boolean);
  const memberIds = [];
  for (const uname of usernames) {
    // Use friends list if available, otherwise search
    const found = (friendsCache).find(f => f.username?.toLowerCase() === uname.toLowerCase());
    if (found) { memberIds.push(found._id || found.id); continue; }
    toast(`"${uname}" bulunamadı — önce arkadaş olmalısınız`, 'warning');
    return;
  }

  const btn = document.getElementById('gdm-create-btn');
  btn.disabled = true;
  btn.textContent = 'Oluşturuluyor...';

  const r = await apiFetch(`${API}/api/gdm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon: icon || null, memberIds }),
  });
  const data = await r.json();
  if (!r.ok) { toast(data.error || 'Oluşturulamadı', 'error'); btn.disabled = false; btn.textContent = 'Oluştur'; return; }

  _destroyTempModal();
  toast(`"${name}" grubu oluşturuldu! ğŸ‰`, 'success');
  await loadGroupDmList();
  openGroupDm(data);
}

// ── Group Info Popover ─────────────────────────────────────────
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
      <p style="color:var(--text-muted);font-size:13px">${members.length} üye Â· ${g.ownerId === me?.id ? 'Sen sahipsin' : 'Üyesin'}</p>
      <div style="max-height:240px;overflow-y:auto;margin:12px 0">
        ${members.map(u => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="width:32px;height:32px;border-radius:50%;background:${cssColor(u.avatarColor)};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0">${initials(u.displayName)}</div>
            <span style="font-size:14px">${escHtml(u.displayName)}</span>
            ${u._id === g.ownerId ? '<span style="font-size:11px;background:var(--brand);color:#fff;border-radius:3px;padding:1px 5px;margin-left:auto">Sahip</span>' : ''}
            ${g.ownerId === me?.id && u._id !== me?.id ? `<button class="btn btn-sm" style="color:var(--danger);margin-left:auto;font-size:11px" onclick="kickGroupDmMember('${g._id}','${u._id}','${escHtml(u.displayName)}')">Çıkar</button>` : ''}
          </div>`).join('')}
      </div>
      ${g.ownerId === me?.id ? `
      <div style="margin-top:8px">
        <input type="text" id="gdm-add-member" class="input-field" placeholder="Kullanıcı adı ekle..." style="width:100%;margin-bottom:6px">
        <button class="btn btn-primary" style="width:100%" onclick="addGroupDmMember('${g._id}')">+ Üye Ekle</button>
      </div>` : ''}
      <div class="modal-footer"><button class="btn" onclick="_destroyTempModal()">Kapat</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
}

async function addGroupDmMember(groupId) {
  const uname = (document.getElementById('gdm-add-member') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!uname) return;
  const found = (friendsCache).find(f => f.username?.toLowerCase() === uname.toLowerCase());
  if (!found) return toast(`"${uname}" bulunamadı`, 'error');

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
  if (!confirm(`${name} kullanıcısını gruptan çıkarmak istediğinizden emin misiniz?`)) return;
  const r = await apiFetch(`${API}/api/gdm/${groupId}/members/${userId}`, { method: 'DELETE' });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Çıkarılamadı', 'error');
  toast(`${name} gruptan çıkarıldı`, 'success');
  _destroyTempModal();
  await loadGroupDmList();
  if (currentGroupDm?._id === groupId) {
    const gr = await apiFetch(`${API}/api/gdm/${groupId}`);
    if (gr.ok) currentGroupDm = await gr.json();
  }
}

// ── Group DM Settings (rename/icon) ───────────────────────────
function openGroupDmSettings() {
  if (!currentGroupDm || currentGroupDm.ownerId !== me?.id) return;
  _destroyTempModal();
  const g = currentGroupDm;
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:380px;width:95%">
      <h2>âš™ï¸ Grup Ayarları</h2>
      <div class="form-group">
        <label>Grup Adı</label>
        <input type="text" id="gdm-settings-name" class="input-field" value="${escHtml(g.name)}" maxlength="64">
      </div>
      <div class="form-group">
        <label>Emoji</label>
        <input type="text" id="gdm-settings-icon" class="input-field" value="${escHtml(g.icon || '')}" maxlength="4" style="width:80px">
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveGroupDmSettings('${g._id}')">Kaydet</button>
        <button class="btn" onclick="_destroyTempModal()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
}

async function saveGroupDmSettings(groupId) {
  const name = (document.getElementById('gdm-settings-name') as HTMLInputElement | null)?.value ?? ''.trim();
  const icon = (document.getElementById('gdm-settings-icon') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!name) return toast('Grup adı boş olamaz', 'error');

  const r = await apiFetch(`${API}/api/gdm/${groupId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon: icon || null }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Güncellenemedi', 'error');

  currentGroupDm = { ...currentGroupDm, name, icon };
  toast('Grup güncellendi', 'success');
  _destroyTempModal();
  await loadGroupDmList();
  openGroupDm(currentGroupDm);
}

async function leaveGroupDm(groupId) {
  const g = currentGroupDm;
  const msg = g?.ownerId === me?.id
    ? 'Grubu dağıtmak istediğinizden emin misiniz? Tüm mesajlar silinecek.'
    : 'Gruptan ayrılmak istediğinizden emin misiniz?';
  if (!confirm(msg)) return;

  const r = g?.ownerId === me?.id
    ? await apiFetch(`${API}/api/gdm/${groupId}`, { method: 'DELETE' })
    : await apiFetch(`${API}/api/gdm/${groupId}/members/${me.id}`, { method: 'DELETE' });

  const data = await r.json();
  if (!r.ok) return toast(data.error || 'İşlem başarısız', 'error');

  currentGroupDm = null;
  document.getElementById('dm-chat-header')?.textContent = '';
  document.getElementById('dm-messages')?.innerHTML = '';
  document.getElementById('dm-input-area')?.style.display = 'none';
  toast(g?.ownerId === me?.id ? 'Grup dağıtıldı' : 'Gruptan ayrıldınız', 'success');
  await loadGroupDmList();
}


// ── Voice & WebRTC ─────────────────────────────────────────────
// Sprint 105: GDM voice/WebRTC kodu group-dm-voice.ts'e taşındı.
// Ses/görüntü aramaları için: import './group-dm-voice.js'
