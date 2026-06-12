// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/IndexPanel.svelte
//              client/js/core/index-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/bot-marketplace/index.ts  (Sprint 91 — full UI)
// Bot Marketplace: arama, kategori filtresi, bot detayı, sunucuya ekleme

import { BOT_CATALOG, BOT_CATEGORIES, BotListing, BotCategory } from './catalog-data.js';
import { apiFetch }          from '../api-fetch.js';
import { getAPI, getCurrentServer } from '../globals.js';
import { escHtml, toast }    from '../utils.js';
import { BridgeRegistry }    from '../bridge-registry.js';

// ── State ─────────────────────────────────────────────────────────────────────

let _query    = '';
let _category: BotCategory | '' = '';
let _sortBy: 'popular' | 'rating' | 'new' | 'name' = 'popular';
let _installedBotIds = new Set<string>();

// ── Open marketplace modal ────────────────────────────────────────────────────

export async function openBotMarketplace(): Promise<void> {
  const server = getCurrentServer() as { _id?: string; name?: string } | null;
  if (!server?._id) return toast('Önce bir sunucu seç', 'error');

  document.getElementById('bot-marketplace-modal')?.remove();

  // Load already added bots
  try {
    const API = getAPI();
    const r = await apiFetch(`${API}/api/servers/${server._id}/bots`);
    if (r.ok) {
      const bots: Array<{ id?: string; clientId?: string }> = await r.json();
      _installedBotIds = new Set(bots.map(b => b.id ?? b.clientId ?? '').filter(Boolean));
    }
  } catch { _installedBotIds = new Set(); }

  _query    = '';
  _category = '';
  _sortBy   = 'popular';

  const modal = document.createElement('div');
  modal.id        = 'bot-marketplace-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'align-items:stretch;';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:900px;width:97%;max-height:92vh;padding:0;display:flex;flex-direction:column;overflow:hidden;">

      <!-- Header -->
      <div style="padding:20px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;flex-shrink:0;">
        <div style="flex:1;">
          <h2 style="margin:0;font-size:20px;font-weight:800;">🤖 Bot Marketi</h2>
          <p style="margin:3px 0 0;font-size:12px;color:var(--text-3);">Sunucunu güçlendir — ${BOT_CATALOG.length} bot mevcut</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <button class="btn btn-secondary" style="font-size:12px;padding:6px 12px;" onclick="window._bmOpenAddCustom()">🔗 Özel Bot Ekle</button>
          <button class="icon-btn" onclick="document.getElementById('bot-marketplace-modal').remove()" aria-label="Kapat">✕</button>
        </div>
      </div>

      <!-- Search + filter bar -->
      <div style="padding:14px 24px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap;flex-shrink:0;background:var(--bg-secondary);">
        <div style="flex:1;min-width:200px;position:relative;">
          <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-3);font-size:14px;">🔍</span>
          <input id="bm-search" type="text" placeholder="Bot ara..." value="${escHtml(_query)}"
            style="width:100%;padding:8px 12px 8px 32px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;"
            oninput="window._bmSearch(this.value)">
        </div>
        <select id="bm-sort" style="padding:8px 10px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;"
          onchange="window._bmSetSort(this.value)">
          <option value="popular" selected>📈 Popüler</option>
          <option value="rating">⭐ En İyi Puan</option>
          <option value="new">✨ En Yeni</option>
          <option value="name">🔤 A-Z</option>
        </select>
      </div>

      <!-- Category tabs -->
      <div style="padding:10px 24px;border-bottom:1px solid var(--border);display:flex;gap:6px;overflow-x:auto;flex-shrink:0;">
        <button class="bm-cat-btn${_category===''?' active':''}" onclick="window._bmSetCat('')" style="${_catBtnStyle(_category==='')}">🌟 Tümü</button>
        ${BOT_CATEGORIES.map(c => `
          <button class="bm-cat-btn${_category===c.id?' active':''}" onclick="window._bmSetCat('${c.id}')" style="${_catBtnStyle(_category===c.id)}">${c.icon} ${c.label}</button>`).join('')}
      </div>

      <!-- Bot grid -->
      <div id="bm-grid" style="flex:1;overflow-y:auto;padding:20px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;align-content:start;">
        ${_renderGrid()}
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// ── Render helpers ────────────────────────────────────────────────────────────

function _renderGrid(): string {
  const bots = _filtered();
  if (!bots.length) return `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3);">😕 Sonuç bulunamadı</div>`;
  return bots.map(_renderCard).join('');
}

function _filtered(): BotListing[] {
  let list = [...BOT_CATALOG];
  if (_category) list = list.filter(b => b.category === _category);
  if (_query)    list = list.filter(b =>
    b.name.toLowerCase().includes(_query.toLowerCase()) ||
    b.tagline.toLowerCase().includes(_query.toLowerCase()) ||
    b.tags.some(t => t.toLowerCase().includes(_query.toLowerCase()))
  );
  switch (_sortBy) {
    case 'popular': list.sort((a, b) => b.installs - a.installs); break;
    case 'rating':  list.sort((a, b) => b.rating   - a.rating);   break;
    case 'name':    list.sort((a, b) => a.name.localeCompare(b.name)); break;
  }
  return list;
}

function _renderCard(bot: BotListing): string {
  const installed  = _installedBotIds.has(bot.id);
  const stars      = '⭐'.repeat(Math.round(bot.rating));
  const instK      = bot.installs >= 1000 ? `${(bot.installs/1000).toFixed(0)}k` : String(bot.installs);
  const verBadge   = bot.verified ? `<span title="Doğrulanmış" style="font-size:11px;background:#2d9cdb;color:#fff;border-radius:4px;padding:1px 5px;">✓ Resmi</span>` : '';
  const featureBadge = bot.featured ? `<span style="font-size:10px;background:#f59e0b;color:#fff;border-radius:4px;padding:1px 5px;">⭐ Öne Çıkan</span>` : '';
  const priceBadge = !bot.freeToUse ? `<span style="font-size:10px;background:#6366f1;color:#fff;border-radius:4px;padding:1px 5px;">💎 Premium</span>` : '';

  return `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:12px;overflow:hidden;transition:transform .15s,box-shadow .15s;cursor:pointer;"
      onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 20px rgba(0,0,0,.2)'"
      onmouseleave="this.style.transform='';this.style.boxShadow=''"
      onclick="window._bmOpenDetail('${bot.id}')">

      <!-- Card header -->
      <div style="padding:16px 16px 12px;display:flex;align-items:flex-start;gap:12px;">
        <div style="width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,var(--accent),#1bc8a8);display:flex;align-items:center;justify-content:center;font-size:26px;flex-shrink:0;">${bot.avatar}</div>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
            <span style="font-weight:700;font-size:14px;">${escHtml(bot.name)}</span>
            ${verBadge}${featureBadge}${priceBadge}
          </div>
          <div style="font-size:12px;color:var(--text-3);margin-top:2px;">${escHtml(bot.tagline)}</div>
        </div>
      </div>

      <!-- Category + stats -->
      <div style="padding:0 16px 12px;display:flex;align-items:center;gap:8px;">
        <span style="font-size:11px;background:var(--bg-1);border-radius:20px;padding:2px 8px;color:var(--text-2);">
          ${BOT_CATEGORIES.find(c => c.id === bot.category)?.icon ?? '🔧'} ${BOT_CATEGORIES.find(c => c.id === bot.category)?.label ?? ''}
        </span>
        <span style="font-size:11px;color:var(--text-3);">${stars}</span>
        <span style="font-size:11px;color:var(--text-3);margin-left:auto;">👥 ${instK}</span>
      </div>

      <!-- Actions -->
      <div style="padding:0 12px 12px;display:flex;gap:8px;">
        ${installed
          ? `<button class="btn" style="flex:1;background:var(--bg-1);color:var(--text-3);font-size:12px;padding:6px;border-radius:6px;border:1px solid var(--border);cursor:default;">✅ Eklendi</button>`
          : `<button class="btn btn-primary" style="flex:1;font-size:12px;padding:6px;border-radius:6px;" onclick="event.stopPropagation();window._bmInstall('${bot.id}')">➕ Ekle</button>`}
        <button class="btn btn-secondary" style="font-size:12px;padding:6px 10px;border-radius:6px;" onclick="event.stopPropagation();window._bmOpenDetail('${bot.id}')">ℹ️</button>
      </div>
    </div>`;
}

// ── Detail modal ──────────────────────────────────────────────────────────────

function _bmOpenDetail(botId: string): void {
  const bot = BOT_CATALOG.find(b => b.id === botId);
  if (!bot) return;
  const installed = _installedBotIds.has(bot.id);

  document.getElementById('bm-detail-modal')?.remove();
  const modal = document.createElement('div');
  modal.id        = 'bm-detail-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'z-index:10001;';

  const cmds = bot.commands.map(c => `<code style="background:var(--bg-1);border-radius:4px;padding:2px 6px;font-size:12px;">${escHtml(c)}</code>`).join(' ');
  const tags  = bot.tags.map(t => `<span style="background:var(--bg-1);border-radius:20px;padding:2px 8px;font-size:11px;color:var(--text-2);">${escHtml(t)}</span>`).join('');

  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%;max-height:85vh;overflow-y:auto;">
      <div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;">
        <div style="width:72px;height:72px;border-radius:18px;background:linear-gradient(135deg,var(--accent),#1bc8a8);display:flex;align-items:center;justify-content:center;font-size:36px;flex-shrink:0;">${bot.avatar}</div>
        <div style="flex:1;">
          <div style="font-size:20px;font-weight:800;">${escHtml(bot.name)}</div>
          <div style="font-size:13px;color:var(--text-3);margin-top:3px;">${escHtml(bot.tagline)}</div>
          <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
            ${bot.verified ? `<span style="font-size:11px;background:#2d9cdb;color:#fff;border-radius:4px;padding:2px 6px;">✓ Doğrulanmış</span>` : ''}
            ${!bot.freeToUse ? `<span style="font-size:11px;background:#6366f1;color:#fff;border-radius:4px;padding:2px 6px;">💎 Premium</span>` : `<span style="font-size:11px;background:#22c55e;color:#fff;border-radius:4px;padding:2px 6px;">✅ Ücretsiz</span>`}
          </div>
        </div>
      </div>

      <div style="margin-bottom:16px;padding:14px;background:var(--bg-1);border-radius:8px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;text-align:center;">
        <div><div style="font-weight:700;font-size:16px;">${(bot.installs/1000).toFixed(0)}k</div><div style="font-size:11px;color:var(--text-3);">Kurulum</div></div>
        <div><div style="font-weight:700;font-size:16px;">${bot.rating}/5</div><div style="font-size:11px;color:var(--text-3);">Puan</div></div>
        <div><div style="font-weight:700;font-size:16px;">${bot.commands.length}</div><div style="font-size:11px;color:var(--text-3);">Komut</div></div>
      </div>

      <div style="margin-bottom:14px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;">📖 Açıklama</div>
        <div style="font-size:13px;color:var(--text-2);line-height:1.6;">${escHtml(bot.description)}</div>
      </div>

      <div style="margin-bottom:14px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;">⌨️ Komutlar</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${cmds}</div>
      </div>

      <div style="margin-bottom:20px;">
        <div style="font-weight:700;font-size:13px;margin-bottom:6px;">🏷️ Etiketler</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">${tags}</div>
      </div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-secondary" onclick="document.getElementById('bm-detail-modal').remove()">Kapat</button>
        ${installed
          ? `<button class="btn" style="flex:1;background:var(--bg-1);color:var(--text-3);border:1px solid var(--border);cursor:default;" disabled>✅ Sunucuda Mevcut</button>`
          : `<button class="btn btn-primary" style="flex:1;" onclick="window._bmInstall('${bot.id}');document.getElementById('bm-detail-modal').remove()">➕ Sunucuya Ekle</button>`}
        ${bot.docsUrl ? `<a class="btn btn-secondary" href="${escHtml(bot.docsUrl)}" target="_blank" rel="noopener">📚 Döküman</a>` : ''}
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}
(window as Window & { _bmOpenDetail?: (id: string) => void })._bmOpenDetail = _bmOpenDetail;

// ── Install bot ───────────────────────────────────────────────────────────────

async function _bmInstall(botId: string): Promise<void> {
  const bot    = BOT_CATALOG.find(b => b.id === botId);
  const server = getCurrentServer() as { _id?: string; name?: string } | null;
  if (!bot || !server?._id) return;

  if (bot.inviteUrl) {
    window.open(bot.inviteUrl, '_blank', 'noopener');
    return;
  }

  const API = getAPI();
  try {
    const r = await apiFetch(`${API}/api/servers/${server._id}/bots`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ botId, botName: bot.name }),
    });
    if (!r.ok) {
      const d = await r.json();
      toast(d.error ?? 'Bot eklenemedi', 'error');
      return;
    }
    _installedBotIds.add(botId);
    toast(`🤖 ${bot.name} sunucuya eklendi!`, 'success');
    // Re-render grid
    const grid = document.getElementById('bm-grid');
    if (grid) grid.innerHTML = _renderGrid();
  } catch {
    toast('Bağlantı hatası', 'error');
  }
}
(window as Window & { _bmInstall?: (id: string) => Promise<void> })._bmInstall = _bmInstall;

// ── Add custom bot ────────────────────────────────────────────────────────────

function _bmOpenAddCustom(): void {
  document.getElementById('bm-custom-modal')?.remove();
  const modal = document.createElement('div');
  modal.id        = 'bm-custom-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'z-index:10001;';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:440px;width:95%;">
      <h2 style="margin:0 0 8px;">🔗 Özel Bot Ekle</h2>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 20px;">Kendi geliştirdiğin veya üçüncü parti bir botu sunucuna ekle.</p>

      <div class="form-group" style="margin-bottom:14px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Bot Token</label>
        <input id="bm-custom-token" type="password" placeholder="Bot token (sunucu tarafında güvenli saklanır)"
          style="width:100%;margin-top:6px;padding:10px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;">
      </div>

      <div class="form-group" style="margin-bottom:14px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Bot Adı (Opsiyonel)</label>
        <input id="bm-custom-name" type="text" maxlength="32" placeholder="Botun görünen adı"
          style="width:100%;margin-top:6px;padding:10px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;">
      </div>

      <div class="form-group" style="margin-bottom:14px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Webhook URL (Opsiyonel)</label>
        <input id="bm-custom-webhook" type="url" placeholder="https://..."
          style="width:100%;margin-top:6px;padding:10px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;">
        <div style="font-size:11px;color:var(--text-3);margin-top:4px;">Botun olayları dinleyeceği webhook endpoint'i</div>
      </div>

      <div style="padding:10px;background:rgba(99,102,241,.1);border-radius:8px;font-size:12px;color:var(--text-2);margin-bottom:16px;">
        🔒 Bot token'ı şifreli olarak saklanır. Sunucu adminleri hariç kimse göremez.
      </div>

      <div class="modal-footer" style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="document.getElementById('bm-custom-modal').remove()">İptal</button>
        <button class="btn btn-primary" onclick="window._bmSaveCustomBot()">➕ Botu Ekle</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}
(window as Window & { _bmOpenAddCustom?: () => void })._bmOpenAddCustom = _bmOpenAddCustom;

async function _bmSaveCustomBot(): Promise<void> {
  const token   = (document.getElementById('bm-custom-token')   as HTMLInputElement)?.value?.trim();
  const name    = (document.getElementById('bm-custom-name')    as HTMLInputElement)?.value?.trim();
  const webhook = (document.getElementById('bm-custom-webhook') as HTMLInputElement)?.value?.trim();
  const server  = getCurrentServer() as { _id?: string } | null;

  if (!token) { toast('Bot token gerekli', 'error'); return; }
  if (!server?._id) { toast('Sunucu seçilmedi', 'error'); return; }

  const API = getAPI();
  const r = await apiFetch(`${API}/api/servers/${server._id}/bots`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ token, name, webhookUrl: webhook || undefined, custom: true }),
  });

  if (!r.ok) { const d = await r.json(); toast(d.error ?? 'Bot eklenemedi', 'error'); return; }
  toast('🤖 Bot başarıyla eklendi!', 'success');
  document.getElementById('bm-custom-modal')?.remove();
}
(window as Window & { _bmSaveCustomBot?: () => Promise<void> })._bmSaveCustomBot = _bmSaveCustomBot;

// ── Filter handlers ───────────────────────────────────────────────────────────

function _bmSearch(q: string): void {
  _query = q;
  const grid = document.getElementById('bm-grid');
  if (grid) grid.innerHTML = _renderGrid();
}
(window as Window & { _bmSearch?: (q: string) => void })._bmSearch = _bmSearch;

function _bmSetCat(cat: BotCategory | ''): void {
  _category = cat;
  document.querySelectorAll<HTMLElement>('.bm-cat-btn').forEach(b => {
    const active = (b.textContent?.includes(cat === '' ? 'Tümü' : BOT_CATEGORIES.find(c => c.id === cat)?.label ?? ''));
    b.style.cssText = _catBtnStyle(active);
  });
  const grid = document.getElementById('bm-grid');
  if (grid) grid.innerHTML = _renderGrid();
}
(window as Window & { _bmSetCat?: (c: BotCategory | '') => void })._bmSetCat = _bmSetCat;

function _bmSetSort(s: 'popular' | 'rating' | 'new' | 'name'): void {
  _sortBy = s;
  const grid = document.getElementById('bm-grid');
  if (grid) grid.innerHTML = _renderGrid();
}
(window as Window & { _bmSetSort?: (s: 'popular' | 'rating' | 'new' | 'name') => void })._bmSetSort = _bmSetSort;

function _catBtnStyle(active: boolean): string {
  return `padding:5px 12px;border-radius:20px;border:none;cursor:pointer;font-size:12px;white-space:nowrap;transition:background .1s;${active ? 'background:var(--accent);color:#fff;font-weight:700;' : 'background:var(--bg-1);color:var(--text-2);'}`;
}

// ── BridgeRegistry ────────────────────────────────────────────────────────────

BridgeRegistry.register('openBotMarketplace', openBotMarketplace);
