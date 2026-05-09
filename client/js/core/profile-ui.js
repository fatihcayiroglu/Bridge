// core/profile-ui.js
// Profil önizleme, banner yükleme/kaldırma, üye profil popup

// ── Profil Önizleme ───────────────────────────────────────────
function updateProfilePreview() {
  const name    = document.getElementById('s-displayname')?.value || me?.displayName || 'User';
  const bio     = document.getElementById('s-bio')?.value || '';
  const color   = document.getElementById('s-banner-color')?.value || (me?.bannerColor || '#5865f2');
  const preview = document.getElementById('profile-preview-card');
  if (!preview) return;

  const avatarColor = me?.avatarColor || '#5865f2';
  const avatarUrl   = me?.avatarUrl;
  const avatarHtml  = avatarUrl
    ? `<img src="${API}${avatarUrl}" style="width:70px;height:70px;border-radius:50%;border:3px solid var(--bg-primary);object-fit:cover;">`
    : `<div style="width:70px;height:70px;border-radius:50%;background:${avatarColor};display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;border:3px solid var(--bg-primary)">${initials(name)}</div>`;

  const bannerImgPreview = document.getElementById('banner-preview-img');
  const bannerSrc = bannerImgPreview?.src && bannerImgPreview.src !== window.location.href
    ? bannerImgPreview.src
    : (me?.bannerUrl ? API + me.bannerUrl : null);
  const bannerStyle = bannerSrc
    ? `background:url('${bannerSrc}') center/cover no-repeat;`
    : `background:${color};`;

  preview.innerHTML = `
    <div style="border-radius:10px;overflow:hidden;background:var(--bg-secondary);border:1px solid var(--border);">
      <div style="height:60px;${bannerStyle}"></div>
      <div style="padding:0 12px 12px;margin-top:-35px;">
        ${avatarHtml}
        <div style="font-weight:700;margin-top:6px;font-size:15px;">${escHtml(name)}</div>
        ${bio ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${escHtml(bio.slice(0, 80))}</div>` : ''}
      </div>
    </div>`;
}

// ── Banner Yükleme / Kaldırma ─────────────────────────────────
async function uploadProfileBanner(input) {
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { toast('Max 10MB', 'error'); input.value = ''; return; }

  const reader = new FileReader();
  reader.onload = (e) => {
    const wrap = document.getElementById('banner-preview-wrap');
    const img  = document.getElementById('banner-preview-img');
    if (wrap && img) { img.src = e.target.result; wrap.style.display = 'block'; }
    updateProfilePreview();
  };
  reader.readAsDataURL(file);

  const formData = new FormData();
  formData.append('banner', file);
  try {
    const r = await fetch(`${API}/api/me/banner`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await r.json();
    if (!r.ok) { toast(data.error || 'Yükleme başarısız', 'error'); return; }
    if (me) me.bannerUrl = data.bannerUrl;
    toast('Banner güncellendi! 🎨', 'success');
    updateProfilePreview();
  } catch { toast('Bağlantı hatası', 'error'); }
}

async function removeProfileBanner() {
  try {
    const r = await apiFetch(`${API}/api/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bannerUrl: null }),
    });
    if (!r.ok) { toast('Kaldırılamadı', 'error'); return; }
    if (me) me.bannerUrl = null;
    const wrap      = document.getElementById('banner-preview-wrap');
    const img       = document.getElementById('banner-preview-img');
    const fileInput = document.getElementById('banner-file-input');
    if (wrap) wrap.style.display = 'none';
    if (img)  img.src = '';
    if (fileInput) fileInput.value = '';
    toast('Banner kaldırıldı', 'success');
    updateProfilePreview();
  } catch { toast('Hata', 'error'); }
}

// ── Üye Profil Popup ──────────────────────────────────────────
function showMemberProfile(e, userId, displayName, avatarColor, bio, badge) {
  document.querySelector('.member-profile-popup')?.remove();

  const popup = document.createElement('div');
  popup.className = 'member-profile-popup';
  const badgeHtml = badge ? `<span style="display:inline-block;padding:2px 8px;background:var(--brand);color:#fff;border-radius:4px;font-size:11px;font-weight:700;margin-top:4px">${escHtml(badge)}</span>` : '';
  const isMe = userId === me?.id;

  popup.innerHTML = `
    <div class="profile-banner" style="background:${cssColor(avatarColor)}"></div>
    <div style="padding:12px">
      <div class="profile-avatar" style="background:${cssColor(avatarColor)};margin-top:-28px;border:3px solid var(--bg-1)">${initials(displayName)}</div>
      <div class="profile-name">${escHtml(displayName)}</div>
      ${badgeHtml}
      ${bio ? `<div class="profile-bio">${escHtml(bio)}</div>` : ''}
      <div style="display:flex;gap:6px;margin-top:10px">
        ${!isMe ? `<button class="btn btn-primary" style="flex:1;padding:7px;font-size:12px"
          onclick="openDmWithUser('${userId}','${escHtml(displayName)}','${cssColor(avatarColor)}')">💬 DM</button>` : ''}
        ${!isMe ? `<button class="btn" style="padding:7px;font-size:12px;background:var(--bg-3);color:#ed4245;border:1px solid #ed4245" title="Engelle"
          onclick="document.querySelector('.member-profile-popup')?.remove();_blockUser('${userId}','${escHtml(displayName)}')">🚫</button>` : ''}
      </div>
      <div id="profile-mod-${userId}"></div>
    </div>`;

  popup.style.cssText = 'position:fixed;z-index:800;';
  document.body.appendChild(popup);

  const rect = e.currentTarget?.getBoundingClientRect?.() || e;
  const x = rect.right + 10;
  const y = Math.min(rect.top, window.innerHeight - 280);
  popup.style.left = Math.min(x, window.innerWidth - 270) + 'px';
  popup.style.top  = Math.max(y, 10) + 'px';

  setTimeout(() => document.addEventListener('click', ev => {
    if (!popup.contains(ev.target)) popup.remove();
  }, { once: true }), 50);

  // Sunucu sahibiyse "Sustur" butonu ekle
  if (currentServer && userId !== me?._id) {
    getMemberPermsClient(currentServer._id).then(perms => {
      if (!perms?.canManage) return;
      const modDiv = document.getElementById(`profile-mod-${userId}`);
      if (!modDiv) return;
      modDiv.innerHTML = `
        <hr style="border:none;border-top:1px solid var(--bg-5);margin:8px 0">
        <button class="btn btn-danger" style="width:100%;padding:7px;font-size:12px"
          onclick="document.querySelector('.member-profile-popup')?.remove();openTimeoutModal('${userId}','${escHtml(displayName)}')">
          ⏱️ Sustur
        </button>`;
    });
  }
}

async function getMemberPermsClient(serverId) {
  try {
    const servers = await apiFetch(`${API}/api/servers`).then(r => r.json());
    const server  = servers.find(s => s._id === serverId);
    return { canManage: server?.ownerId === me?._id };
  } catch { return { canManage: false }; }
}

export {
  getMemberPermsClient,
  removeProfileBanner,
  showMemberProfile,
  updateProfilePreview,
  uploadProfileBanner,
};

