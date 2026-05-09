// core/server-ui.js
// Sunucu UI: menÃ¼, rol yÃ¶netimi, davet, sunucu oluÅŸtur/katÄ±l, kategori

// â”€â”€ Sunucu Ekle / KatÄ±l Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openAddServerModal() {
  document.getElementById('addserver-modal').style.display = 'flex';
}

function switchServerTab(tab) {
  const tabs = ['create', 'template', 'join', 'invite'];
  document.querySelectorAll('#addserver-modal .auth-tab').forEach((t, i) =>
    t.classList.toggle('active', t.getAttribute('onclick')?.includes(`'${tab}'`))
  );
  document.getElementById('create-server-form').style.display   = tab === 'create'   ? '' : 'none';
  document.getElementById('template-server-form').style.display = tab === 'template' ? '' : 'none';
  document.getElementById('join-server-form').style.display     = tab === 'join'     ? '' : 'none';
  document.getElementById('invite-join-form').style.display     = tab === 'invite'   ? '' : 'none';

  if (tab === 'template') loadTemplateList();
}

// â”€â”€ Åablon Sistemi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _selectedTemplateId = null;

async function loadTemplateList() {
  const list = document.getElementById('template-list');
  if (!list) return;
  try {
    const r = await apiFetch(`${API}/api/server-templates`);
    const templates = await r.json();
    list.innerHTML = templates.map(t => `
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
        <span style="font-size:18px;color:var(--text-muted)">â€º</span>
      </div>`).join('');
  } catch {
    list.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:20px">Åablonlar yÃ¼klenemedi</div>';
  }
}

function selectTemplate(id, name) {
  _selectedTemplateId = id;
  // SeÃ§ilen kartÄ± vurgula
  document.querySelectorAll('.template-card').forEach(c => {
    c.style.borderColor = c.dataset.id === id ? 'var(--brand)' : 'transparent';
    c.style.background  = c.dataset.id === id ? 'rgba(88,101,242,.12)' : 'var(--bg-3)';
  });
  // Ä°sim alanÄ±nÄ± gÃ¶ster, ÅŸablon adÄ±nÄ± doldur
  document.getElementById('template-name-row').style.display = '';
  const nameInput = document.getElementById('template-server-name');
  if (nameInput && !nameInput.value) nameInput.value = name;
  nameInput?.focus();
}

function clearTemplateSelection() {
  _selectedTemplateId = null;
  document.querySelectorAll('.template-card').forEach(c => {
    c.style.borderColor = 'transparent';
    c.style.background  = 'var(--bg-3)';
  });
  document.getElementById('template-name-row').style.display = 'none';
}

async function applyTemplate() {
  if (!_selectedTemplateId) return toast('Ã–nce bir ÅŸablon seÃ§', 'error');
  const name = document.getElementById('template-server-name')?.value?.trim();
  if (!name) return toast('Sunucu adÄ± gerekli', 'error');

  const btn = document.querySelector('#template-name-row .btn-primary');
  if (btn) { btn.textContent = 'â³ OluÅŸturuluyor...'; btn.disabled = true; }

  try {
    const r = await apiFetch(`${API}/api/server-templates/${_selectedTemplateId}/apply`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ name }),
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Hata oluÅŸtu', 'error'); return; }

    closeModal('addserver-modal');
    _selectedTemplateId = null;
    await loadServers();
    toast(`âœ¨ "${data.server.name}" ÅŸablondan oluÅŸturuldu!`, 'success');
  } finally {
    if (btn) { btn.textContent = 'âœ¨ Åablonu Uygula'; btn.disabled = false; }
  }
}


async function createServer() {
  const name = (document.getElementById('new-server-name') as HTMLInputElement | null)?.value ?? ''.trim();
  const icon = (document.getElementById('new-server-icon') as HTMLInputElement | null)?.value ?? ''.trim() || 'ğŸŒ';
  if (!name) return toast('Server name required', 'error');
  const r = await apiFetch(`${API}/api/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, icon }),
  });
  const s = await r.json();
  if (!r.ok) return toast(s.error, 'error');
  closeModal('addserver-modal');
  await loadServers();
  toast(`Server "${s.name}" created!`, 'success');
}

async function joinServer() {
  const id = (document.getElementById('join-server-id') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!id) return toast('Server ID required', 'error');
  const r = await apiFetch(`${API}/api/servers/${id}/join`, { method: 'POST' });
  const s = await r.json();
  if (!r.ok) return toast(s.error, 'error');
  closeModal('addserver-modal');
  await loadServers();
  toast(`Joined "${s.name}"!`, 'success');
}

async function joinByInvite() {
  const code = (document.getElementById('invite-code-input') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!code) return toast('Invite code required', 'error');
  const r = await apiFetch(`${API}/api/servers/invites/${code}/use`, { method: 'POST' });
  const s = await r.json();
  if (!r.ok) return toast(s.error, 'error');
  closeModal('addserver-modal');
  await loadServers();
  toast(`Joined "${s.name}"!`, 'success');
}

// â”€â”€ Davet Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _currentInviteUrl  = '';
let _currentInviteCode = '';
let _currentInviteQrSvg = '';

async function openInviteModal() {
  if (!currentServer) return;

  _currentInviteUrl  = '';
  _currentInviteCode = '';
  _currentInviteQrSvg = '';

  document.getElementById('invite-modal').style.display = 'flex';

  // Sunucu bilgisini doldur
  document.getElementById('invite-server-name').textContent    = currentServer.name || 'Sunucu';
  document.getElementById('invite-server-icon').textContent    = currentServer.icon || 'ğŸŒ';
  document.getElementById('invite-server-members').textContent = '';
  { const _t = document.getElementById('invite-link-input') as HTMLInputElement | null; if (_t) _t.value = 'OluÅŸturuluyor...'; }
  document.getElementById('invite-expiry').textContent         = '';
  document.getElementById('invite-qr-img').innerHTML           = 'YÃ¼kleniyor...';

  // Native share butonu: sadece destekleniyorsa gÃ¶ster
  const nativeBtn = document.getElementById('invite-native-share');
  if (nativeBtn) nativeBtn.style.display = navigator.share ? '' : 'none';

  try {
    // Davet oluÅŸtur
    const r = await apiFetch(`${API}/api/servers/invites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: currentServer._id }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);

    const instanceUrl = window.location.origin;
    _currentInviteCode = data.code;
    _currentInviteUrl  = `${instanceUrl}/invite/${data.code}`;

    { const _el = document.getElementById('invite-link-input') as HTMLInputElement | null; if (_el) _el.value = _currentInviteUrl; }

    const expiry = new Date(data.expiresAt).toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
    document.getElementById('invite-expiry').textContent =
      `â± ${expiry} tarihine kadar geÃ§erli â€¢ ${data.uses || 0} kullanÄ±m`;

    // Ãœye sayÄ±sÄ±nÄ± al
    try {
      const sr = await apiFetch(`${API}/api/servers/${currentServer._id}/members`);
      if (sr.ok) {
        const members = await sr.json();
        document.getElementById('invite-server-members').textContent =
          `ğŸ‘¥ ${Array.isArray(members) ? members.length : '?'} Ã¼ye`;
      }
    } catch { /* sessiz hata */ }

    // QR kod Ã§ek
    _loadInviteQr(data.code);

  } catch {
    _currentInviteUrl  = `${window.location.origin}/?invite=${currentServer._id}`;
    _currentInviteCode = currentServer._id;
    { const _el = document.getElementById('invite-link-input') as HTMLInputElement | null; if (_el) _el.value = _currentInviteUrl; }
    document.getElementById('invite-expiry').textContent   = 'Sunucu ID ile katÄ±lÄ±m';
    document.getElementById('invite-qr-img').textContent   = 'QR oluÅŸturulamadÄ±';
  }
}

async function _loadInviteQr(code) {
  const container = document.getElementById('invite-qr-img');
  try {
    const r = await apiFetch(`${API}/api/servers/invites/${code}/qr/data`);
    if (!r.ok) throw new Error('QR alÄ±namadÄ±');
    const data = await r.json();
    _currentInviteQrSvg = data.qrDataUrl || data.svg || data.dataUrl || '';
    if (_currentInviteQrSvg) {
      container.innerHTML = `<img src="${escHtml(_currentInviteQrSvg)}" alt="QR Kod" style="width:160px;height:160px;display:block">`;
    } else {
      container.textContent = 'QR desteklenmiyor';
    }
  } catch {
    container.textContent = 'QR oluÅŸturulamadÄ±';
  }
}

function copyInviteLink() {
  const url = _currentInviteUrl || (document.getElementById('invite-link-input') as HTMLInputElement | null)?.value ?? '';
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.getElementById('copy-btn-text');
    if (btn) { btn.textContent = 'âœ“ KopyalandÄ±'; setTimeout(() => { btn.textContent = 'Kopyala'; }, 2000); }
    toast('Davet linki kopyalandÄ±!', 'success');
  });
}

// Eski ismi de koruyalÄ±m (geriye dÃ¶nÃ¼k uyumluluk)
function copyInvite() { copyInviteLink(); }

function shareInvite(platform) {
  const url  = _currentInviteUrl;
  const name = currentServer?.name || 'Bridge Sunucusu';
  const text = `${name} topluluÄŸuna Bridge'de katÄ±l! ğŸŒ‰`;

  const urls = {
    whatsapp: `https://api.whatsapp.com/send?text=${encodeURIComponent(text + '\n' + url)}`,
    telegram: `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
    twitter:  `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
  };

  if (platform === 'native' && navigator.share) {
    navigator.share({ title: name, text, url }).catch(() => {});
    return;
  }

  if (urls[platform]) {
    window.open(urls[platform], '_blank', 'noopener,width=600,height=500');
  }
}

function downloadInviteQr() {
  if (!_currentInviteQrSvg) return toast('QR henÃ¼z hazÄ±r deÄŸil', 'error');
  const a = document.createElement('a');
  a.href     = _currentInviteQrSvg;
  a.download = `bridge-invite-${_currentInviteCode || 'qr'}.png`;
  a.click();
}

// â”€â”€ Sunucu MenÃ¼sÃ¼ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openServerMenu() {
  const existing = document.getElementById('server-ctx-menu');
  if (existing) { existing.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'server-ctx-menu';
  menu.className = 'ctx-menu';
  menu.style.cssText = 'position:absolute;top:48px;left:8px;z-index:9999;min-width:200px';
  menu.innerHTML = `
    <div class="ctx-item" onclick="copyServerId()">ğŸ“‹ Copy Server ID</div>
    <div class="ctx-item" onclick="openInviteModal();document.getElementById('server-ctx-menu')?.remove()">ğŸ”— Invite People</div>
    <div class="ctx-item" onclick="openEmojiManager();document.getElementById('server-ctx-menu')?.remove()">ğŸ˜€ Emoji YÃ¶netimi</div>
    <div class="ctx-item" onclick="openSoundboard();document.getElementById('server-ctx-menu')?.remove()">ğŸµ Soundboard</div>
    <div class="ctx-item" onclick="openDiscoverySettings();document.getElementById('server-ctx-menu')?.remove()">ğŸŒ KeÅŸif AyarlarÄ±</div>
    <div class="ctx-item" onclick="openServerSettings();document.getElementById('server-ctx-menu')?.remove()">âš™ï¸ Sunucu AyarlarÄ±</div>
    <div class="ctx-item" onclick="createChannel();document.getElementById('server-ctx-menu')?.remove()">â• Create Channel</div>
    <div class="ctx-item" onclick="promptAddCategory();document.getElementById('server-ctx-menu')?.remove()">ğŸ—‚ï¸ Kategori Ekle</div>
    <div class="ctx-item" onclick="openRoleManager();document.getElementById('server-ctx-menu')?.remove()">ğŸ‘‘ Manage Roles</div>
    <div class="ctx-item" onclick="openServerGifModal();document.getElementById('server-ctx-menu')?.remove()">ğŸï¸ Server GIFs</div>
    <div class="ctx-item" onclick="openBridgeModal();document.getElementById('server-ctx-menu')?.remove()">ğŸŒ‰ Channel Bridge</div>
    <div style="height:1px;background:var(--bg-5);margin:4px 0"></div>
    <div class="ctx-item" onclick="openServerStats();document.getElementById('server-ctx-menu')?.remove()">ğŸ“Š Sunucu Ä°statistikleri</div>
    <div class="ctx-item" onclick="openAutoModPanel();document.getElementById('server-ctx-menu')?.remove()">ğŸ›¡ï¸ AutoMod KurallarÄ±</div>
    <div class="ctx-item" onclick="openAuditLog();document.getElementById('server-ctx-menu')?.remove()">ğŸ“‹ Moderasyon GÃ¼nlÃ¼ÄŸÃ¼</div>`;

  document.getElementById('server-header-btn').style.position = 'relative';
  document.getElementById('server-header-btn').appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

function copyServerId() {
  navigator.clipboard.writeText(currentServer?._id || '').then(() => toast('Server ID copied!', 'success'));
  document.getElementById('server-ctx-menu')?.remove();
}

// â”€â”€ Rol YÃ¶neticisi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PERMS_LIST = [
  { key: 'MANAGE_CHANNELS', bit: 1,  label: 'Manage Channels' },
  { key: 'MANAGE_ROLES',    bit: 2,  label: 'Manage Roles' },
  { key: 'KICK_MEMBERS',    bit: 4,  label: 'Kick Members' },
  { key: 'BAN_MEMBERS',     bit: 8,  label: 'Ban Members' },
  { key: 'SEND_MESSAGES',   bit: 16, label: 'Send Messages' },
  { key: 'MANAGE_MESSAGES', bit: 32, label: 'Manage Messages' },
  { key: 'ADMINISTRATOR',   bit: 64, label: 'ğŸ‘‘ Administrator' },
];

async function openRoleManager() {
  if (!currentServer) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/roles`);
  const roles = await r.json();
  let modal = document.getElementById('role-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'role-modal';
    modal.className = 'modal-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };
    document.body.appendChild(modal);
  }
  const rolesHtml = roles.length
    ? roles.map(role => `
        <div class="role-row" style="border-left:4px solid ${role.color}">
          <strong style="color:${role.color}">${escHtml(role.name)}</strong>
          <span style="font-size:11px;color:var(--text-muted)">Perms: ${role.permissions}</span>
          <button class="btn" style="padding:2px 8px;font-size:12px"
            data-roleid="${escHtml(role._id)}"
            onclick="showDeleteRoleModal(this.dataset.roleid)">ğŸ—‘ï¸</button>
        </div>`).join('')
    : '<p style="color:var(--text-muted)">No roles yet.</p>';

  const permsHtml = PERMS_LIST.map(p => `
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer">
      <input type="checkbox" class="perm-check" data-bit="${p.bit}" ${p.key === 'SEND_MESSAGES' ? 'checked' : ''}>
      ${p.label}
    </label>`).join('');

  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%">
      <h2>ğŸ‘‘ Role Manager</h2>
      <div id="role-list-inner">${rolesHtml}</div>
      <hr style="border-color:var(--bg-3);margin:12px 0">
      <h3 style="font-size:14px;margin-bottom:8px">Create New Role</h3>
      <div class="form-group"><label>Name</label><input type="text" id="new-role-name" placeholder="Moderator"></div>
      <div class="form-group"><label>Color</label><input type="color" id="new-role-color" value="#5865f2"></div>
      <div class="form-group"><label>Permissions</label><div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">${permsHtml}</div></div>
      <div class="modal-footer">
        <button class="btn btn-primary" style="flex:1" onclick="createRole()">Create Role</button>
        <button class="btn" style="flex:1" onclick="document.getElementById('role-modal').style.display='none'">Close</button>
      </div>
    </div>`;
  modal.style.display = 'flex';
}

async function createRole() {
  const name = (document.getElementById('new-role-name') as HTMLInputElement | null)?.value ?? ''.trim();
  const color = (document.getElementById('new-role-color') as HTMLInputElement | null)?.value ?? '';
  if (!name) return toast('Role name required', 'error');
  let permissions = 0;
  document.querySelectorAll('.perm-check:checked').forEach(cb => { permissions |= parseInt(cb.dataset.bit); });
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, color, permissions }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error, 'error');
  toast(`Role "${data.name}" created`, 'success');
  openRoleManager();
}

function showDeleteRoleModal(roleId) {
  showConfirmModal({
    title: 'Delete Role',
    message: 'This role will be permanently deleted.',
    confirmText: 'Delete',
    danger: true,
    onConfirm: async () => {
      const r = await apiFetch(`${API}/api/servers/${currentServer._id}/roles/${roleId}`, { method: 'DELETE' });
      if (!r.ok) return toast('Failed', 'error');
      toast('Role deleted', 'success');
      openRoleManager();
    },
  });
}

// â”€â”€ Kategori â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function promptAddCategory() {
  if (!currentServer) return;
  showInputModal({
    title: 'Kategori Ekle',
    label: 'Kategori adÄ±',
    confirmText: 'OluÅŸtur',
    onConfirm: async name => {
      if (!name.trim()) return;
      try {
        const r = await apiFetch(`${API}/api/servers/${currentServer._id}/categories`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const cat = await r.json();
        if (!r.ok) return toast(cat.error || 'Hata', 'error');
        socket.emit('category:created', { serverId: currentServer._id, category: cat });
        toast('Kategori oluÅŸturuldu', 'success');
        await loadChannels(currentServer._id);
      } catch { toast('Hata', 'error'); }
    },
  });
}

