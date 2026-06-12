// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/IndexPanel.svelte
//              client/js/core/index-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/stickers/index.ts
// Sprint 82: Sticker sistemi — sunucu bazlı ve global sticker paketleri
// Emoji picker'a entegre, mesaj kutusundan sticker gönderilebilir.

import { getSocket } from '../globals.js';
import { BridgeRegistry } from '../bridge-registry.js';
import { escHtml } from '../utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StickerPack {
  id:          string;
  name:        string;
  description: string;
  authorName:  string;
  coverUrl:    string;
  stickers:    Sticker[];
  isGlobal:    boolean;   // true = tüm kullanıcılara açık
  serverId?:   string;    // sunucu özel paketi
}

export interface Sticker {
  id:      string;
  packId:  string;
  name:    string;
  url:     string;        // PNG/WebP/GIF
  tags:    string[];
  width:   number;
  height:  number;
}

// ── Built-in Global Sticker Packs ─────────────────────────────────────────────

export const GLOBAL_STICKER_PACKS: StickerPack[] = [
  {
    id:          'bridge-classic',
    name:        'Bridge Klasik',
    description: 'Bridge maskotu ve klasik ifadeler',
    authorName:  'Bridge Team',
    coverUrl:    '/assets/stickers/bridge-classic/cover.webp',
    isGlobal:    true,
    stickers: [
      { id: 'bc-wave',   packId: 'bridge-classic', name: 'El Sallama',   url: '/assets/stickers/bridge-classic/wave.webp',   tags: ['selam', 'merhaba'], width: 160, height: 160 },
      { id: 'bc-think',  packId: 'bridge-classic', name: 'Düşünüyor',    url: '/assets/stickers/bridge-classic/think.webp',  tags: ['düşünce', 'hmm'],  width: 160, height: 160 },
      { id: 'bc-gg',     packId: 'bridge-classic', name: 'GG',           url: '/assets/stickers/bridge-classic/gg.webp',     tags: ['oyun', 'gg'],      width: 160, height: 160 },
      { id: 'bc-sleepy', packId: 'bridge-classic', name: 'Uyku',         url: '/assets/stickers/bridge-classic/sleepy.webp', tags: ['uyku', 'gece'],    width: 160, height: 160 },
      { id: 'bc-heart',  packId: 'bridge-classic', name: 'Kalp',         url: '/assets/stickers/bridge-classic/heart.webp',  tags: ['sevgi', 'kalp'],   width: 160, height: 160 },
      { id: 'bc-fire',   packId: 'bridge-classic', name: 'Ateş',         url: '/assets/stickers/bridge-classic/fire.webp',   tags: ['ateş', 'harika'],  width: 160, height: 160 },
      { id: 'bc-cry',    packId: 'bridge-classic', name: 'Ağlıyor',      url: '/assets/stickers/bridge-classic/cry.webp',    tags: ['ağlama', 'üzgün'], width: 160, height: 160 },
      { id: 'bc-party',  packId: 'bridge-classic', name: 'Parti',        url: '/assets/stickers/bridge-classic/party.webp',  tags: ['parti', 'eğlence'],width: 160, height: 160 },
    ],
  },
  {
    id:          'bridge-meme',
    name:        'Meme Koleksiyonu',
    description: 'Popüler internet memleri',
    authorName:  'Bridge Community',
    coverUrl:    '/assets/stickers/bridge-meme/cover.webp',
    isGlobal:    true,
    stickers: [
      { id: 'bm-deal',   packId: 'bridge-meme', name: 'Deal With It', url: '/assets/stickers/bridge-meme/deal.webp',   tags: ['deal', 'güneş gözlüğü'], width: 200, height: 120 },
      { id: 'bm-fine',   packId: 'bridge-meme', name: 'This is Fine', url: '/assets/stickers/bridge-meme/fine.webp',   tags: ['fine', 'yangın'],         width: 200, height: 150 },
      { id: 'bm-nope',   packId: 'bridge-meme', name: 'Nope',         url: '/assets/stickers/bridge-meme/nope.webp',   tags: ['hayır', 'nope'],          width: 160, height: 160 },
      { id: 'bm-poggers',packId: 'bridge-meme', name: 'Poggers',      url: '/assets/stickers/bridge-meme/poggers.webp',tags: ['heyecan', 'poggers'],     width: 160, height: 160 },
    ],
  },
];

// ── State ─────────────────────────────────────────────────────────────────────

let _serverPacks:  StickerPack[] = [];
let _recentStickers: string[] = [];   // sticker id listesi

function _loadRecents(): void {
  try {
    const raw = sessionStorage.getItem('bridge_recent_stickers');
    _recentStickers = raw ? JSON.parse(raw) : [];
  } catch { _recentStickers = []; }
}

function _saveRecents(): void {
  try {
    sessionStorage.setItem('bridge_recent_stickers', JSON.stringify(_recentStickers.slice(0, 20)));
  } catch {}
}

function _addRecent(stickerId: string): void {
  _recentStickers = [stickerId, ..._recentStickers.filter(id => id !== stickerId)].slice(0, 20);
  _saveRecents();
}

// ── Pack Yükleme ──────────────────────────────────────────────────────────────

export async function loadServerStickerPacks(serverId: string): Promise<void> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/sticker-packs`, {
      headers: { 'Authorization': `Bearer ${_getToken()}` },
    });
    if (!res.ok) return;
    const data: StickerPack[] = await res.json();
    _serverPacks = data;
  } catch (err) {
    console.warn('[Stickers] Sunucu paketleri yüklenemedi:', err);
  }
}

export function getAllPacks(serverId?: string): StickerPack[] {
  const all = [...GLOBAL_STICKER_PACKS];
  if (serverId) {
    all.push(..._serverPacks.filter(p => p.serverId === serverId));
  }
  return all;
}

export function findSticker(stickerId: string): Sticker | undefined {
  for (const pack of [...GLOBAL_STICKER_PACKS, ..._serverPacks]) {
    const found = pack.stickers.find(s => s.id === stickerId);
    if (found) return found;
  }
  return undefined;
}

// ── Sticker Gönderme ──────────────────────────────────────────────────────────

export async function sendSticker(
  stickerId: string,
  channelId: string,
  serverId?:  string,
): Promise<void> {
  const sticker = findSticker(stickerId);
  if (!sticker) throw new Error(`Sticker bulunamadı: ${stickerId}`);

  const socket = getSocket();
  if (!socket) throw new Error('Socket bağlı değil');

  socket.emit('message:send', {
    channelId,
    serverId,
    type:      'sticker',
    stickerId,
    stickerUrl: sticker.url,
    stickerName: sticker.name,
    content:   '',
  });

  _addRecent(stickerId);
}

// ── Picker UI ─────────────────────────────────────────────────────────────────

export function openStickerPicker(
  channelId: string,
  serverId:  string | undefined,
  anchorEl:  Element,
): void {
  const existingPicker = document.getElementById('sticker-picker-modal');
  if (existingPicker) { existingPicker.remove(); return; }

  _loadRecents();

  const packs  = getAllPacks(serverId);
  const modal  = document.createElement('div');
  modal.id     = 'sticker-picker-modal';
  modal.className = 'sticker-picker-modal';

  const anchorRect = anchorEl.getBoundingClientRect();
  modal.style.cssText = `
    position: fixed;
    bottom: ${window.innerHeight - anchorRect.top + 8}px;
    left: ${Math.max(8, anchorRect.left - 200)}px;
    width: 360px;
    max-height: 460px;
    background: var(--bg-secondary, #2f3136);
    border: 1px solid var(--border, #202225);
    border-radius: 12px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    z-index: 9000;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  `;

  // Tabs (paket isimleri)
  const tabsHtml = packs.map((p, i) => `
    <button class="sticker-pack-tab ${i === 0 ? 'active' : ''}" data-pack-idx="${i}" title="${escHtml(p.name)}">
      <img src="${escHtml(p.coverUrl)}" width="24" height="24" alt="${escHtml(p.name)}" onerror="this.style.display='none'">
    </button>
  `).join('');

  // Recent tab
  const recentHtml = _recentStickers.length > 0 ? `
    <button class="sticker-pack-tab" data-pack-idx="recent" title="Son Kullanılanlar">🕐</button>
  ` : '';

  modal.innerHTML = `
    <div class="sticker-picker-header">
      <input class="sticker-search-input" type="text" placeholder="Sticker ara…" id="sticker-search-input">
    </div>
    <div class="sticker-pack-tabs">
      ${recentHtml}${tabsHtml}
    </div>
    <div class="sticker-grid-container" id="sticker-grid-container">
      ${_renderStickerGrid(packs[0]?.stickers ?? [], channelId, serverId)}
    </div>
    <style>
      .sticker-picker-modal { font-family: var(--font, sans-serif); }
      .sticker-picker-header { padding: 8px; border-bottom: 1px solid var(--border, #202225); }
      .sticker-search-input {
        width: 100%; box-sizing: border-box; padding: 6px 10px;
        background: var(--bg-tertiary, #40444b); border: none; border-radius: 6px;
        color: var(--text, #dcddde); font-size: 13px; outline: none;
      }
      .sticker-pack-tabs {
        display: flex; gap: 4px; padding: 6px 8px;
        overflow-x: auto; border-bottom: 1px solid var(--border, #202225);
      }
      .sticker-pack-tab {
        background: none; border: none; cursor: pointer; padding: 4px; border-radius: 6px;
        font-size: 18px; opacity: 0.6; transition: opacity 0.15s, background 0.15s;
      }
      .sticker-pack-tab.active, .sticker-pack-tab:hover { opacity: 1; background: var(--bg-tertiary, #40444b); }
      .sticker-grid-container { overflow-y: auto; flex: 1; padding: 8px; }
      .sticker-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
      .sticker-item {
        aspect-ratio: 1; border-radius: 8px; cursor: pointer; overflow: hidden;
        background: var(--bg-tertiary, #40444b); display: flex; align-items: center;
        justify-content: center; transition: transform 0.1s;
      }
      .sticker-item:hover { transform: scale(1.08); }
      .sticker-item img { width: 100%; height: 100%; object-fit: contain; }
      .sticker-section-title {
        font-size: 11px; font-weight: 600; color: var(--text-muted, #72767d);
        text-transform: uppercase; letter-spacing: 0.05em; padding: 4px 0 6px;
      }
    </style>
  `;

  // Search handler
  const searchInput = modal.querySelector<HTMLInputElement>('#sticker-search-input');
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const container = modal.querySelector<HTMLElement>('#sticker-grid-container');
    if (!container) return;
    if (!q) {
      container.innerHTML = _renderStickerGrid(packs[0]?.stickers ?? [], channelId, serverId);
    } else {
      const allStickers = packs.flatMap(p => p.stickers);
      const matched = allStickers.filter(s =>
        s.name.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q))
      );
      container.innerHTML = _renderStickerGrid(matched, channelId, serverId);
    }
    _bindStickerClicks(container, channelId, serverId, modal);
  });

  // Tab handler
  modal.querySelectorAll<HTMLButtonElement>('.sticker-pack-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      modal.querySelectorAll('.sticker-pack-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const idx = tab.dataset['packIdx'];
      const container = modal.querySelector<HTMLElement>('#sticker-grid-container');
      if (!container) return;

      if (idx === 'recent') {
        const recents = _recentStickers.map(id => findSticker(id)).filter(Boolean) as Sticker[];
        container.innerHTML = _renderStickerGrid(recents, channelId, serverId);
      } else {
        const pack = packs[parseInt(idx ?? '0')];
        container.innerHTML = _renderStickerGrid(pack?.stickers ?? [], channelId, serverId);
      }
      _bindStickerClicks(container, channelId, serverId, modal);
    });
  });

  const gridContainer = modal.querySelector<HTMLElement>('#sticker-grid-container');
  if (gridContainer) _bindStickerClicks(gridContainer, channelId, serverId, modal);

  document.body.appendChild(modal);

  // Dışarı tıklayınca kapat
  const closeOnOutside = (e: MouseEvent) => {
    if (!modal.contains(e.target as Node) && e.target !== anchorEl) {
      modal.remove();
      document.removeEventListener('mousedown', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 50);
}

function _renderStickerGrid(stickers: Sticker[], channelId: string, serverId?: string): string {
  if (stickers.length === 0) {
    return '<p style="text-align:center;color:var(--text-muted,#72767d);font-size:13px;padding:16px">Sticker bulunamadı</p>';
  }
  return `
    <div class="sticker-grid">
      ${stickers.map(s => `
        <button class="sticker-item" data-sticker-id="${escHtml(s.id)}" title="${escHtml(s.name)}">
          <img src="${escHtml(s.url)}" alt="${escHtml(s.name)}" loading="lazy"
               onerror="this.src='/assets/stickers/placeholder.svg'">
        </button>
      `).join('')}
    </div>
  `;
}

function _bindStickerClicks(
  container: HTMLElement,
  channelId: string,
  serverId: string | undefined,
  modal: HTMLElement,
): void {
  container.querySelectorAll<HTMLButtonElement>('.sticker-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset['stickerId'];
      if (!id) return;
      modal.remove();
      await sendSticker(id, channelId, serverId);
    });
  });
}

// ── Sticker Mesaj Renderer ────────────────────────────────────────────────────

export function renderStickerMessage(stickerId: string, stickerUrl: string, stickerName: string): string {
  return `
    <div class="sticker-message" data-sticker-id="${escHtml(stickerId)}">
      <img
        class="sticker-message-img"
        src="${escHtml(stickerUrl)}"
        alt="${escHtml(stickerName)}"
        title="${escHtml(stickerName)}"
        style="width:160px;height:160px;object-fit:contain;border-radius:8px;cursor:pointer"
        onerror="this.src='/assets/stickers/placeholder.svg'"
      >
    </div>
  `;
}

// ── Server Admin: Pack Yönetimi ───────────────────────────────────────────────

export async function uploadServerStickerPack(
  serverId: string,
  packData: { name: string; description: string; stickers: File[] },
): Promise<StickerPack | null> {
  const formData = new FormData();
  formData.append('name', packData.name);
  formData.append('description', packData.description);
  packData.stickers.forEach((file, i) => formData.append(`sticker_${i}`, file));

  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/sticker-packs`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${_getToken()}` },
      body:    formData,
    });
    if (!res.ok) return null;
    const pack: StickerPack = await res.json();
    _serverPacks.push(pack);
    return pack;
  } catch (err) {
    console.error('[Stickers] Pack yükleme hatası:', err);
    return null;
  }
}

export async function deleteServerStickerPack(serverId: string, packId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/servers/${encodeURIComponent(serverId)}/sticker-packs/${encodeURIComponent(packId)}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${_getToken()}` },
    });
    if (res.ok) {
      _serverPacks = _serverPacks.filter(p => p.id !== packId);
    }
    return res.ok;
  } catch {
    return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _getToken(): string {
  return (window as Record<string, unknown>)['__bridge_token'] as string ?? '';
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initStickers(): void {
  _loadRecents();

  BridgeRegistry.register('openStickerPicker',         openStickerPicker);
  BridgeRegistry.register('sendSticker',               sendSticker);
  BridgeRegistry.register('loadServerStickerPacks',    loadServerStickerPacks);
  BridgeRegistry.register('getAllStickerPacks',        getAllPacks);
  BridgeRegistry.register('renderStickerMessage',      renderStickerMessage);
  BridgeRegistry.register('uploadServerStickerPack',   uploadServerStickerPack);
  BridgeRegistry.register('deleteServerStickerPack',   deleteServerStickerPack);
}
