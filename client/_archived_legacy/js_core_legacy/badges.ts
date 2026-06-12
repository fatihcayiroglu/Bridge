// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/BadgesPanel.svelte
//              client/js/core/badges-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/badges.ts
// Sprint 43: JS→TS geçişi
// Rozet sistemi — istemci tarafı

import { getMe, getAPI } from './globals.js';
import { apiFetch } from './api-fetch.js';
import { BridgeRegistry } from './bridge-registry.js';
import { escHtml } from './utils.js';

interface Badge {
  badge: string;
  label: string;
  icon: string;
  description?: string;
}

[c] ?? c)
  );
}

export async function renderUserBadges(userId: string, container: HTMLElement): Promise<void> {
  if (!container) return;
  container.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Yükleniyor…</span>';

  try {
    const r = await apiFetch(`${getAPI()}/api/users/${userId}/badges`);
    if (!r.ok) { container.innerHTML = ''; return; }
    const badges: Badge[] = await r.json();

    if (!badges.length) {
      container.innerHTML = '<span style="color:var(--text-muted);font-size:12px">Henüz rozet yok</span>';
      return;
    }

    container.innerHTML = badges.map(b => `
      <span class="badge-chip" title="${escHtml(b.description ?? b.label)}"
        style="display:inline-flex;align-items:center;gap:4px;
               background:var(--bg-3);border:1px solid var(--border);
               border-radius:12px;padding:2px 8px;font-size:12px;
               cursor:default;user-select:none">
        <span>${escHtml(b.icon)}</span>
        <span>${escHtml(b.label)}</span>
      </span>
    `).join('');
  } catch {
    container.innerHTML = '';
  }
}

export async function injectBadgesIntoProfileCard(userId: string, cardEl: HTMLElement): Promise<void> {
  const existingRow = cardEl.querySelector('.profile-badges-row');
  if (existingRow) return;

  const row = document.createElement('div');
  row.className = 'profile-badges-row';
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';

  const bio = cardEl.querySelector<HTMLElement>('.profile-bio, .profile-status');
  if (bio) bio.insertAdjacentElement('afterend', row);
  else     cardEl.appendChild(row);

  await renderUserBadges(userId, row);
}

export async function loadMyBadgesSettings(): Promise<void> {
  const container = document.getElementById('my-badges-container');
  if (!container) return;
  const me = getMe() as { _id?: string } | null;
  const userId = me?._id;
  if (!userId) return;
  await renderUserBadges(userId, container);
}

export async function loadAdminBadgePanel(): Promise<void> {
  const container = document.getElementById('admin-badge-panel');
  if (!container) return;

  const defsRes = await apiFetch(`${getAPI()}/api/badges/definitions`);
  const defs: Badge[] = defsRes.ok ? await defsRes.json() : [];

  container.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:8px;align-items:flex-end">
        <div style="flex:1">
          <label style="font-size:12px;color:var(--text-muted)">Kullanıcı ID</label>
          <input id="ab-userid" class="input-field" placeholder="userId…" style="width:100%">
        </div>
        <div style="flex:1">
          <label style="font-size:12px;color:var(--text-muted)">Rozet</label>
          <select id="ab-badge" class="input-field" style="width:100%">
            ${defs.map(d => `<option value="${escHtml(d.badge)}">${escHtml(d.icon)} ${escHtml(d.label)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="adminAwardBadge()">✅ Ver</button>
        <button class="btn" style="color:var(--danger)" onclick="adminRevokeBadge()">❌ Geri Al</button>
      </div>
      <div id="ab-result" style="font-size:13px;min-height:20px"></div>
    </div>
  `;
}

export async function adminAwardBadge(): Promise<void> {
  const userId = (document.getElementById('ab-userid') as HTMLInputElement)?.value.trim();
  const badge  = (document.getElementById('ab-badge') as HTMLSelectElement)?.value;
  const result = document.getElementById('ab-result');
  if (!userId || !badge) { if (result) result.textContent = 'userId ve badge gerekli'; return; }

  const r = await apiFetch(`${getAPI()}/api/admin/badges/award`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, badge }),
  });
  const d = await r.json() as { label?: string; error?: string };
  if (result) result.textContent = r.ok ? `✅ Rozet verildi: ${d.label ?? badge}` : `❌ ${d.error}`;
}

export async function adminRevokeBadge(): Promise<void> {
  const userId = (document.getElementById('ab-userid') as HTMLInputElement)?.value.trim();
  const badge  = (document.getElementById('ab-badge') as HTMLSelectElement)?.value;
  const result = document.getElementById('ab-result');
  if (!userId || !badge) { if (result) result.textContent = 'userId ve badge gerekli'; return; }

  const r = await apiFetch(`${getAPI()}/api/admin/badges/revoke`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, badge }),
  });
  const d = await r.json() as { error?: string };
  if (result) result.textContent = r.ok ? '✅ Rozet alındı' : `❌ ${d.error}`;
}

// BridgeRegistry
BridgeRegistry.register('renderUserBadges',            (...a: Parameters<typeof renderUserBadges>) => renderUserBadges(...a));
BridgeRegistry.register('injectBadgesIntoProfileCard', (...a: Parameters<typeof injectBadgesIntoProfileCard>) => injectBadgesIntoProfileCard(...a));
BridgeRegistry.register('loadMyBadgesSettings',        () => loadMyBadgesSettings());
BridgeRegistry.register('loadAdminBadgePanel',         () => loadAdminBadgePanel());
BridgeRegistry.register('adminAwardBadge',             () => adminAwardBadge());
BridgeRegistry.register('adminRevokeBadge',            () => adminRevokeBadge());
