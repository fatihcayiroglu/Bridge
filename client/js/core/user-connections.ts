// client/js/core/user-connections.js
// KullanÄ±cÄ± sosyal baÄŸlantÄ±larÄ±: profil sayfasÄ±nda gÃ¶ster + ayarlardan dÃ¼zenle

'use strict';

const CONNECTION_PLATFORMS = [
  { id: 'github',   label: 'GitHub',      icon: 'ğŸ™', placeholder: 'kullaniciadi' },
  { id: 'twitter',  label: 'X (Twitter)', icon: 'ğŸ¦', placeholder: 'kullaniciadi' },
  { id: 'twitch',   label: 'Twitch',      icon: 'ğŸ’œ', placeholder: 'kanal_adi' },
  { id: 'youtube',  label: 'YouTube',     icon: 'â–¶ï¸',  placeholder: '@kanal' },
  { id: 'steam',    label: 'Steam',       icon: 'ğŸ®', placeholder: 'steam_adi' },
  { id: 'spotify',  label: 'Spotify',     icon: 'ğŸµ', placeholder: 'spotify_id' },
  { id: 'linkedin', label: 'LinkedIn',    icon: 'ğŸ’¼', placeholder: 'profil_adi' },
  { id: 'website',  label: 'Website',     icon: 'ğŸŒ', placeholder: 'https://...' },
];

// â”€â”€ Settings Modal â€” BaÄŸlantÄ±lar Sekmesi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadConnectionsSettings() {
  const container = document.getElementById('connections-settings-container');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">YÃ¼kleniyor...</div>';

  const r = await apiFetch(`${API}/api/me/connections`);
  const existing = r.ok ? await r.json() : [];
  const map = {};
  for (const c of existing) map[c.platform] = c;

  container.innerHTML = '';
  for (const p of CONNECTION_PLATFORMS) {
    const conn = map[p.id];
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)';
    row.innerHTML = `
      <span style="width:26px;text-align:center;font-size:18px">${p.icon}</span>
      <span style="width:90px;font-size:13px;font-weight:500">${p.label}</span>
      <input type="text" id="conn-${p.id}" class="input-field" placeholder="${p.placeholder}"
        value="${conn ? escHtml(conn.username) : ''}" style="flex:1;font-size:13px;padding:6px 10px">
      <button class="btn btn-sm btn-primary" onclick="saveConnection('${p.id}')">Kaydet</button>
      ${conn ? `<button class="btn btn-sm" style="color:var(--danger)" onclick="removeConnection('${p.id}')">âœ•</button>` : '<span style="width:28px"></span>'}`;
    container.appendChild(row);
  }
}

async function saveConnection(platform) {
  const input = document.getElementById(`conn-${platform}`);
  if (!input) return;
  const username = input.value.trim();
  if (!username) { await removeConnection(platform); return; }

  const r = await apiFetch(`${API}/api/me/connections/${platform}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Kaydedilemedi', 'error');
  toast(`${data.label || platform} baÄŸlantÄ±sÄ± kaydedildi! ${data.icon || ''}`, 'success');
  await loadConnectionsSettings();
}

async function removeConnection(platform) {
  const r = await apiFetch(`${API}/api/me/connections/${platform}`, { method: 'DELETE' });
  if (!r.ok) return toast('KaldÄ±rÄ±lamadÄ±', 'error');
  const meta = CONNECTION_PLATFORMS.find(p => p.id === platform);
  toast(`${meta?.label || platform} baÄŸlantÄ±sÄ± kaldÄ±rÄ±ldÄ±`, 'success');
  await loadConnectionsSettings();
}

// â”€â”€ Profil Popup'ta BaÄŸlantÄ±lar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderUserConnectionsInProfile(userId, containerEl) {
  if (!containerEl) return;
  const r = await apiFetch(`${API}/api/users/${userId}/connections`);
  if (!r.ok) return;
  const connections = await r.json();
  if (!connections.length) return;

  const section = document.createElement('div');
  section.style.cssText = 'margin-top:10px;border-top:1px solid var(--border);padding-top:8px';
  section.innerHTML = `<div style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">BaÄŸlantÄ±lar</div>`;

  for (const c of connections) {
    const link = document.createElement('a');
    link.href   = c.url || '#';
    link.target = '_blank';
    link.rel    = 'noopener noreferrer';
    link.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;color:var(--text-1);text-decoration:none;font-size:13px;transition:background .15s';
    link.onmouseover = () => link.style.background = 'var(--bg-3)';
    link.onmouseout  = () => link.style.background = '';
    link.innerHTML   = `<span style="font-size:16px">${c.icon || 'ğŸ”—'}</span><span style="font-weight:500">${escHtml(c.label)}</span><span style="color:var(--text-muted);font-size:12px">${escHtml(c.username)}</span>`;
    section.appendChild(link);
  }
  containerEl.appendChild(section);
}

// â”€â”€ Kendi profilinde badge gÃ¶ster (header alanÄ±) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function renderMyConnectionsBadges() {
  const r = await apiFetch(`${API}/api/me/connections`);
  if (!r.ok) return;
  const connections = await r.json();
  const container = document.getElementById('my-connections-badges');
  if (!container) return;
  container.innerHTML = '';
  for (const c of connections.slice(0, 5)) {
    const span = document.createElement('span');
    span.title  = `${c.label}: ${c.username}`;
    span.style.cssText = 'font-size:18px;cursor:default';
    span.textContent   = c.icon || 'ğŸ”—';
    container.appendChild(span);
  }
}

