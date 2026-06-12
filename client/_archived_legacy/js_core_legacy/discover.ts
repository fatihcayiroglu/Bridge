// ⚠️  LEGACY — Sprint 114'te arşivlendi
// Bu dosya artık kullanılmıyor.
//
// Yerine geçen: client/js/core/DiscoverPanel.svelte
//              client/js/core/discover-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları discover-svelte.ts'te kopyalandı,
// geriye dönük uyumluluk korunuyor.
//
// Silinme planı: Sprint 116 (2 sprint stabilite sonrası)
// ADR: docs/ADR-0008-frontend-framework-strategy.md (Faz 2)
// ─────────────────────────────────────────────────────────────

// client/js/core/discover.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Keşif sayfası — öne çıkan sunucular, kategori filtresi, gerçek zamanlı üye sayısı

import { BridgeRegistry } from './bridge-registry.js';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare const API: string;
declare const socket: {
  emit(event: string, data?: unknown): void;
  on(event: string, cb: (data: Record<string, unknown>) => void): void;
  off(event: string): void;
} | null;

// ── Tip tanımları ─────────────────────────────────────────────

interface DiscoverServer {
  _id: string;
  name: string;
  description: string;
  iconUrl?: string;
  bannerUrl?: string;
  memberCount?: number;
  onlineCount?: number;
  createdAt?: number;
  tags?: string[];
  category?: string;
}

interface Category { id: string; label: string; }

type SortMode = 'members' | 'online' | 'newest' | 'name';

// ── Durum ─────────────────────────────────────────────────────

let _allServers:     DiscoverServer[] = [];
let _featuredList:   DiscoverServer[] = [];
let _categories:     Category[]       = [];
let _activeCategory  = '';
let _searchQuery     = '';
let _sortMode:       SortMode         = 'members';
let _subscribed      = false;

// ── Init ──────────────────────────────────────────────────────

export async function initDiscover(): Promise<void> {
  const container = document.getElementById('discover-root');
  if (!container) return;

  container.innerHTML = _renderSkeleton();

  const [serversRes, featuredRes, catsRes] = await Promise.all([
    apiFetch(`${API}/api/discover`),
    apiFetch(`${API}/api/discover/featured`),
    apiFetch(`${API}/api/discover/categories`),
  ]);

  _allServers   = serversRes.ok   ? await serversRes.json()   : [];
  _featuredList = featuredRes.ok  ? await featuredRes.json()  : [];
  _categories   = catsRes.ok      ? await catsRes.json()      : [];

  _renderDiscover(container);
  _subscribeRealtimeCounts();
}

// ── Socket: gerçek zamanlı üye sayısı ────────────────────────

function _subscribeRealtimeCounts(): void {
  if (!socket || _subscribed) return;
  _subscribed = true;
  socket.emit('discover:subscribe');
  socket.on('discover:memberCount', ({ serverId, memberCount, onlineCount }) => {
    const update = (list: DiscoverServer[]) => {
      const s = list.find(x => x._id === serverId);
      if (s) { s.memberCount = memberCount as number; s.onlineCount = onlineCount as number; }
    };
    update(_allServers); update(_featuredList);
    const card = document.querySelector<HTMLElement>(`[data-server-id="${serverId as string}"]`);
    if (card) {
      const mc = card.querySelector('.discover-member-count');
      const oc = card.querySelector('.discover-online-count');
      if (mc) mc.textContent = `${(memberCount as number).toLocaleString('tr')} üye`;
      if (oc) oc.textContent = `${onlineCount as number} çevrimiçi`;
    }
  });
}

function _unsubscribeRealtimeCounts(): void {
  if (!socket || !_subscribed) return;
  socket.emit('discover:unsubscribe');
  socket.off('discover:memberCount');
  _subscribed = false;
}

// ── Render ────────────────────────────────────────────────────

function _renderDiscover(container: HTMLElement): void {
  container.innerHTML = `
    ${_featuredList.length ? _renderFeaturedSection() : ''}
    <div class="discover-controls">
      ${_renderCategoryBar()}
      ${_renderSearchBar()}
    </div>
    <div id="discover-server-grid" class="discover-grid">
      ${_renderServerGrid()}
    </div>`;
  _bindControls(container);
}

function _renderFeaturedSection(): string {
  return `
    <section class="discover-featured">
      <h2 class="discover-section-title">⭐ Öne Çıkan Sunucular</h2>
      <div class="discover-featured-list">
        ${_featuredList.map(_renderFeaturedCard).join('')}
      </div>
    </section>`;
}

function _renderFeaturedCard(s: DiscoverServer): string {
  const banner = s.bannerUrl
    ? `<div class="featured-banner" style="background-image:url('${escHtml(s.bannerUrl)}')"></div>`
    : `<div class="featured-banner featured-banner--placeholder"></div>`;
  const icon = s.iconUrl
    ? `<img src="${escHtml(s.iconUrl)}" class="featured-icon" alt="">`
    : `<div class="featured-icon featured-icon--letter">${escHtml(s.name[0])}</div>`;
  return `
    <div class="featured-card" data-server-id="${s._id}">
      ${banner}
      <div class="featured-card-body">
        ${icon}
        <div class="featured-card-info">
          <div class="featured-card-name">${escHtml(s.name)}</div>
          <div class="featured-card-desc">${escHtml(s.description.slice(0, 80))}</div>
          <div class="featured-card-meta">
            <span class="discover-member-count">${(s.memberCount ?? 0).toLocaleString('tr')} üye</span>
            <span class="discover-online-count" style="color:var(--green)">● ${s.onlineCount ?? 0} çevrimiçi</span>
          </div>
        </div>
        <button class="btn btn-primary btn-sm featured-join-btn" onclick="joinServerFromDiscover('${s._id}')">Katıl</button>
      </div>
    </div>`;
}

function _renderCategoryBar(): string {
  const all: Category[] = [{ id: '', label: '🌐 Tümü' }, ..._categories];
  return `
    <div class="discover-categories" id="discover-cats">
      ${all.map(c => `<button class="cat-btn ${_activeCategory === c.id ? 'cat-btn--active' : ''}" data-cat="${escHtml(c.id)}">${escHtml(c.label)}</button>`).join('')}
    </div>`;
}

function _renderSearchBar(): string {
  return `
    <div class="discover-searchbar">
      <input id="discover-search" type="text" class="input-field"
        placeholder="Sunucu ara..." value="${escHtml(_searchQuery)}" style="flex:1">
      <select id="discover-sort" class="input-field" style="width:140px">
        <option value="members" ${_sortMode === 'members' ? 'selected' : ''}>Üye sayısı</option>
        <option value="online"  ${_sortMode === 'online'  ? 'selected' : ''}>Çevrimiçi</option>
        <option value="newest"  ${_sortMode === 'newest'  ? 'selected' : ''}>En yeni</option>
        <option value="name"    ${_sortMode === 'name'    ? 'selected' : ''}>İsim</option>
      </select>
    </div>`;
}

function _getFilteredServers(): DiscoverServer[] {
  let list = _allServers;
  if (_activeCategory) list = list.filter(s => (s.category ?? 'other') === _activeCategory);
  if (_searchQuery) {
    const lq = _searchQuery.toLowerCase();
    list = list.filter(s =>
      s.name.toLowerCase().includes(lq) ||
      s.description.toLowerCase().includes(lq) ||
      (s.tags ?? []).some(t => t.toLowerCase().includes(lq)),
    );
  }
  if      (_sortMode === 'members') list = [...list].sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
  else if (_sortMode === 'online')  list = [...list].sort((a, b) => (b.onlineCount  ?? 0) - (a.onlineCount  ?? 0));
  else if (_sortMode === 'newest')  list = [...list].sort((a, b) => (b.createdAt    ?? 0) - (a.createdAt    ?? 0));
  else if (_sortMode === 'name')    list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  return list;
}

function _renderServerGrid(): string {
  const list = _getFilteredServers();
  if (!list.length) return '<div class="discover-empty">Sonuç bulunamadı.</div>';
  return list.map(_renderServerCard).join('');
}

function _renderServerCard(s: DiscoverServer): string {
  const icon = s.iconUrl
    ? `<img src="${escHtml(s.iconUrl)}" class="discover-card-icon" alt="">`
    : `<div class="discover-card-icon discover-card-icon--letter">${escHtml(s.name[0])}</div>`;
  const tags = (s.tags ?? []).slice(0, 3).map(t => `<span class="discover-tag">${escHtml(t)}</span>`).join('');
  return `
    <div class="discover-card" data-server-id="${s._id}">
      ${icon}
      <div class="discover-card-body">
        <div class="discover-card-name">${escHtml(s.name)}</div>
        <div class="discover-card-desc">${escHtml((s.description ?? '').slice(0, 120))}</div>
        <div class="discover-card-tags">${tags}</div>
        <div class="discover-card-meta">
          <span class="discover-member-count">👥 <strong>${(s.memberCount ?? 0).toLocaleString('tr')}</strong> üye</span>
          <span class="discover-online-count">● <span style="color:var(--green)">${s.onlineCount ?? 0}</span> çevrimiçi</span>
        </div>
      </div>
      <button class="btn btn-primary btn-sm discover-join-btn" onclick="joinServerFromDiscover('${s._id}')">Katıl</button>
    </div>`;
}

function _bindControls(container: HTMLElement): void {
  const catBar = container.querySelector<HTMLElement>('#discover-cats');
  if (catBar) {
    catBar.addEventListener('click', e => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.cat-btn');
      if (!btn) return;
      _activeCategory = btn.dataset.cat ?? '';
      catBar.querySelectorAll('.cat-btn').forEach(b => b.classList.toggle('cat-btn--active', b === btn));
      const grid = document.getElementById('discover-server-grid');
      if (grid) grid.innerHTML = _renderServerGrid();
    });
  }

  const searchInput = container.querySelector<HTMLInputElement>('#discover-search');
  if (searchInput) {
    let debounceT: ReturnType<typeof setTimeout>;
    searchInput.addEventListener('input', e => {
      clearTimeout(debounceT);
      debounceT = setTimeout(() => {
        _searchQuery = (e.target as HTMLInputElement).value;
        const grid = document.getElementById('discover-server-grid');
        if (grid) grid.innerHTML = _renderServerGrid();
      }, 200);
    });
  }

  const sortSelect = container.querySelector<HTMLSelectElement>('#discover-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', e => {
      _sortMode = (e.target as HTMLSelectElement).value as SortMode;
      const grid = document.getElementById('discover-server-grid');
      if (grid) grid.innerHTML = _renderServerGrid();
    });
  }
}

function _renderSkeleton(): string {
  return `<div class="discover-skeleton">${Array(6).fill('<div class="skeleton-card"></div>').join('')}</div>`;
}

// ── Katıl ────────────────────────────────────────────────────

export async function joinServerFromDiscover(serverId: string): Promise<void> {
  const r = await apiFetch(`${API}/api/servers/${serverId}/join`, { method: 'POST' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string };
    BridgeRegistry.call('toast', d.error ?? 'Katılım başarısız', 'error');
    return;
  }
  BridgeRegistry.call('toast', 'Sunucuya katıldın!', 'success');
  BridgeRegistry.call('reloadServerList');
}

// ── Yaşam döngüsü ─────────────────────────────────────────────

export function onDiscoverMount(): void {
  _allServers = []; _featuredList = []; _activeCategory = ''; _searchQuery = ''; _subscribed = false;
  void initDiscover();
}

export function onDiscoverUnmount(): void {
  _unsubscribeRealtimeCounts();
}

// ── BridgeRegistry ────────────────────────────────────────────

BridgeRegistry.register('initDiscover',            initDiscover);
BridgeRegistry.register('onDiscoverMount',         onDiscoverMount);
BridgeRegistry.register('onDiscoverUnmount',       onDiscoverUnmount);
BridgeRegistry.register('joinServerFromDiscover',  joinServerFromDiscover);
