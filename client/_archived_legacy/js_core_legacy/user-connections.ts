// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/UserConnectionsPanel.svelte
//              client/js/core/user-connections-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/user-connections.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Kullanıcı sosyal bağlantıları: profil sayfasında göster + ayarlardan düzenle

import { BridgeRegistry } from './bridge-registry.js';

declare function apiFetch(url: string): Promise<Response>;
declare function toast(msg: string, type?: string): void;
declare function escHtml(s: string): string;
declare const API: string;

// ── Tip tanımları ─────────────────────────────────────────────

interface Platform {
  id: string;
  label: string;
  icon: string;
  placeholder: string;
}

interface UserConnection {
  platform: string;
  username: string;
  url?: string;
}

// ── Platform listesi ──────────────────────────────────────────

const CONNECTION_PLATFORMS: Platform[] = [
  { id: 'github',   label: 'GitHub',      icon: '🐙', placeholder: 'kullaniciadi' },
  { id: 'twitter',  label: 'X (Twitter)', icon: '🐦', placeholder: 'kullaniciadi' },
  { id: 'twitch',   label: 'Twitch',      icon: '💜', placeholder: 'kanal_adi' },
  { id: 'youtube',  label: 'YouTube',     icon: '▶️',  placeholder: '@kanal' },
  { id: 'steam',    label: 'Steam',       icon: '🎮', placeholder: 'steam_adi' },
  { id: 'spotify',  label: 'Spotify',     icon: '🎵', placeholder: 'spotify_id' },
  { id: 'linkedin', label: 'LinkedIn',    icon: '💼', placeholder: 'profil_adi' },
  { id: 'website',  label: 'Website',     icon: '🌐', placeholder: 'https://...' },
];

// ── Settings Modal — Bağlantılar Sekmesi ─────────────────────

export async function loadConnectionsSettings(): Promise<void> {
  const container = document.getElementById('connections-settings-container');
  if (!container) return;
  container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Yükleniyor...</div>';

  const r = await apiFetch(`${API}/api/me/connections`);
  const existing: UserConnection[] = r.ok ? await r.json() : [];
  const map: Record<string, UserConnection> = {};
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
      ${conn
        ? `<button class="btn btn-sm" style="color:var(--danger)" onclick="removeConnection('${p.id}')">✕</button>`
        : '<span style="width:28px"></span>'}`;
    container.appendChild(row);
  }
}

export async function saveConnection(platform: string): Promise<void> {
  const input = document.getElementById(`conn-${platform}`) as HTMLInputElement | null;
  if (!input) return;
  const username = input.value.trim();
  if (!username) { await removeConnection(platform); return; }

  const r = await apiFetch(`${API}/api/me/connections`);
  // PUT to save
  await fetch(`${API}/api/me/connections`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('token')}` },
    body: JSON.stringify({ platform, username }),
  });
  toast(`${platform} bağlantısı kaydedildi`, 'success');
}

export async function removeConnection(platform: string): Promise<void> {
  await fetch(`${API}/api/me/connections/${platform}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` },
  });
  await loadConnectionsSettings();
  toast(`${platform} bağlantısı kaldırıldı`, 'info');
}

// ── Profil sayfasında göster ───────────────────────────────────

export function renderUserConnections(connections: UserConnection[], container: HTMLElement): void {
  if (!connections.length) { container.style.display = 'none'; return; }
  container.style.display = '';
  container.innerHTML = connections.map(c => {
    const p = CONNECTION_PLATFORMS.find(x => x.id === c.platform);
    const icon = p?.icon ?? '🔗';
    const label = p?.label ?? c.platform;
    const href = c.url ?? '#';
    return `<a href="${escHtml(href)}" target="_blank" rel="noopener noreferrer" class="user-connection-link">
      <span>${icon}</span><span>${label}</span>
    </a>`;
  }).join('');
}

// ── BridgeRegistry bağlantısı ─────────────────────────────────

BridgeRegistry.register('loadConnectionsSettings', loadConnectionsSettings);
BridgeRegistry.register('saveConnection', saveConnection);
BridgeRegistry.register('removeConnection', removeConnection);
BridgeRegistry.register('renderUserConnections', renderUserConnections);
