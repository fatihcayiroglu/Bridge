// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/GroupDmCorePanel.svelte
//              client/js/core/group-dm-core-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/group-dm-core.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Group DM: liste, mesajlar, oluştur, üye yönetimi, ayarlar

import { friendsCache } from './globals.js';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function cssColor(c: string): string;
declare function initials(name: string): string;
declare function formatText(s: string): string;
declare function toast(msg: string, type?: string): void;
declare const API: string;
declare const socket: { emit(event: string, data?: unknown): void };
declare const me: { id: string; displayName?: string } | null;

// ── Tip tanımları ─────────────────────────────────────────────

interface GdmGroup {
  _id: string;
  name: string;
  icon?: string;
  ownerId?: string;
  memberCount?: number;
  members?: GdmMember[];
  lastMessage?: { content?: string };
}

interface GdmMember {
  _id?: string;
  id?: string;
  displayName: string;
  avatarColor: string;
  username?: string;
}

interface GdmMessage {
  _id?: string;
  userId?: string;
  displayName: string;
  avatarColor: string;
  content: string;
  createdAt: string | number;
  type?: string;
}

// ── State ─────────────────────────────────────────────────────

let currentGroupDm: GdmGroup | null = null;
let _gdmGroups: GdmGroup[]          = [];

// ── Panel ─────────────────────────────────────────────────────

export function openGroupDmPanel(): void {
  const panel = document.getElementById('dm-panel');
  if (panel) panel.style.display = 'flex';
  void loadGroupDmList();
}

export async function loadGroupDmList(): Promise<void> {
  const r = await apiFetch(`${API}/api/gdm`);
  if (!r.ok) return;
  _gdmGroups = await r.json();
  renderGroupDmList();
}

export function renderGroupDmList(): void {
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
      <div style="flex-shrink:0;width:36px;height:36px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:18px">${g.icon ?? '👥'}</div>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(g.name)}</div>
        <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview}</div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);flex-shrink:0">${g.memberCount ?? 0} üye</div>`;
    el.onclick = () => void openGroupDm(g);
    container.appendChild(el);
  }
}

// ── Open ──────────────────────────────────────────────────────

export async function openGroupDm(group: GdmGroup): Promise<void> {
  currentGroupDm = group;
  const panel = document.getElementById('dm-panel');
  if (panel) panel.style.display = 'flex';

  const header = document.getElementById('dm-chat-header');
  if (header) {
    header.innerHTML = `
      <span style="font-size:18px">${group.icon ?? '👥'}</span>
      <span style="font-weight:700;font-size:15px;margin-left:6px">${escHtml(group.name)}</span>
      <span style="font-size:12px;color:var(--text-muted);margin-left:8px">${group.memberCount ?? group.members?.length ?? 0} üye</span>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn btn-sm" onclick="openGroupDmInfo()" title="Grup bilgisi">ℹ️</button>
        ${group.ownerId === me?.id ? `<button class="btn btn-sm" onclick="openGroupDmSettings()" title="Ayarlar">⚙️</button>` : ''}
        <button class="btn btn-sm" style="color:var(--danger)" onclick="leaveGroupDm('${group._id}')" title="${group.ownerId === me?.id ? 'Grubu dağıt' : 'Gruptan ayrıl'}">🚪</button>
      </div>`;
  }

  ['dm-call-voice-btn','dm-call-video-btn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });

  socket.emit('gdm:join', group._id);
  await loadGroupDmMessages(group._id);
}

export async function loadGroupDmMessages(groupId: string): Promise<void> {
  const area = document.getElementById('dm-messages');
  if (!area) return;
  area.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Yükleniyor...</div>';
  const r = await apiFetch(`${API}/api/gdm/${groupId}/messages?limit=50`);
  const messages: GdmMessage[] = r.ok ? await r.json() : [];
  area.innerHTML = '';
  for (const msg of messages) area.appendChild(renderGdmMessage(msg));
  area.scrollTop = area.scrollHeight;
  const inputArea = document.getElementById('dm-input-area');
  if (inputArea) inputArea.style.display = 'flex';
}

export function renderGdmMessage(msg: GdmMessage): HTMLElement {
  const el = document.createElement('div');
  if (msg.type === 'system') {
    el.style.cssText = 'text-align:center;color:var(--text-muted);font-size:12px;padding:4px 0;font-style:italic';
    el.textContent = msg.content;
    return el;
  }
  const isOwn = msg.userId === me?.id;
  el.className = 'dm-msg' + (isOwn ? ' dm-own' : '');
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

export function sendGroupDm(): void {
  if (!currentGroupDm) return;
  const inp = document.getElementById('dm-input') as HTMLInputElement | null;
  const content = inp?.value.trim() ?? '';
  if (!content) return;
  if (content.length > 2000) { toast('Mesaj çok uzun', 'error'); return; }
  socket.emit('gdm:send', { groupId: currentGroupDm._id, content });
  if (inp) inp.value = '';
}

// ── Create ────────────────────────────────────────────────────

export function openCreateGroupDmModal(): void {
  _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:95%">
      <h2>👥 Yeni Grup DM</h2>
      <div class="form-group"><label>Grup Adı</label><input type="text" id="gdm-name-input" class="input-field" placeholder="Arkadaşlarım..." maxlength="64"></div>
      <div class="form-group"><label>Emoji (opsiyonel)</label><input type="text" id="gdm-icon-input" class="input-field" placeholder="👥" maxlength="4" style="width:80px"></div>
      <div class="form-group"><label>Üyeler (kullanıcı adı, virgülle ayır)</label><input type="text" id="gdm-members-input" class="input-field" placeholder="ali, veli, ..."></div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="gdm-create-btn">Oluştur</button>
        <button class="btn" onclick="_destroyTempModal()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e: MouseEvent) => { if (e.target === modal) _destroyTempModal(); };
  (document.getElementById('gdm-name-input') as HTMLInputElement | null)?.focus();
  document.getElementById('gdm-create-btn')!.onclick = () => void createGroupDm();
}

export async function createGroupDm(): Promise<void> {
  const name   = (document.getElementById('gdm-name-input')    as HTMLInputElement).value.trim();
  const icon   = (document.getElementById('gdm-icon-input')    as HTMLInputElement).value.trim();
  const raw    = (document.getElementById('gdm-members-input') as HTMLInputElement).value.trim();
  if (!name) { toast('Grup adı gerekli', 'error'); return; }
  if (!raw)  { toast('En az 1 üye ekle', 'error'); return; }

  const usernames = raw.split(',').map(u => u.trim()).filter(Boolean);
  const memberIds: string[] = [];
  for (const uname of usernames) {
    const found = (friendsCache as GdmMember[]).find(f => f.username?.toLowerCase() === uname.toLowerCase());
    if (found) { memberIds.push((found._id ?? found.id)!); continue; }
    toast(`"${uname}" bulunamadı — önce arkadaş olmalısınız`, 'warning');
    return;
  }

  const btn = document.getElementById('gdm-create-btn') as HTMLButtonElement;
  btn.disabled = true; btn.textContent = 'Oluşturuluyor...';

  const r = await apiFetch(`${API}/api/gdm`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon: icon || null, memberIds }),
  });
  const data = await r.json() as GdmGroup & { error?: string };
  if (!r.ok) { toast(data.error ?? 'Oluşturulamadı', 'error'); btn.disabled = false; btn.textContent = 'Oluştur'; return; }

  _destroyTempModal();
  toast(`"${name}" grubu oluşturuldu! 🎉`, 'success');
  await loadGroupDmList();
  void openGroupDm(data);
}

// ── Info ──────────────────────────────────────────────────────

export function openGroupDmInfo(): void {
  if (!currentGroupDm) return;
  _destroyTempModal();
  const g = currentGroupDm;
  const members = g.members ?? [];
  const modal = document.createElement('div');
  modal.id = 'temp-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:360px;width:95%">
      <h2>${g.icon ?? '👥'} ${escHtml(g.name)}</h2>
      <p style="color:var(--text-muted);font-size:13px">${members.length} üye · ${g.ownerId === me?.id ? 'Sen sahipsin' : 'Üyesin'}</p>
      <div style="max-height:240px;overflow-y:auto;margin:12px 0">
        ${members.map(u => `
          <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
            <div style="width:32px;height:32px;border-radius:50%;background:${cssColor(u.avatarColor)};display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:700;color:#fff;flex-shrink:0">${initials(u.displayName)}</div>
            <span style="font-size:14px">${escHtml(u.displayName)}</span>
            ${u._id === g.ownerId ? '<span style="font-size:11px;background:var(--brand);color:#fff;border-radius:3px;padding:1px 5px;margin-left:auto">Sahip</span>' : ''}
            ${g.ownerId === me?.id && u._id !== me?.id ? `<button class="btn btn-sm" style="color:var(--danger);margin-left:auto;font-size:11px" onclick="kickGroupDmMember('${g._id}','${u._id ?? u.id}','${escHtml(u.displayName)}')">Çıkar</button>` : ''}
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
  modal.onclick = (e: MouseEvent) => { if (e.target === modal) _destroyTempModal(); };
}

export async function addGroupDmMember(groupId: string): Promise<void> {
  const uname = (document.getElementById('gdm-add-member') as HTMLInputElement)?.value.trim();
  if (!uname) return;
  const found = (friendsCache as GdmMember[]).find(f => f.username?.toLowerCase() === uname.toLowerCase());
  if (!found) { toast(`"${uname}" bulunamadı`, 'error'); return; }
  const r = await apiFetch(`${API}/api/gdm/${groupId}/members`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: found._id ?? found.id }),
  });
  const data = await r.json() as { error?: string };
  if (!r.ok) { toast(data.error ?? 'Eklenemedi', 'error'); return; }
  toast(`${uname} gruba eklendi!`, 'success');
  _destroyTempModal();
  const gr = await apiFetch(`${API}/api/gdm/${groupId}`);
  if (gr.ok) { currentGroupDm = await gr.json(); openGroupDmInfo(); }
}

export async function kickGroupDmMember(groupId: string, userId: string, name: string): Promise<void> {
  if (!confirm(`${name} kullanıcısını gruptan çıkarmak istediğinizden emin misiniz?`)) return;
  const r = await apiFetch(`${API}/api/gdm/${groupId}/members/${userId}`, { method: 'DELETE' });
  const data = await r.json() as { error?: string };
  if (!r.ok) { toast(data.error ?? 'Çıkarılamadı', 'error'); return; }
  toast(`${name} gruptan çıkarıldı`, 'success');
  _destroyTempModal();
  await loadGroupDmList();
}

// ── Settings ──────────────────────────────────────────────────

export function openGroupDmSettings(): void {
  if (!currentGroupDm || currentGroupDm.ownerId !== me?.id) return;
  _destroyTempModal();
  const g = currentGroupDm;
  const modal = document.createElement('div');
  modal.id = 'temp-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:380px;width:95%">
      <h2>⚙️ Grup Ayarları</h2>
      <div class="form-group"><label>Grup Adı</label><input type="text" id="gdm-settings-name" class="input-field" value="${escHtml(g.name)}" maxlength="64"></div>
      <div class="form-group"><label>Emoji</label><input type="text" id="gdm-settings-icon" class="input-field" value="${escHtml(g.icon ?? '')}" maxlength="4" style="width:80px"></div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveGroupDmSettings('${g._id}')">Kaydet</button>
        <button class="btn" onclick="_destroyTempModal()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e: MouseEvent) => { if (e.target === modal) _destroyTempModal(); };
}

export async function saveGroupDmSettings(groupId: string): Promise<void> {
  const name = (document.getElementById('gdm-settings-name') as HTMLInputElement).value.trim();
  const icon = (document.getElementById('gdm-settings-icon') as HTMLInputElement).value.trim();
  if (!name) { toast('Grup adı boş olamaz', 'error'); return; }
  const r = await apiFetch(`${API}/api/gdm/${groupId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon: icon || null }),
  });
  const data = await r.json() as { error?: string };
  if (!r.ok) { toast(data.error ?? 'Güncellenemedi', 'error'); return; }
  if (currentGroupDm) currentGroupDm = { ...currentGroupDm, name, icon };
  toast('Grup güncellendi', 'success');
  _destroyTempModal();
  await loadGroupDmList();
  if (currentGroupDm) void openGroupDm(currentGroupDm);
}

export async function leaveGroupDm(groupId: string): Promise<void> {
  const g = currentGroupDm;
  const msg = g?.ownerId === me?.id
    ? 'Grubu dağıtmak istediğinizden emin misiniz? Tüm mesajlar silinecek.'
    : 'Gruptan ayrılmak istediğinizden emin misiniz?';
  if (!confirm(msg)) return;

  const r = g?.ownerId === me?.id
    ? await apiFetch(`${API}/api/gdm/${groupId}`, { method: 'DELETE' })
    : await apiFetch(`${API}/api/gdm/${groupId}/members/${me!.id}`, { method: 'DELETE' });

  const data = await r.json() as { error?: string };
  if (!r.ok) { toast(data.error ?? 'İşlem başarısız', 'error'); return; }

  currentGroupDm = null;
  const chatHeader = document.getElementById('dm-chat-header');
  if (chatHeader) chatHeader.textContent = '';
  const msgs = document.getElementById('dm-messages');
  if (msgs) msgs.innerHTML = '';
  const inputArea = document.getElementById('dm-input-area');
  if (inputArea) inputArea.style.display = 'none';
  toast(g?.ownerId === me?.id ? 'Grup dağıtıldı' : 'Gruptan ayrıldınız', 'success');
  await loadGroupDmList();
}

// ── Util ──────────────────────────────────────────────────────

function _destroyTempModal(): void {
  document.getElementById('temp-modal')?.remove();
}
