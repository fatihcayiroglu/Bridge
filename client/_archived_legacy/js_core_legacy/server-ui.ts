// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ServerUiPanel.svelte
//              client/js/core/server-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/server-ui.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Sunucu UI: menü, rol yönetimi, davet, sunucu oluştur/katıl, kategori

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type?: string): void;
declare function closeModal(id: string): void;
declare function loadServers(): Promise<void>;
declare function loadChannels(serverId: string): Promise<void>;
declare function showConfirmModal(opts: { title: string; message: string; confirmText?: string; danger?: boolean; onConfirm(): Promise<void> }): void;
declare function showInputModal(opts: { title: string; label: string; confirmText?: string; onConfirm(v: string): Promise<void> }): void;
declare const API: string;
declare const currentServer: { _id: string; name?: string; icon?: string } | null;
declare const socket: { emit(event: string, data?: unknown): void };

// ── Tip tanımları ─────────────────────────────────────────────

interface ServerTemplate { id: string; name: string; icon: string; description: string; tags: string[]; }
interface Role           { _id: string; name: string; color: string; permissions: number; }
interface InviteData     { code: string; expiresAt: string; uses?: number; }

interface PermDef { key: string; bit: number; label: string; }

// ── Tab yönetimi ──────────────────────────────────────────────

export function openAddServerModal(): void {
  const m = document.getElementById('addserver-modal');
  if (m) m.style.display = 'flex';
}

export function switchServerTab(tab: string): void {
  const tabs = ['create', 'template', 'join', 'invite'];
  document.querySelectorAll<HTMLElement>('#addserver-modal .auth-tab').forEach(t => {
    t.classList.toggle('active', t.getAttribute('onclick')?.includes(`'${tab}'`) ?? false);
  });
  tabs.forEach(t => {
    const el = document.getElementById(`${t === 'invite' ? 'invite-join' : t}-server-form`) ??
               document.getElementById(`${t}-server-form`);
    if (el) el.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'template') void loadTemplateList();
}

// ── Şablon sistemi ────────────────────────────────────────────

let _selectedTemplateId: string | null = null;

export async function loadTemplateList(): Promise<void> {
  const list = document.getElementById('template-list');
  if (!list) return;
  try {
    const r         = await apiFetch(`${API}/api/server-templates`);
    const templates = await r.json() as ServerTemplate[];
    list.innerHTML  = templates.map(t => `
      <div class="template-card" data-id="${escHtml(t.id)}" onclick="selectTemplate('${escHtml(t.id)}','${escHtml(t.name)}')"
        style="display:flex;align-items:center;gap:14px;padding:14px;background:var(--bg-3);
          border-radius:10px;cursor:pointer;border:2px solid transparent;transition:border-color .15s,background .15s">
        <span style="font-size:2.2rem;flex-shrink:0">${escHtml(t.icon)}</span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:14px;color:var(--text-1)">${escHtml(t.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(t.description)}</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
            ${t.tags.map(tag => `<span style="background:var(--bg-2);border-radius:999px;padding:2px 8px;font-size:10px;color:var(--text-muted)">${escHtml(tag)}</span>`).join('')}
          </div>
        </div>
        <span style="font-size:18px;color:var(--text-muted)">›</span>
      </div>`).join('');
  } catch {
    list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">Şablonlar yüklenemedi</div>';
  }
}

export function selectTemplate(id: string, name: string): void {
  _selectedTemplateId = id;
  document.querySelectorAll<HTMLElement>('.template-card').forEach(c => {
    c.style.borderColor = c.dataset.id === id ? 'var(--brand)' : 'transparent';
    c.style.background  = c.dataset.id === id ? 'rgba(45,156,219,.12)' : 'var(--bg-3)';
  });
  const nameRow   = document.getElementById('template-name-row');
  if (nameRow) nameRow.style.display = '';
  const nameInput = document.getElementById('template-server-name') as HTMLInputElement | null;
  if (nameInput && !nameInput.value) nameInput.value = name;
  nameInput?.focus();
}

export function clearTemplateSelection(): void {
  _selectedTemplateId = null;
  document.querySelectorAll<HTMLElement>('.template-card').forEach(c => {
    c.style.borderColor = 'transparent';
    c.style.background  = 'var(--bg-3)';
  });
  const nameRow = document.getElementById('template-name-row');
  if (nameRow) nameRow.style.display = 'none';
}

export async function applyTemplate(): Promise<void> {
  if (!_selectedTemplateId) { toast('Önce bir şablon seç', 'error'); return; }
  const name = (document.getElementById('template-server-name') as HTMLInputElement | null)?.value?.trim();
  if (!name) { toast('Sunucu adı gerekli', 'error'); return; }

  const btn = document.querySelector<HTMLButtonElement>('#template-name-row .btn-primary');
  if (btn) { btn.textContent = '⏳ Oluşturuluyor...'; btn.disabled = true; }

  try {
    const r = await apiFetch(`${API}/api/server-templates/${_selectedTemplateId}/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    const data = await r.json() as { error?: string; server?: { name?: string } };
    if (!r.ok) { toast(data.error ?? 'Hata oluştu', 'error'); return; }
    closeModal('addserver-modal');
    _selectedTemplateId = null;
    await loadServers();
    toast(`✨ "${data.server?.name}" şablondan oluşturuldu!`, 'success');
  } finally {
    if (btn) { btn.textContent = '✨ Şablonu Uygula'; btn.disabled = false; }
  }
}

// ── Create / Join ─────────────────────────────────────────────

export async function createServer(): Promise<void> {
  const name = (document.getElementById('new-server-name') as HTMLInputElement).value.trim();
  const icon = (document.getElementById('new-server-icon') as HTMLInputElement).value.trim() || '🌐';
  if (!name) { toast('Server name required', 'error'); return; }
  const r = await apiFetch(`${API}/api/servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, icon }),
  });
  const s = await r.json() as { error?: string; name?: string };
  if (!r.ok) { toast(s.error ?? 'Error', 'error'); return; }
  closeModal('addserver-modal');
  await loadServers();
  toast(`Server "${s.name}" created!`, 'success');
}

export async function joinServer(): Promise<void> {
  const id = (document.getElementById('join-server-id') as HTMLInputElement).value.trim();
  if (!id) { toast('Server ID required', 'error'); return; }
  const r = await apiFetch(`${API}/api/servers/${id}/join`, { method: 'POST' });
  const s = await r.json() as { error?: string; name?: string };
  if (!r.ok) { toast(s.error ?? 'Error', 'error'); return; }
  closeModal('addserver-modal');
  await loadServers();
  toast(`Joined "${s.name}"!`, 'success');
}

export async function joinByInvite(): Promise<void> {
  const code = (document.getElementById('invite-code-input') as HTMLInputElement).value.trim();
  if (!code) { toast('Invite code required', 'error'); return; }
  const r = await apiFetch(`${API}/api/servers/invites/${code}/use`, { method: 'POST' });
  const s = await r.json() as { error?: string; name?: string };
  if (!r.ok) { toast(s.error ?? 'Error', 'error'); return; }
  closeModal('addserver-modal');
  await loadServers();
  toast(`Joined "${s.name}"!`, 'success');
}

// ── Davet Modal ───────────────────────────────────────────────

let _currentInviteUrl   = '';
let _currentInviteCode  = '';
let _currentInviteQrSvg = '';

export async function openInviteModal(): Promise<void> {
  if (!currentServer) return;
  _currentInviteUrl = _currentInviteCode = _currentInviteQrSvg = '';

  const m = document.getElementById('invite-modal');
  if (m) m.style.display = 'flex';

  _setText('invite-server-name',    currentServer.name ?? 'Sunucu');
  _setText('invite-server-icon',    currentServer.icon ?? '🌐');
  _setText('invite-server-members', '');
  _setVal('invite-link-input',      'Oluşturuluyor...');
  _setText('invite-expiry',         '');
  _setHtml('invite-qr-img',         'Yükleniyor...');

  const nativeBtn = document.getElementById('invite-native-share');
  if (nativeBtn) nativeBtn.style.display = (navigator as { share?: typeof navigator.share }).share ? '' : 'none';

  try {
    const r = await apiFetch(`${API}/api/servers/invites`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serverId: currentServer._id }),
    });
    const data = await r.json() as InviteData & { error?: string };
    if (!r.ok) throw new Error(data.error);

    const instanceUrl  = window.location.origin;
    _currentInviteCode = data.code;
    _currentInviteUrl  = `${instanceUrl}/invite/${data.code}`;
    _setVal('invite-link-input', _currentInviteUrl);

    const expiry = new Date(data.expiresAt).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });
    _setText('invite-expiry', `⏱ ${expiry} tarihine kadar geçerli • ${data.uses ?? 0} kullanım`);

    try {
      const sr = await apiFetch(`${API}/api/servers/${currentServer._id}/members`);
      if (sr.ok) {
        const members = await sr.json() as unknown[];
        _setText('invite-server-members', `👥 ${Array.isArray(members) ? members.length : '?'} üye`);
      }
    } catch { /* ignore */ }

    void _loadInviteQr(data.code);
  } catch {
    _currentInviteUrl  = `${window.location.origin}/?invite=${currentServer._id}`;
    _currentInviteCode = currentServer._id;
    _setVal('invite-link-input', _currentInviteUrl);
    _setText('invite-expiry',    'Sunucu ID ile katılım');
    _setText('invite-qr-img',    'QR oluşturulamadı');
  }
}

async function _loadInviteQr(code: string): Promise<void> {
  const container = document.getElementById('invite-qr-img');
  if (!container) return;
  try {
    const r = await apiFetch(`${API}/api/servers/invites/${code}/qr/data`);
    if (!r.ok) throw new Error('QR alınamadı');
    const data = await r.json() as { qrDataUrl?: string; svg?: string; dataUrl?: string };
    _currentInviteQrSvg = data.qrDataUrl ?? data.svg ?? data.dataUrl ?? '';
    container.innerHTML = _currentInviteQrSvg
      ? `<img src="${escHtml(_currentInviteQrSvg)}" alt="QR Kod" style="width:160px;height:160px;display:block">`
      : 'QR desteklenmiyor';
  } catch { container.textContent = 'QR oluşturulamadı'; }
}

export function copyInviteLink(): void {
  const url = _currentInviteUrl || (document.getElementById('invite-link-input') as HTMLInputElement)?.value;
  void navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copy-btn-text');
    if (btn) { btn.textContent = '✓ Kopyalandı'; setTimeout(() => { btn.textContent = 'Kopyala'; }, 2000); }
    toast('Davet linki kopyalandı!', 'success');
  });
}

export const copyInvite = copyInviteLink;

export function shareInvite(platform: string): void {
  const url  = _currentInviteUrl;
  const name = currentServer?.name ?? 'Bridge Sunucusu';
  const text = `${name} topluluğuna Bridge'de katıl! 🌉`;

  if (platform === 'native' && navigator.share) {
    void navigator.share({ title: name, text, url }).catch(() => { /* ignore */ });
    return;
  }

  const urls: Record<string, string> = {
    whatsapp: `https://api.whatsapp.com/send?text=${encodeURIComponent(text + '\n' + url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    twitter:  `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
  };
  if (urls[platform]) window.open(urls[platform], '_blank', 'noopener,width=600,height=500');
}

export function downloadInviteQr(): void {
  if (!_currentInviteQrSvg) { toast('QR henüz hazır değil', 'error'); return; }
  const a = document.createElement('a');
  a.href = _currentInviteQrSvg;
  a.download = `bridge-invite-${_currentInviteCode || 'qr'}.png`;
  a.click();
}

// ── Sunucu Menüsü ─────────────────────────────────────────────

export function openServerMenu(): void {
  const existing = document.getElementById('server-ctx-menu');
  if (existing) { existing.remove(); return; }
  const menu = document.createElement('div');
  menu.id = 'server-ctx-menu'; menu.className = 'ctx-menu';
  menu.style.cssText = 'position:absolute;top:48px;left:8px;z-index:9999;min-width:200px';
  const close = () => document.getElementById('server-ctx-menu')?.remove();
  menu.innerHTML = `
    <div class="ctx-item" onclick="copyServerId()">📋 Copy Server ID</div>
    <div class="ctx-item" onclick="openInviteModal();${close.toString()}()">🔗 Invite People</div>
    <div class="ctx-item" onclick="openEmojiManager();${close.toString()}()">😀 Emoji Yönetimi</div>
    <div class="ctx-item" onclick="openSoundboard();${close.toString()}()">🎵 Soundboard</div>
    <div class="ctx-item" onclick="openDiscoverySettings();${close.toString()}()">🌐 Keşif Ayarları</div>
    <div class="ctx-item" onclick="openServerSettings();${close.toString()}()">⚙️ Sunucu Ayarları</div>
    <div class="ctx-item" onclick="createChannel();${close.toString()}()">➕ Create Channel</div>
    <div class="ctx-item" onclick="promptAddCategory();${close.toString()}()">🗂️ Kategori Ekle</div>
    <div class="ctx-item" onclick="openRoleManager();${close.toString()}()">👑 Manage Roles</div>
    <div class="ctx-item" onclick="openServerGifModal();${close.toString()}()">🎞️ Server GIFs</div>
    <div class="ctx-item" onclick="openBridgeModal();${close.toString()}()">🌉 Channel Bridge</div>
    <div style="height:1px;background:var(--bg-5);margin:4px 0"></div>
    <div class="ctx-item" onclick="openServerStats();${close.toString()}()">📊 Sunucu İstatistikleri</div>
    <div class="ctx-item" onclick="openAutoModPanel();${close.toString()}()">🛡️ AutoMod Kuralları</div>
    <div class="ctx-item" onclick="openAuditLog();${close.toString()}()">📋 Moderasyon Günlüğü</div>`;

  const headerBtn = document.getElementById('server-header-btn');
  if (headerBtn) { headerBtn.style.position = 'relative'; headerBtn.appendChild(menu); }
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

export function copyServerId(): void {
  void navigator.clipboard.writeText(currentServer?._id ?? '').then(() => toast('Server ID copied!', 'success'));
  document.getElementById('server-ctx-menu')?.remove();
}

// ── Rol Yöneticisi ────────────────────────────────────────────

const PERMS_LIST: PermDef[] = [
  { key: 'MANAGE_CHANNELS', bit: 1,  label: 'Manage Channels' },
  { key: 'MANAGE_ROLES',    bit: 2,  label: 'Manage Roles' },
  { key: 'KICK_MEMBERS',    bit: 4,  label: 'Kick Members' },
  { key: 'BAN_MEMBERS',     bit: 8,  label: 'Ban Members' },
  { key: 'SEND_MESSAGES',   bit: 16, label: 'Send Messages' },
  { key: 'MANAGE_MESSAGES', bit: 32, label: 'Manage Messages' },
  { key: 'ADMINISTRATOR',   bit: 64, label: '👑 Administrator' },
];

export async function openRoleManager(): Promise<void> {
  if (!currentServer) return;
  const r    = await apiFetch(`${API}/api/servers/${currentServer._id}/roles`);
  const roles = await r.json() as Role[];

  let modal = document.getElementById('role-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'role-modal'; modal.className = 'modal-overlay';
    modal.onclick = (e: MouseEvent) => { if (e.target === modal) (modal as HTMLElement).style.display = 'none'; };
    document.body.appendChild(modal);
  }

  const rolesHtml = roles.length
    ? roles.map(role => `
        <div class="role-row" style="border-left:4px solid ${role.color}">
          <strong style="color:${role.color}">${escHtml(role.name)}</strong>
          <span style="font-size:11px;color:var(--text-muted)">Perms: ${role.permissions}</span>
          <button class="btn" style="padding:2px 8px;font-size:12px"
            data-roleid="${escHtml(role._id)}"
            onclick="showDeleteRoleModal(this.dataset.roleid)">🗑️</button>
        </div>`).join('')
    : '<p style="color:var(--text-muted)">No roles yet.</p>';

  const permsHtml = PERMS_LIST.map(p => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" class="perm-check" data-bit="${p.bit}" ${p.key === 'SEND_MESSAGES' ? 'checked' : ''}>
      ${p.label}
    </label>`).join('');

  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%">
      <h2>👑 Role Manager</h2>
      <div id="role-list-inner">${rolesHtml}</div>
      <hr style="border-color:var(--bg-3);margin:12px 0">
      <h3 style="font-size:14px;margin-bottom:8px">Create New Role</h3>
      <div class="form-group"><label>Name</label><input type="text" id="new-role-name" placeholder="Moderator"></div>
      <div class="form-group"><label>Color</label><input type="color" id="new-role-color" value="#2d9cdb"></div>
      <div class="form-group"><label>Permissions</label><div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">${permsHtml}</div></div>
      <div class="modal-footer">
        <button class="btn btn-primary" style="flex:1" onclick="createRole()">Create Role</button>
        <button class="btn" style="flex:1" onclick="document.getElementById('role-modal').style.display='none'">Close</button>
      </div>
    </div>`;
  modal.style.display = 'flex';
}

export async function createRole(): Promise<void> {
  const name  = (document.getElementById('new-role-name')  as HTMLInputElement).value.trim();
  const color = (document.getElementById('new-role-color') as HTMLInputElement).value;
  if (!name) { toast('Role name required', 'error'); return; }
  let permissions = 0;
  document.querySelectorAll<HTMLInputElement>('.perm-check:checked').forEach(cb => { permissions |= parseInt(cb.dataset.bit ?? '0'); });
  const r = await apiFetch(`${API}/api/servers/${currentServer!._id}/roles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color, permissions }),
  });
  const data = await r.json() as Role & { error?: string };
  if (!r.ok) { toast(data.error ?? 'Error', 'error'); return; }
  toast(`Role "${data.name}" created`, 'success');
  void openRoleManager();
}

export function showDeleteRoleModal(roleId: string): void {
  showConfirmModal({
    title: 'Delete Role', message: 'This role will be permanently deleted.', confirmText: 'Delete', danger: true,
    onConfirm: async () => {
      const r = await apiFetch(`${API}/api/servers/${currentServer!._id}/roles/${roleId}`, { method: 'DELETE' });
      if (!r.ok) { toast('Failed', 'error'); return; }
      toast('Role deleted', 'success');
      void openRoleManager();
    },
  });
}

// ── Kategori ──────────────────────────────────────────────────

export async function promptAddCategory(): Promise<void> {
  if (!currentServer) return;
  showInputModal({
    title: 'Kategori Ekle', label: 'Kategori adı', confirmText: 'Oluştur',
    onConfirm: async (name: string) => {
      if (!name.trim()) return;
      try {
        const r = await apiFetch(`${API}/api/servers/${currentServer!._id}/categories`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
        });
        const cat = await r.json() as { error?: string };
        if (!r.ok) { toast(cat.error ?? 'Hata', 'error'); return; }
        socket.emit('category:created', { serverId: currentServer!._id, category: cat });
        toast('Kategori oluşturuldu', 'success');
        await loadChannels(currentServer!._id);
      } catch { toast('Hata', 'error'); }
    },
  });
}

// ── Yardımcılar ───────────────────────────────────────────────

function _setText(id: string, v: string): void { const el = document.getElementById(id); if (el) el.textContent = v; }
function _setVal(id: string, v: string): void   { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = v; }
function _setHtml(id: string, v: string): void  { const el = document.getElementById(id); if (el) el.innerHTML = v; }
