// client/js/marketplace.ts — Bot Marketplace UI
// Sprint 38: window.* → BridgeRegistry geçişi

import { BridgeRegistry } from './core/bridge-registry.ts';
import { getAPI } from './core/globals.ts';

let currentCategory = 'all';
let searchDebounce: ReturnType<typeof setTimeout> | null = null;

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openMarketplacePage(): void {
  window.location.href = '/marketplace';
}

async function openBotMarketplace(): Promise<void> {
  document.getElementById('temp-modal')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'marketplace-modal';
  overlay.className = 'modal-overlay';
  overlay.style.cssText = 'z-index:10000;';
  overlay.innerHTML = `
    <div class="modal-card" style="max-width:800px;width:96%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;padding:0">
      <div style="padding:20px 24px 12px;border-bottom:1px solid var(--bg-4);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <h2 style="font-size:20px;font-weight:800">🤖 Bot Marketplace</h2>
          <p style="color:var(--text-3);font-size:13px;margin-top:2px">Bridge için botları keşfet ve sunucuna ekle</p>
        </div>
        <button data-bridge-action="closeMarketplace" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-3);padding:4px 8px">✕</button>
      </div>
      <div style="padding:12px 24px;border-bottom:1px solid var(--bg-4);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="mkt-search" type="text" class="input-field" placeholder="🔍 Bot ara..." style="flex:1;min-width:160px;padding:8px 12px;font-size:13px">
      </div>
      <div id="mkt-cats" style="padding:10px 24px;border-bottom:1px solid var(--bg-4);display:flex;gap:6px;flex-wrap:wrap;overflow-x:auto"></div>
      <div id="mkt-grid" style="overflow-y:auto;flex:1;padding:16px 24px" class="marketplace-grid">
        <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3)">Yükleniyor...</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  const searchInput = overlay.querySelector<HTMLInputElement>('#mkt-search');
  searchInput?.addEventListener('input', (e) => {
    debounceMktSearch((e.target as HTMLInputElement).value);
  });

  await loadMarketplaceCategories();
  await loadMarketplaceBots();
}

async function loadMarketplaceCategories(): Promise<void> {
  const API = getAPI();
  const token = localStorage.getItem('token');
  const r = await fetch(`${API}/api/bots/marketplace/categories`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const cats = r.ok ? await r.json() as Array<{ id: string; icon: string; label: string }> : [];
  const container = document.getElementById('mkt-cats');
  if (!container) return;
  container.innerHTML = cats.map(c =>
    `<button class="filter-chip ${c.id === currentCategory ? 'active' : ''}" data-bridge-action="setMktCategory" data-bridge-arg="${c.id}" data-cat="${c.id}">
      ${c.icon} ${escHtml(c.label)}
    </button>`,
  ).join('');
}

async function setMktCategory(cat: string): Promise<void> {
  currentCategory = cat;
  document.querySelectorAll('#mkt-cats .filter-chip').forEach((b) =>
    b.classList.toggle('active', (b as HTMLElement).dataset['cat'] === cat));
  await loadMarketplaceBots();
}

function debounceMktSearch(val: string): void {
  if (searchDebounce) clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => void loadMarketplaceBots(val), 320);
}

async function loadMarketplaceBots(q = ''): Promise<void> {
  const grid = document.getElementById('mkt-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-3)">Yükleniyor...</div>';

  const API = getAPI();
  const token = localStorage.getItem('token');
  const params = new URLSearchParams({ category: currentCategory, limit: '60' });
  if (q) params.set('q', q);
  const r = await fetch(`${API}/api/bots/marketplace?${params}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // Server returns {bots: [...], total: N, limit, offset}
  const payload = r.ok ? await r.json() as { bots: Array<Record<string, unknown>>; total: number } : { bots: [], total: 0 };
  const bots: Array<Record<string, unknown>> = Array.isArray(payload.bots) ? payload.bots : [];

  if (!bots.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3)"><div style="font-size:40px;margin-bottom:8px">🤖</div><div>Bu kategoride bot bulunamadı</div></div>';
    return;
  }

  grid.innerHTML = '';
  for (const bot of bots) {
    const card = document.createElement('div');
    card.className = 'bot-card';
    const rating = Number(bot['rating'] || 0);
    const stars = '⭐'.repeat(Math.min(5, Math.round(rating)));
    // Server field names: name, avatar, installs, id (not username, icon, serverCount, _id)
    const displayName = String(bot['name'] ?? bot['username'] ?? 'Unknown Bot');
    const avatar      = String(bot['avatar'] ?? bot['icon'] ?? '🤖');
    const installs    = Number(bot['installs'] ?? bot['serverCount'] ?? 0);
    const botId       = String(bot['id'] ?? bot['_id'] ?? '');
    const cmdCount    = Array.isArray(bot['commands']) ? (bot['commands'] as unknown[]).length : 0;
    card.innerHTML = `
      <div class="bot-card-header">
        <div class="bot-avatar">${avatar.startsWith('http') ? `<img src="${escHtml(avatar)}" width="44" height="44" style="border-radius:50%">` : `<span style="font-size:32px">${escHtml(avatar)}</span>`}</div>
        <div>
          <div class="bot-name">${escHtml(displayName)} ${bot['verified'] ? '<span class="bot-verified-badge">✓ Doğrulandı</span>' : ''}</div>
          <div class="bot-category">${escHtml(String(bot['category'] ?? ''))}</div>
        </div>
      </div>
      <div class="bot-desc">${escHtml(String(bot['description'] || 'Açıklama yok.'))}</div>
      <div class="bot-stats">
        <span title="Sunucu sayısı">🌐 ${installs.toLocaleString()} sunucu</span>
        <span title="Komut sayısı">⚡ ${cmdCount} komut</span>
        ${rating ? `<span title="Puan">${stars} ${rating.toFixed(1)}</span>` : ''}
      </div>
      <button class="bot-add-btn" data-bridge-action="addBotToServer" data-bridge-arg="${escHtml(botId)}" data-bot-name="${escHtml(displayName)}">+ Sunucuya Ekle</button>`;
    grid.appendChild(card);
  }
}

async function addBotToServer(botId: string, botName?: string): Promise<void> {
  const currentServer = BridgeRegistry.get<() => { _id: string } | null>('getCurrentServer')?.();
  const toast = BridgeRegistry.get<(msg: string, type: string) => void>('toast');
  if (!currentServer) { toast?.('Önce bir sunucu seç', 'error'); return; }

  const API = getAPI();
  const token = localStorage.getItem('token');
  const r = await fetch(`${API}/api/servers/${currentServer._id}/bots/${botId}/add`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await r.json() as { error?: string };
  if (!r.ok) { toast?.(data.error ?? 'Eklenemedi', 'error'); return; }
  toast?.(`${botName ?? botId} sunucuya eklendi! 🤖`, 'success');
}

// ── Registry kayıtları ────────────────────────────────────────────────────────
BridgeRegistry.register('openMarketplacePage',  openMarketplacePage);
BridgeRegistry.register('openBotMarketplace',   openBotMarketplace as (...a: unknown[]) => unknown);
BridgeRegistry.register('setMktCategory',       setMktCategory as (...a: unknown[]) => unknown);
BridgeRegistry.register('debounceMktSearch',    debounceMktSearch as (...a: unknown[]) => unknown);
BridgeRegistry.register('addBotToServer',       addBotToServer as (...a: unknown[]) => unknown);
BridgeRegistry.register('closeMarketplace',     () => document.getElementById('marketplace-modal')?.remove());

// ── CSS ───────────────────────────────────────────────────────────────────────
const style = document.createElement('style');
style.textContent = `
  .filter-chip { background: var(--bg-3); border: 1px solid var(--bg-4); border-radius: 20px; padding: 5px 12px; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; transition: all .15s; white-space: nowrap; }
  .filter-chip:hover { border-color: var(--brand); color: var(--text-1); }
  .filter-chip.active { background: var(--brand); border-color: var(--brand); color: #fff; }
`;
document.head.appendChild(style);

export { openBotMarketplace, openMarketplacePage, setMktCategory, addBotToServer };
