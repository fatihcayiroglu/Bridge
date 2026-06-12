// client/js/admin/marketplace.ts
// Admin paneli — Bot Marketplace sekmesi (🛒) — Sprint 83

import { _statCard } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type: string): void;
declare const API: string;

interface BotEntry {
  id: string;
  name: string;
  author: string;
  category: string;
  installs: number;
  rating: number;
  featured: boolean;
  approved?: boolean;
}

export async function loadAdminMarketplace(el: HTMLElement): Promise<void> {
  try {
    const [approvedRes] = await Promise.all([
      apiFetch(`${API}/api/bots/marketplace?limit=100`),
    ]);
    const approvedData = approvedRes.ok ? await approvedRes.json() : { bots: [] };
    const bots: BotEntry[] = approvedData.bots ?? [];
    const total: number    = approvedData.total ?? bots.length;

    el.innerHTML = `
      <div style="padding:24px;max-width:960px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;">
          <span style="font-size:24px;">🛒</span>
          <div>
            <div style="font-size:18px;font-weight:700;color:#e0e0f0;">Bot Marketplace</div>
            <div style="font-size:12px;color:#555;">Katalog yönetimi · ${total} onaylı bot</div>
          </div>
          <button onclick="adminMarketplaceRefresh()"
            style="margin-left:auto;padding:8px 16px;background:#1e1e38;color:#8892f8;
                   border:1px solid #2a2a50;border-radius:8px;cursor:pointer;font-size:13px;">
            🔄 Yenile
          </button>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">
          ${_statCard('🤖', 'Toplam Bot',  total)}
          ${_statCard('⭐', 'Featured',    bots.filter(b => b.featured).length, '#f0a500')}
          ${_statCard('🎵', 'Müzik',       bots.filter(b => b.category === 'music').length, '#1db954')}
          ${_statCard('🛡️', 'Moderasyon',  bots.filter(b => b.category === 'moderation').length, '#e55')}
        </div>

        <div style="background:#161627;border-radius:12px;border:1px solid #1e1e38;overflow:hidden;">
          <div style="padding:14px 20px;border-bottom:1px solid #1e1e38;display:flex;align-items:center;gap:12px;">
            <span style="font-size:13px;font-weight:600;color:#8892f8;">Onaylı Botlar</span>
            <input id="mp-search" placeholder="Bot ara…" oninput="adminMarketplaceSearch(this.value)"
              style="margin-left:auto;padding:6px 12px;background:#0d0d1a;border:1px solid #1e1e38;
                     border-radius:6px;color:#ccc;font-size:12px;width:180px;outline:none;" />
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#0d0d1a;">
                <th style="padding:10px 16px;text-align:left;color:#555;font-weight:500;">Bot</th>
                <th style="padding:10px 16px;text-align:left;color:#555;font-weight:500;">Kategori</th>
                <th style="padding:10px 16px;text-align:right;color:#555;font-weight:500;">Kurulum</th>
                <th style="padding:10px 16px;text-align:right;color:#555;font-weight:500;">Puan</th>
                <th style="padding:10px 16px;text-align:center;color:#555;font-weight:500;">Featured</th>
                <th style="padding:10px 16px;text-align:center;color:#555;font-weight:500;">İşlem</th>
              </tr>
            </thead>
            <tbody id="mp-tbody">
              ${bots.map(b => _mpRow(b)).join('')}
            </tbody>
          </table>
          ${bots.length === 0 ? '<div style="padding:32px;text-align:center;color:#444;">Bot bulunamadı</div>' : ''}
        </div>

        <div style="margin-top:20px;background:#161627;border-radius:12px;border:1px solid #1e1e38;padding:20px;">
          <div style="font-size:14px;font-weight:600;color:#8892f8;margin-bottom:14px;">➕ Yeni Bot Ekle (Admin)</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
            <input id="mp-id"     placeholder="bot-id (küçük harf, tire)"  style="${_mpInput()}">
            <input id="mp-name"   placeholder="Bot Adı"                    style="${_mpInput()}">
            <input id="mp-author" placeholder="Yazar"                      style="${_mpInput()}">
            <select id="mp-cat" style="${_mpInput()}">
              <option value="">Kategori seç…</option>
              ${['music','moderation','ai','management','fun','utility','social'].map(c =>
                `<option value="${c}">${c}</option>`).join('')}
            </select>
            <input id="mp-avatar" placeholder="Avatar (emoji)"             style="${_mpInput()}">
            <input id="mp-tags"   placeholder="Etiketler (virgülle)"       style="${_mpInput()}">
          </div>
          <textarea id="mp-desc" placeholder="Kısa açıklama…"
            style="${_mpInput()}width:100%;margin-top:10px;resize:vertical;min-height:70px;"></textarea>
          <div style="display:flex;gap:8px;margin-top:12px;">
            <button onclick="adminMarketplaceAdd()"
              style="padding:9px 20px;background:#2d9cdb;color:#fff;border:none;border-radius:8px;
                     cursor:pointer;font-size:13px;font-weight:600;">
              ✅ Ekle & Onayla
            </button>
          </div>
        </div>
      </div>
    `;

    (window as Record<string, unknown>)._mpBots = bots;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml((e as Error).message)}</div>`;
  }
}

function _mpInput(): string {
  return 'padding:8px 12px;background:#0d0d1a;border:1px solid #1e1e38;border-radius:6px;' +
         'color:#ccc;font-size:12px;outline:none;width:100%;';
}

function _mpRow(b: BotEntry): string {
  const catColors: Record<string, string> = {
    music: '#1db954', moderation: '#e55', ai: '#8892f8',
    management: '#f0a500', fun: '#ff7b54', utility: '#aaa',
  };
  const color = catColors[b.category] || '#aaa';
  return `
    <tr id="mp-row-${escHtml(b.id)}" style="border-top:1px solid #1e1e38;">
      <td style="padding:12px 16px;">
        <div style="font-weight:600;color:#d0d0f0;">${escHtml(b.name)}</div>
        <div style="font-size:11px;color:#555;">@${escHtml(b.author)} · ${escHtml(b.id)}</div>
      </td>
      <td style="padding:12px 16px;">
        <span style="background:${color}22;color:${color};padding:3px 10px;
                     border-radius:99px;font-size:11px;font-weight:600;">${escHtml(b.category)}</span>
      </td>
      <td style="padding:12px 16px;text-align:right;color:#aaa;">${b.installs.toLocaleString()}</td>
      <td style="padding:12px 16px;text-align:right;color:#f0a500;">${b.rating.toFixed(1)} ⭐</td>
      <td style="padding:12px 16px;text-align:center;">
        <button onclick="adminMarketplaceToggleFeatured('${escHtml(b.id)}',${!b.featured})"
          style="background:${b.featured ? '#f0a50022' : '#1e1e38'};color:${b.featured ? '#f0a500' : '#555'};
                 border:1px solid ${b.featured ? '#f0a500' : '#2a2a50'};border-radius:6px;
                 padding:4px 12px;cursor:pointer;font-size:12px;">
          ${b.featured ? '★ Featured' : '☆ Ekle'}
        </button>
      </td>
      <td style="padding:12px 16px;text-align:center;">
        <button onclick="adminMarketplaceDelete('${escHtml(b.id)}')"
          style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                 border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;">
          🗑️
        </button>
      </td>
    </tr>`;
}

export function adminMarketplaceSearch(q: string): void {
  const bots = ((window as Record<string, unknown>)._mpBots ?? []) as BotEntry[];
  const tbody = document.getElementById('mp-tbody');
  if (!tbody) return;
  const filtered = q ? bots.filter(b =>
    b.name.toLowerCase().includes(q.toLowerCase()) ||
    b.author.toLowerCase().includes(q.toLowerCase()) ||
    b.id.toLowerCase().includes(q.toLowerCase())
  ) : bots;
  tbody.innerHTML = filtered.map(b => _mpRow(b)).join('');
}

export async function adminMarketplaceToggleFeatured(botId: string, featured: boolean): Promise<void> {
  const r = await apiFetch(`${API}/api/bots/marketplace/${encodeURIComponent(botId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ featured }),
  });
  if (!r.ok) { toast('Güncellenemedi', 'error'); return; }
  toast(featured ? '⭐ Featured yapıldı' : 'Featured kaldırıldı', 'success');
  await loadAdminMarketplace(document.getElementById('admin-content') as HTMLElement);
}

export async function adminMarketplaceDelete(botId: string): Promise<void> {
  if (!confirm(`"${botId}" silinsin mi?`)) return;
  const r = await apiFetch(`${API}/api/bots/marketplace/${encodeURIComponent(botId)}`, { method: 'DELETE' });
  if (!r.ok) { toast('Silinemedi', 'error'); return; }
  toast('Bot silindi', 'info');
  document.getElementById(`mp-row-${botId}`)?.remove();
}

export async function adminMarketplaceAdd(): Promise<void> {
  const id     = (document.getElementById('mp-id')     as HTMLInputElement)?.value.trim();
  const name   = (document.getElementById('mp-name')   as HTMLInputElement)?.value.trim();
  const author = (document.getElementById('mp-author') as HTMLInputElement)?.value.trim();
  const cat    = (document.getElementById('mp-cat')    as HTMLSelectElement)?.value;
  const avatar = (document.getElementById('mp-avatar') as HTMLInputElement)?.value.trim() || '🤖';
  const tags   = (document.getElementById('mp-tags')   as HTMLInputElement)?.value
    .split(',').map(t => t.trim()).filter(Boolean);
  const desc   = (document.getElementById('mp-desc')   as HTMLTextAreaElement)?.value.trim();

  if (!id || !name || !cat || !desc) { toast('id, name, kategori ve açıklama zorunlu', 'error'); return; }

  const r = await apiFetch(`${API}/api/bots/marketplace`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, author: author || 'Admin', category: cat, avatar, tags, description: desc }),
  });
  const data = await r.json();
  if (!r.ok) { toast(data.error || 'Eklenemedi', 'error'); return; }

  await apiFetch(`${API}/api/bots/marketplace/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved: true }),
  });

  toast(`✅ "${name}" eklendi ve onaylandı`, 'success');
  await loadAdminMarketplace(document.getElementById('admin-content') as HTMLElement);
}

export async function adminMarketplaceRefresh(): Promise<void> {
  await loadAdminMarketplace(document.getElementById('admin-content') as HTMLElement);
}
