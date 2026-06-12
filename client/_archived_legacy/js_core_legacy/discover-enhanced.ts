// ⚠️  LEGACY — Sprint 114'te arşivlendi
// Bu dosya artık kullanılmıyor.
//
// Yerine geçen: client/js/core/DiscoverPanel.svelte
//              client/js/core/discover-svelte.ts (mount shim)
//
// initDiscoverEnhanced → BridgeRegistry'de boş stub'a döndü (discover-svelte.ts).
// Trending algoritması, "Sizin İçin" önerileri → DiscoverPanel.svelte $derived
//
// Silinme planı: Sprint 116
// ADR: docs/ADR-0008-frontend-framework-strategy.md (Faz 2)
// ─────────────────────────────────────────────────────────────

// client/js/core/discover-enhanced.ts  (Sprint 91)
// Gelişmiş Sunucu Keşfi — Trending algoritması, öne çıkan kategoriler,
// "Sizin İçin" önerileri, canlı üye sayacı, sunucu etiket sistemi
//
// Mevcut discover.ts'i genişletir — BridgeRegistry override ile

import { BridgeRegistry }                       from './bridge-registry.js';
import { apiFetch }                              from './api-fetch.js';
import { getAPI }                                from './globals.js';
import { escHtml, toast }                        from './utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface DiscoverServer {
  _id:          string;
  name:         string;
  description?: string;
  iconUrl?:     string;
  bannerUrl?:   string;
  memberCount?: number;
  onlineCount?: number;
  tags?:        string[];
  category?:    string;
  boostLevel?:  number;
  verified?:    boolean;
  featured?:    boolean;
  createdAt?:   number;
  // computed by trending algorithm
  _trendScore?: number;
}

type DiscoverTab = 'featured' | 'trending' | 'new' | 'foryou';
type DiscoverCategory =
  | '' | 'gaming' | 'education' | 'tech' | 'art'
  | 'music' | 'community' | 'anime' | 'science' | 'social';

// ── Discover categories ───────────────────────────────────────────────────────

const DISCOVER_CATEGORIES: { id: DiscoverCategory; label: string; icon: string }[] = [
  { id: '',          label: 'Tümü',       icon: '🌟' },
  { id: 'gaming',    label: 'Oyun',       icon: '🎮' },
  { id: 'community', label: 'Topluluk',   icon: '👥' },
  { id: 'tech',      label: 'Teknoloji',  icon: '💻' },
  { id: 'education', label: 'Eğitim',     icon: '📚' },
  { id: 'art',       label: 'Sanat',      icon: '🎨' },
  { id: 'music',     label: 'Müzik',      icon: '🎵' },
  { id: 'anime',     label: 'Anime',      icon: '⛩️' },
  { id: 'science',   label: 'Bilim',      icon: '🔬' },
  { id: 'social',    label: 'Sosyal',     icon: '💬' },
];

// ── Trending score algorithm ──────────────────────────────────────────────────
// Score = log(members) * onlineRatio * recencyBoost * verifiedBoost * boostMultiplier

function _trendScore(s: DiscoverServer): number {
  const members     = Math.max(s.memberCount ?? 1, 1);
  const online      = s.onlineCount ?? 0;
  const onlineRatio = Math.min(online / members, 1);
  const ageDays     = s.createdAt ? (Date.now() - s.createdAt) / 86400000 : 365;
  const recency     = ageDays < 30 ? 1.5 : ageDays < 90 ? 1.2 : ageDays < 365 ? 1.0 : 0.85;
  const verified    = s.verified  ? 1.3 : 1.0;
  const boosted     = s.boostLevel ? 1 + s.boostLevel * 0.1 : 1.0;
  return Math.log10(members) * (0.4 + onlineRatio * 0.6) * recency * verified * boosted;
}

// ── State ─────────────────────────────────────────────────────────────────────

let _allServers:   DiscoverServer[] = [];
let _featured:     DiscoverServer[] = [];
let _tab:          DiscoverTab      = 'featured';
let _category:     DiscoverCategory = '';
let _query:        string           = '';
let _page:         number           = 0;
const PAGE_SIZE = 18;

// ── Open enhanced discover page ──────────────────────────────────────────────

export async function initDiscoverEnhanced(): Promise<void> {
  const container = document.getElementById('discover-root');
  if (!container) return;

  container.innerHTML = _skeleton();

  const API = getAPI();
  try {
    const [allRes, featuredRes] = await Promise.all([
      apiFetch(`${API}/api/discover`),
      apiFetch(`${API}/api/discover/featured`),
    ]);
    _allServers = allRes.ok     ? await allRes.json()     : [];
    _featured   = featuredRes.ok ? await featuredRes.json() : [];
  } catch {
    _allServers = [];
    _featured   = [];
  }

  // Pre-compute trend scores
  _allServers.forEach(s => { s._trendScore = _trendScore(s); });

  _tab      = 'featured';
  _category = '';
  _query    = '';
  _page     = 0;

  container.innerHTML = _renderPage();
  _bindLiveCount();
}
BridgeRegistry.register('initDiscoverEnhanced', initDiscoverEnhanced);

// ── Render page ───────────────────────────────────────────────────────────────

function _renderPage(): string {
  return `
    <div style="max-width:1100px;margin:0 auto;padding:24px 20px;">

      <!-- Hero banner -->
      <div style="background:linear-gradient(135deg,#2d9cdb,#1bc8a8);border-radius:16px;padding:32px;margin-bottom:28px;text-align:center;position:relative;overflow:hidden;">
        <div style="position:absolute;inset:0;background:url('data:image/svg+xml,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><circle cx=\"80\" cy=\"20\" r=\"40\" fill=\"rgba(255,255,255,.05)\"/><circle cx=\"20\" cy=\"80\" r=\"30\" fill=\"rgba(255,255,255,.05)\"/></svg>') center/cover;"></div>
        <div style="position:relative;">
          <h1 style="font-size:32px;font-weight:800;color:#fff;margin:0 0 8px;">🌉 Toplulukları Keşfet</h1>
          <p style="color:rgba(255,255,255,.8);font-size:15px;margin:0 0 20px;">${_allServers.length.toLocaleString()} topluluk seni bekliyor</p>
          <div style="max-width:520px;margin:0 auto;position:relative;">
            <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;">🔍</span>
            <input type="text" id="discover-search" placeholder="Topluluk ara..." value="${escHtml(_query)}"
              style="width:100%;padding:12px 14px 12px 42px;border-radius:10px;border:none;font-size:15px;outline:none;background:#fff;color:#333;box-sizing:border-box;"
              oninput="window._dcSearch(this.value)">
          </div>
        </div>
      </div>

      <!-- Tabs -->
      <div style="display:flex;gap:4px;margin-bottom:20px;background:var(--bg-secondary);border-radius:10px;padding:4px;">
        ${_tabBtn('featured', '⭐ Öne Çıkan')}
        ${_tabBtn('trending', '📈 Trend')}
        ${_tabBtn('new',      '✨ Yeni')}
        ${_tabBtn('foryou',   '💡 Sizin İçin')}
      </div>

      <!-- Category chips -->
      <div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:20px;scrollbar-width:none;">
        ${DISCOVER_CATEGORIES.map(c => `
          <button onclick="window._dcSetCat('${c.id}')"
            style="padding:6px 14px;border-radius:20px;border:none;cursor:pointer;white-space:nowrap;font-size:12px;flex-shrink:0;transition:all .15s;${_category===c.id?'background:var(--accent);color:#fff;font-weight:700;':'background:var(--bg-secondary);color:var(--text-2);'}">
            ${c.icon} ${c.label}</button>`).join('')}
      </div>

      <!-- Stats bar (trending tab) -->
      ${_tab === 'trending' ? _statsBar() : ''}

      <!-- Grid -->
      <div id="discover-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
        ${_renderCards()}
      </div>

      <!-- Pagination -->
      <div id="discover-pagination" style="margin-top:24px;display:flex;justify-content:center;gap:8px;">
        ${_renderPagination()}
      </div>
    </div>`;
}

// ── Cards ──────────────────────────────────────────────────────────────────────

function _renderCards(): string {
  const list = _filteredList();
  const page = list.slice(_page * PAGE_SIZE, (_page + 1) * PAGE_SIZE);
  if (!page.length) return `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-3);font-size:15px;">😕 Topluluk bulunamadı</div>`;
  return page.map(_serverCard).join('');
}

function _serverCard(s: DiscoverServer): string {
  const API    = getAPI();
  const icon   = s.iconUrl
    ? `<img src="${API}${escHtml(s.iconUrl)}" style="width:56px;height:56px;border-radius:14px;object-fit:cover;" loading="lazy">`
    : `<div style="width:56px;height:56px;border-radius:14px;background:linear-gradient(135deg,var(--accent),#1bc8a8);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;color:#fff;">${escHtml(s.name[0] ?? '?')}</div>`;

  const online   = s.onlineCount ?? 0;
  const members  = s.memberCount ?? 0;
  const tags     = (s.tags ?? []).slice(0, 3).map(t =>
    `<span style="background:var(--bg-1);border-radius:12px;padding:2px 7px;font-size:10px;color:var(--text-3);">${escHtml(t)}</span>`
  ).join('');

  const badges = [
    s.verified ? `<span title="Doğrulanmış" style="font-size:10px;background:#2d9cdb;color:#fff;border-radius:4px;padding:1px 5px;">✓ Resmi</span>` : '',
    s.featured  ? `<span style="font-size:10px;background:#f59e0b;color:#fff;border-radius:4px;padding:1px 5px;">⭐</span>` : '',
    (s.boostLevel ?? 0) >= 2 ? `<span style="font-size:10px;background:#6366f1;color:#fff;border-radius:4px;padding:1px 5px;">🚀 L${s.boostLevel}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:14px;overflow:hidden;cursor:pointer;transition:transform .15s,box-shadow .15s;"
      onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 6px 24px rgba(0,0,0,.2)'"
      onmouseleave="this.style.transform='';this.style.boxShadow=''"
      onclick="window._dcOpenServer('${escHtml(s._id)}')">

      ${s.bannerUrl
        ? `<div style="height:72px;background:url('${API}${escHtml(s.bannerUrl)}') center/cover no-repeat;"></div>`
        : `<div style="height:4px;background:linear-gradient(90deg,var(--accent),#1bc8a8);"></div>`}

      <div style="padding:14px 16px;">
        <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:10px;">
          ${icon}
          <div style="flex:1;min-width:0;">
            <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:2px;">
              <span style="font-weight:700;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(s.name)}</span>
              ${badges}
            </div>
            <div style="display:flex;gap:10px;font-size:11px;color:var(--text-3);">
              <span>👥 ${members.toLocaleString()}</span>
              <span style="color:#3ba55d;">● ${online.toLocaleString()} çevrimiçi</span>
            </div>
          </div>
        </div>

        ${s.description ? `<div style="font-size:12px;color:var(--text-2);line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${escHtml(s.description)}</div>` : ''}

        <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px;">${tags}</div>

        <button class="btn btn-primary" style="width:100%;font-size:13px;padding:7px;"
          onclick="event.stopPropagation();window._dcJoin('${escHtml(s._id)}')">
          Topluluğa Katıl
        </button>
      </div>
    </div>`;
}

// ── Pagination ────────────────────────────────────────────────────────────────

function _renderPagination(): string {
  const total = _filteredList().length;
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return '';

  const btns: string[] = [];
  if (_page > 0) btns.push(`<button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;" onclick="window._dcSetPage(${_page-1})">‹ Önceki</button>`);

  const start = Math.max(0, _page - 2);
  const end   = Math.min(pages - 1, _page + 2);
  for (let i = start; i <= end; i++) {
    btns.push(`<button class="btn" style="font-size:13px;padding:6px 12px;${i===_page?'background:var(--accent);color:#fff;':'background:var(--bg-secondary);color:var(--text-2);'}" onclick="window._dcSetPage(${i})">${i+1}</button>`);
  }

  if (_page < pages - 1) btns.push(`<button class="btn btn-secondary" style="font-size:13px;padding:6px 14px;" onclick="window._dcSetPage(${_page+1})">Sonraki ›</button>`);
  return btns.join('');
}

// ── Filter logic ──────────────────────────────────────────────────────────────

function _filteredList(): DiscoverServer[] {
  let list: DiscoverServer[];
  switch (_tab) {
    case 'featured': list = _featured.length ? _featured : _allServers.filter(s => s.featured); break;
    case 'trending': list = [..._allServers].sort((a, b) => (b._trendScore ?? 0) - (a._trendScore ?? 0)); break;
    case 'new':      list = [..._allServers].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)); break;
    case 'foryou':   list = _forYouList(); break;
    default:         list = _allServers;
  }
  if (_category) list = list.filter(s => s.category === _category || (s.tags ?? []).includes(_category));
  if (_query)    list = list.filter(s =>
    s.name.toLowerCase().includes(_query.toLowerCase()) ||
    (s.description ?? '').toLowerCase().includes(_query.toLowerCase()) ||
    (s.tags ?? []).some(t => t.toLowerCase().includes(_query.toLowerCase()))
  );
  return list;
}

function _forYouList(): DiscoverServer[] {
  // Simple heuristic: mix of mid-size active servers the user hasn't joined
  return [..._allServers]
    .filter(s => (s.memberCount ?? 0) > 50 && (s.memberCount ?? 0) < 5000)
    .sort((a, b) => (b._trendScore ?? 0) - (a._trendScore ?? 0))
    .slice(0, 60);
}

// ── Stats bar ─────────────────────────────────────────────────────────────────

function _statsBar(): string {
  const totalOnline = _allServers.reduce((acc, s) => acc + (s.onlineCount ?? 0), 0);
  const totalMembers= _allServers.reduce((acc, s) => acc + (s.memberCount ?? 0), 0);
  return `
    <div style="display:flex;gap:16px;padding:12px 16px;background:var(--bg-secondary);border-radius:10px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="display:flex;gap:6px;align-items:center;font-size:13px;">
        <span style="color:#3ba55d;font-size:16px;">●</span>
        <strong>${totalOnline.toLocaleString()}</strong> <span style="color:var(--text-3);">çevrimiçi</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;font-size:13px;">
        👥 <strong>${totalMembers.toLocaleString()}</strong> <span style="color:var(--text-3);">toplam üye</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;font-size:13px;">
        🌐 <strong>${_allServers.length.toLocaleString()}</strong> <span style="color:var(--text-3);">topluluk</span>
      </div>
    </div>`;
}

// ── Live online count updates via socket ──────────────────────────────────────

function _bindLiveCount(): void {
  const socket = (window as Window & { socket?: { on: (...a: unknown[]) => void } }).socket;
  if (!socket) return;

  socket.on('discover:online_update', (data: { serverId: string; count: number }) => {
    const s = _allServers.find(x => x._id === data.serverId);
    if (s) s.onlineCount = data.count;
    // Update displayed count
    const el = document.querySelector<HTMLElement>(`[data-online-id="${data.serverId}"]`);
    if (el) el.textContent = `● ${data.count.toLocaleString()} çevrimiçi`;
  });
}

// ── Tab button ────────────────────────────────────────────────────────────────

function _tabBtn(id: DiscoverTab, label: string): string {
  const active = _tab === id;
  return `<button onclick="window._dcSetTab('${id}')"
    style="flex:1;padding:8px 12px;border-radius:8px;border:none;cursor:pointer;font-size:13px;font-weight:${active?'700':'400'};transition:all .15s;${active?'background:var(--bg-primary);color:var(--text-1);box-shadow:0 1px 4px rgba(0,0,0,.2);':'background:transparent;color:var(--text-3);'}">${label}</button>`;
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function _skeleton(): string {
  return `<div style="max-width:1100px;margin:0 auto;padding:24px 20px;">
    <div style="height:140px;background:linear-gradient(135deg,#2d9cdb,#1bc8a8);border-radius:16px;margin-bottom:24px;animation:pulse 1.5s infinite;"></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px;">
      ${Array(6).fill(0).map(() => `<div style="height:200px;background:var(--bg-secondary);border-radius:14px;animation:pulse 1.5s infinite;"></div>`).join('')}
    </div>
  </div>`;
}

// ── Window handlers ───────────────────────────────────────────────────────────

function _dcSearch(q: string): void {
  _query = q; _page = 0;
  document.getElementById('discover-grid')!.innerHTML       = _renderCards();
  document.getElementById('discover-pagination')!.innerHTML = _renderPagination();
}
(window as Window & { _dcSearch?: typeof _dcSearch })._dcSearch = _dcSearch;

function _dcSetCat(c: DiscoverCategory): void {
  _category = c; _page = 0;
  document.getElementById('discover-grid')!.innerHTML       = _renderCards();
  document.getElementById('discover-pagination')!.innerHTML = _renderPagination();
}
(window as Window & { _dcSetCat?: typeof _dcSetCat })._dcSetCat = _dcSetCat;

function _dcSetTab(t: DiscoverTab): void {
  _tab = t; _page = 0;
  const container = document.getElementById('discover-root');
  if (container) container.innerHTML = _renderPage();
  _bindLiveCount();
}
(window as Window & { _dcSetTab?: typeof _dcSetTab })._dcSetTab = _dcSetTab;

function _dcSetPage(p: number): void {
  _page = p;
  document.getElementById('discover-grid')!.innerHTML       = _renderCards();
  document.getElementById('discover-pagination')!.innerHTML = _renderPagination();
  document.getElementById('discover-root')?.scrollIntoView({ behavior: 'smooth' });
}
(window as Window & { _dcSetPage?: typeof _dcSetPage })._dcSetPage = _dcSetPage;

async function _dcJoin(serverId: string): Promise<void> {
  const API = getAPI();
  const r = await apiFetch(`${API}/api/servers/${serverId}/join`, { method: 'POST' });
  if (!r.ok) { const d = await r.json(); toast(d.error ?? 'Katılım başarısız', 'error'); return; }
  toast('✅ Topluluğa katıldın!', 'success');
  BridgeRegistry.call('loadServers');
}
(window as Window & { _dcJoin?: typeof _dcJoin })._dcJoin = _dcJoin;

function _dcOpenServer(serverId: string): void {
  BridgeRegistry.call('openServerPreview', serverId);
}
(window as Window & { _dcOpenServer?: typeof _dcOpenServer })._dcOpenServer = _dcOpenServer;
