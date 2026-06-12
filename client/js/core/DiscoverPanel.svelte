<script lang="ts">
  // client/js/core/DiscoverPanel.svelte
  // Sprint 114: discover.ts + discover-enhanced.ts → Svelte 5 Runes (ADR-0008 Faz 2)
  //
  // Vanilla TS'deki window.* global handler'lar, string template render döngüsü
  // ve manual DOM manipülasyonu tamamen Svelte reaktivitesiyle değiştirildi.
  // Servis katmanı (apiFetch, getAPI, BridgeRegistry) değişmedi — ADR-0008 sınır kuralı.

  import { BridgeRegistry } from './bridge-registry.js';
  import { apiFetch }        from './api-fetch.js';
  import { getAPI }          from './globals.js';

  // ── Types ────────────────────────────────────────────────────────────────────

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
    _trendScore?: number;
  }

  interface Category { id: string; label: string; }

  type DiscoverTab      = 'featured' | 'trending' | 'new' | 'foryou';
  type DiscoverCategory =
    | '' | 'gaming' | 'education' | 'tech' | 'art'
    | 'music' | 'community' | 'anime' | 'science' | 'social';
  type SortMode         = 'members' | 'online' | 'newest' | 'name';

  // ── Sabitler ─────────────────────────────────────────────────────────────────

  const PAGE_SIZE = 18;

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

  // ── Svelte 5 Runes — State ───────────────────────────────────────────────────

  let allServers   = $state<DiscoverServer[]>([]);
  let featured     = $state<DiscoverServer[]>([]);
  let categories   = $state<Category[]>([]);
  let loading      = $state(true);
  let error        = $state('');

  // Filtre state'i
  let tab          = $state<DiscoverTab>('featured');
  let category     = $state<DiscoverCategory>('');
  let query        = $state('');
  let sortMode     = $state<SortMode>('members');
  let page         = $state(0);

  // Socket abonelik takibi (reactive olmayan — sadece cleanup için)
  let subscribed   = false;

  // ── Trending score algoritması ───────────────────────────────────────────────

  function trendScore(s: DiscoverServer): number {
    const members     = Math.max(s.memberCount ?? 1, 1);
    const online      = s.onlineCount ?? 0;
    const onlineRatio = Math.min(online / members, 1);
    const ageDays     = s.createdAt ? (Date.now() - s.createdAt) / 86400000 : 365;
    const recency     = ageDays < 30 ? 1.5 : ageDays < 90 ? 1.2 : ageDays < 365 ? 1.0 : 0.85;
    const verifiedB   = s.verified   ? 1.3 : 1.0;
    const boosted     = s.boostLevel ? 1 + s.boostLevel * 0.1 : 1.0;
    return Math.log10(members) * (0.4 + onlineRatio * 0.6) * recency * verifiedB * boosted;
  }

  // ── Derived: filtrelenmiş + sıralanmış liste ─────────────────────────────────

  const filteredList = $derived.by((): DiscoverServer[] => {
    let list: DiscoverServer[];

    switch (tab) {
      case 'featured':
        list = featured.length ? featured : allServers.filter(s => s.featured);
        break;
      case 'trending':
        list = [...allServers].sort((a, b) => (b._trendScore ?? 0) - (a._trendScore ?? 0));
        break;
      case 'new':
        list = [...allServers].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        break;
      case 'foryou':
        list = [...allServers]
          .filter(s => (s.memberCount ?? 0) > 50 && (s.memberCount ?? 0) < 5000)
          .sort((a, b) => (b._trendScore ?? 0) - (a._trendScore ?? 0))
          .slice(0, 60);
        break;
      default:
        // featured tab ama sort mode de aktif (basit discover modunda)
        list = [...allServers];
        if (sortMode === 'members') list.sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0));
        else if (sortMode === 'online')  list.sort((a, b) => (b.onlineCount ?? 0) - (a.onlineCount ?? 0));
        else if (sortMode === 'newest')  list.sort((a, b) => (b.createdAt   ?? 0) - (a.createdAt   ?? 0));
        else if (sortMode === 'name')    list.sort((a, b) => a.name.localeCompare(b.name));
    }

    if (category) {
      list = list.filter(s => s.category === category || (s.tags ?? []).includes(category));
    }
    if (query) {
      const lq = query.toLowerCase();
      list = list.filter(s =>
        s.name.toLowerCase().includes(lq) ||
        (s.description ?? '').toLowerCase().includes(lq) ||
        (s.tags ?? []).some(t => t.toLowerCase().includes(lq))
      );
    }

    return list;
  });

  const pageCount    = $derived(Math.ceil(filteredList.length / PAGE_SIZE));
  const pagedServers = $derived(filteredList.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE));

  const totalOnline  = $derived(allServers.reduce((a, s) => a + (s.onlineCount ?? 0), 0));
  const totalMembers = $derived(allServers.reduce((a, s) => a + (s.memberCount ?? 0), 0));

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    loading = true;
    error   = '';
    const API = getAPI();

    try {
      const [allRes, featuredRes, catsRes] = await Promise.all([
        apiFetch(`${API}/api/discover`),
        apiFetch(`${API}/api/discover/featured`),
        apiFetch(`${API}/api/discover/categories`),
      ]);

      const rawServers: DiscoverServer[] = allRes.ok     ? await allRes.json()     : [];
      featured  = featuredRes.ok ? await featuredRes.json() : [];
      categories = catsRes.ok    ? await catsRes.json()     : [];

      // Trend skorlarını hesapla
      rawServers.forEach(s => { s._trendScore = trendScore(s); });
      allServers = rawServers;

    } catch (e) {
      error = e instanceof Error ? e.message : 'Sunucular yüklenemedi';
    } finally {
      loading = false;
    }

    subscribeRealtimeCounts();
  }

  // ── Socket: gerçek zamanlı üye/online güncellemeleri ─────────────────────────

  function subscribeRealtimeCounts(): void {
    const sock = (window as any).socket as {
      emit(e: string, d?: unknown): void;
      on(e: string, cb: (d: any) => void): void;
      off(e: string): void;
    } | null;

    if (!sock || subscribed) return;
    subscribed = true;
    sock.emit('discover:subscribe');

    sock.on('discover:memberCount', ({ serverId, memberCount, onlineCount }: {
      serverId: string; memberCount: number; onlineCount: number;
    }) => {
      // Svelte reaktivitesi için yeni dizi ata (splice yerine)
      allServers = allServers.map(s =>
        s._id === serverId ? { ...s, memberCount, onlineCount } : s
      );
      featured = featured.map(s =>
        s._id === serverId ? { ...s, memberCount, onlineCount } : s
      );
    });

    sock.on('discover:online_update', ({ serverId, count }: { serverId: string; count: number }) => {
      allServers = allServers.map(s =>
        s._id === serverId ? { ...s, onlineCount: count } : s
      );
    });
  }

  function unsubscribeRealtimeCounts(): void {
    const sock = (window as any).socket as {
      emit(e: string): void; off(e: string): void;
    } | null;
    if (!sock || !subscribed) return;
    sock.emit('discover:unsubscribe');
    sock.off('discover:memberCount');
    sock.off('discover:online_update');
    subscribed = false;
  }

  // ── Aksiyonlar ───────────────────────────────────────────────────────────────

  async function joinServer(serverId: string): Promise<void> {
    const API = getAPI();
    const r = await apiFetch(`${API}/api/servers/${serverId}/join`, { method: 'POST' });
    if (!r.ok) {
      const d = await r.json().catch(() => ({})) as { error?: string };
      BridgeRegistry.call('toast', d.error ?? 'Katılım başarısız', 'error');
      return;
    }
    BridgeRegistry.call('toast', '✅ Topluluğa katıldın!', 'success');
    BridgeRegistry.call('loadServers');
  }

  function openServerPreview(serverId: string): void {
    BridgeRegistry.call('openServerPreview', serverId);
  }

  // ── Debounced search ─────────────────────────────────────────────────────────

  let searchDebounce: ReturnType<typeof setTimeout>;
  function onSearchInput(e: Event): void {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      query = (e.target as HTMLInputElement).value;
      page  = 0;
    }, 200);
  }

  function setTab(t: DiscoverTab): void {
    tab  = t;
    page = 0;
  }

  function setCat(c: DiscoverCategory): void {
    category = c;
    page     = 0;
  }

  // ── Svelte lifecycle ─────────────────────────────────────────────────────────

  $effect(() => {
    void init();
    return () => { unsubscribeRealtimeCounts(); };
  });
</script>

<!-- ── Template ──────────────────────────────────────────────────────────────── -->

<div class="discover-root">

  {#if loading}
    <!-- Skeleton -->
    <div class="discover-skeleton-hero"></div>
    <div class="discover-skeleton-grid">
      {#each Array(6) as _}
        <div class="skeleton-card"></div>
      {/each}
    </div>

  {:else if error}
    <div class="discover-error">
      <span class="discover-error-icon">⚠️</span>
      <p>{error}</p>
      <button class="btn btn-secondary" onclick={() => void init()}>Tekrar Dene</button>
    </div>

  {:else}
    <!-- Hero Banner -->
    <div class="discover-hero">
      <div class="discover-hero-bg"></div>
      <div class="discover-hero-content">
        <h1 class="discover-hero-title">🌉 Toplulukları Keşfet</h1>
        <p class="discover-hero-sub">{allServers.length.toLocaleString()} topluluk seni bekliyor</p>
        <div class="discover-searchbar-wrap">
          <span class="discover-search-icon">🔍</span>
          <input
            type="text"
            class="discover-search-input"
            placeholder="Topluluk ara..."
            oninput={onSearchInput}
          />
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="discover-tabs">
      {#each ([['featured','⭐ Öne Çıkan'],['trending','📈 Trend'],['new','✨ Yeni'],['foryou','💡 Sizin İçin']] as const) as [id, label]}
        <button
          class="discover-tab-btn"
          class:active={tab === id}
          onclick={() => setTab(id as DiscoverTab)}
        >{label}</button>
      {/each}
    </div>

    <!-- Category chips -->
    <div class="discover-categories">
      {#each DISCOVER_CATEGORIES as cat}
        <button
          class="cat-chip"
          class:active={category === cat.id}
          onclick={() => setCat(cat.id as DiscoverCategory)}
        >{cat.icon} {cat.label}</button>
      {/each}
    </div>

    <!-- Trending stats bar -->
    {#if tab === 'trending'}
      <div class="discover-stats-bar">
        <span><span class="online-dot">●</span> <strong>{totalOnline.toLocaleString()}</strong> çevrimiçi</span>
        <span>👥 <strong>{totalMembers.toLocaleString()}</strong> toplam üye</span>
        <span>🌐 <strong>{allServers.length.toLocaleString()}</strong> topluluk</span>
      </div>
    {/if}

    <!-- Featured section (tab = featured + featured listesi doluysa) -->
    {#if tab === 'featured' && featured.length > 0 && !query && !category}
      <section class="discover-featured-section">
        <h2 class="discover-section-title">⭐ Öne Çıkan Sunucular</h2>
        <div class="discover-featured-list">
          {#each featured as s (s._id)}
            <div class="featured-card">
              {#if s.bannerUrl}
                <div class="featured-banner" style="background-image:url('{getAPI()}{s.bannerUrl}')"></div>
              {:else}
                <div class="featured-banner featured-banner--placeholder"></div>
              {/if}
              <div class="featured-card-body">
                {#if s.iconUrl}
                  <img src="{getAPI()}{s.iconUrl}" class="featured-icon" alt="" loading="lazy" />
                {:else}
                  <div class="featured-icon featured-icon--letter">{s.name[0]}</div>
                {/if}
                <div class="featured-card-info">
                  <div class="featured-card-name">{s.name}</div>
                  <div class="featured-card-desc">{(s.description ?? '').slice(0, 80)}</div>
                  <div class="featured-card-meta">
                    <span class="discover-member-count">{(s.memberCount ?? 0).toLocaleString('tr')} üye</span>
                    <span class="discover-online-count">● {s.onlineCount ?? 0} çevrimiçi</span>
                  </div>
                </div>
                <button
                  class="btn btn-primary btn-sm"
                  onclick={(e) => { e.stopPropagation(); void joinServer(s._id); }}
                >Katıl</button>
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Server Grid -->
    <div class="discover-grid">
      {#if pagedServers.length === 0}
        <div class="discover-empty">
          <span style="font-size:48px">😕</span>
          <p>Topluluk bulunamadı</p>
          {#if query || category}
            <button class="btn btn-secondary btn-sm" onclick={() => { query = ''; category = ''; page = 0; }}>
              Filtreleri Temizle
            </button>
          {/if}
        </div>
      {:else}
        {#each pagedServers as s (s._id)}
          <!-- Server Card -->
          <div
            class="discover-card"
            role="button"
            tabindex="0"
            onclick={() => openServerPreview(s._id)}
            onkeydown={(e) => e.key === 'Enter' && openServerPreview(s._id)}
          >
            {#if s.bannerUrl}
              <div class="discover-card-banner" style="background-image:url('{getAPI()}{s.bannerUrl}')"></div>
            {:else}
              <div class="discover-card-banner-accent"></div>
            {/if}

            <div class="discover-card-body">
              <div class="discover-card-header">
                {#if s.iconUrl}
                  <img src="{getAPI()}{s.iconUrl}" class="discover-card-icon" alt="" loading="lazy" />
                {:else}
                  <div class="discover-card-icon discover-card-icon--letter">{s.name[0] ?? '?'}</div>
                {/if}
                <div class="discover-card-meta-wrap">
                  <div class="discover-card-name-row">
                    <span class="discover-card-name">{s.name}</span>
                    {#if s.verified}
                      <span class="badge badge-verified" title="Doğrulanmış">✓ Resmi</span>
                    {/if}
                    {#if s.featured}
                      <span class="badge badge-featured">⭐</span>
                    {/if}
                    {#if (s.boostLevel ?? 0) >= 2}
                      <span class="badge badge-boost">🚀 L{s.boostLevel}</span>
                    {/if}
                  </div>
                  <div class="discover-card-counts">
                    <span>👥 {(s.memberCount ?? 0).toLocaleString()}</span>
                    <span class="online-count">● {(s.onlineCount ?? 0).toLocaleString()} çevrimiçi</span>
                  </div>
                </div>
              </div>

              {#if s.description}
                <p class="discover-card-desc">{s.description}</p>
              {/if}

              {#if s.tags?.length}
                <div class="discover-card-tags">
                  {#each (s.tags ?? []).slice(0, 3) as tag}
                    <span class="discover-tag">{tag}</span>
                  {/each}
                </div>
              {/if}

              <button
                class="btn btn-primary discover-join-btn"
                onclick={(e) => { e.stopPropagation(); void joinServer(s._id); }}
              >Topluluğa Katıl</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Pagination -->
    {#if pageCount > 1}
      <div class="discover-pagination">
        {#if page > 0}
          <button class="btn btn-secondary btn-sm" onclick={() => page -= 1}>‹ Önceki</button>
        {/if}

        {#each Array.from({ length: pageCount }, (_, i) => i)
          .filter(i => Math.abs(i - page) <= 2) as i}
          <button
            class="btn btn-sm"
            class:active-page={i === page}
            onclick={() => page = i}
          >{i + 1}</button>
        {/each}

        {#if page < pageCount - 1}
          <button class="btn btn-secondary btn-sm" onclick={() => page += 1}>Sonraki ›</button>
        {/if}
      </div>
    {/if}
  {/if}

</div>

<!-- ── Styles ─────────────────────────────────────────────────────────────────── -->

<style>
  .discover-root {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px 20px;
  }

  /* Hero */
  .discover-hero {
    background: linear-gradient(135deg, #2d9cdb, #1bc8a8);
    border-radius: 16px;
    padding: 32px;
    margin-bottom: 28px;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .discover-hero-bg {
    position: absolute;
    inset: 0;
    background:
      radial-gradient(circle at 80% 20%, rgba(255,255,255,.06) 40%, transparent 40%),
      radial-gradient(circle at 20% 80%, rgba(255,255,255,.06) 30%, transparent 30%);
  }
  .discover-hero-content { position: relative; }
  .discover-hero-title {
    font-size: 32px;
    font-weight: 800;
    color: #fff;
    margin: 0 0 8px;
  }
  .discover-hero-sub {
    color: rgba(255,255,255,.8);
    font-size: 15px;
    margin: 0 0 20px;
  }
  .discover-searchbar-wrap {
    max-width: 520px;
    margin: 0 auto;
    position: relative;
  }
  .discover-search-icon {
    position: absolute;
    left: 14px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 16px;
  }
  .discover-search-input {
    width: 100%;
    padding: 12px 14px 12px 42px;
    border-radius: 10px;
    border: none;
    font-size: 15px;
    outline: none;
    background: #fff;
    color: #333;
    box-sizing: border-box;
  }

  /* Tabs */
  .discover-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    background: var(--bg-secondary);
    border-radius: 10px;
    padding: 4px;
  }
  .discover-tab-btn {
    flex: 1;
    padding: 8px 12px;
    border-radius: 8px;
    border: none;
    cursor: pointer;
    font-size: 13px;
    font-weight: 400;
    background: transparent;
    color: var(--text-3);
    transition: all .15s;
  }
  .discover-tab-btn.active {
    background: var(--bg-primary);
    color: var(--text-1);
    font-weight: 700;
    box-shadow: 0 1px 4px rgba(0,0,0,.2);
  }

  /* Categories */
  .discover-categories {
    display: flex;
    gap: 6px;
    overflow-x: auto;
    padding-bottom: 4px;
    margin-bottom: 20px;
    scrollbar-width: none;
  }
  .discover-categories::-webkit-scrollbar { display: none; }
  .cat-chip {
    padding: 6px 14px;
    border-radius: 20px;
    border: none;
    cursor: pointer;
    white-space: nowrap;
    font-size: 12px;
    flex-shrink: 0;
    background: var(--bg-secondary);
    color: var(--text-2);
    transition: all .15s;
  }
  .cat-chip.active {
    background: var(--accent);
    color: #fff;
    font-weight: 700;
  }

  /* Stats bar */
  .discover-stats-bar {
    display: flex;
    gap: 16px;
    padding: 12px 16px;
    background: var(--bg-secondary);
    border-radius: 10px;
    margin-bottom: 16px;
    flex-wrap: wrap;
    font-size: 13px;
  }
  .online-dot { color: #3ba55d; font-size: 16px; }

  /* Featured section */
  .discover-featured-section { margin-bottom: 28px; }
  .discover-section-title {
    font-size: 16px;
    font-weight: 700;
    margin: 0 0 12px;
    color: var(--text-1);
  }
  .discover-featured-list {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    padding-bottom: 8px;
    scrollbar-width: thin;
  }
  .featured-card {
    min-width: 260px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .featured-banner {
    height: 72px;
    background-size: cover;
    background-position: center;
  }
  .featured-banner--placeholder {
    background: linear-gradient(135deg, var(--accent), #1bc8a8);
    height: 4px;
  }
  .featured-card-body {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px;
  }
  .featured-icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .featured-icon--letter {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--accent), #1bc8a8);
    color: #fff;
    font-weight: 800;
    font-size: 18px;
  }
  .featured-card-info { flex: 1; min-width: 0; }
  .featured-card-name { font-weight: 700; font-size: 13px; }
  .featured-card-desc { font-size: 11px; color: var(--text-2); margin: 2px 0; }
  .featured-card-meta { display: flex; gap: 8px; font-size: 11px; color: var(--text-3); }
  .discover-online-count { color: #3ba55d; }

  /* Grid */
  .discover-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }

  /* Server card */
  .discover-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 14px;
    overflow: hidden;
    cursor: pointer;
    transition: transform .15s, box-shadow .15s;
  }
  .discover-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 24px rgba(0,0,0,.2);
  }
  .discover-card-banner {
    height: 72px;
    background-size: cover;
    background-position: center;
  }
  .discover-card-banner-accent {
    height: 4px;
    background: linear-gradient(90deg, var(--accent), #1bc8a8);
  }
  .discover-card-body { padding: 14px 16px; }
  .discover-card-header { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 10px; }
  .discover-card-icon {
    width: 56px;
    height: 56px;
    border-radius: 14px;
    object-fit: cover;
    flex-shrink: 0;
  }
  .discover-card-icon--letter {
    display: flex;
    align-items: center;
    justify-content: center;
    background: linear-gradient(135deg, var(--accent), #1bc8a8);
    color: #fff;
    font-weight: 800;
    font-size: 24px;
  }
  .discover-card-meta-wrap { flex: 1; min-width: 0; }
  .discover-card-name-row {
    display: flex;
    align-items: center;
    gap: 4px;
    flex-wrap: wrap;
    margin-bottom: 2px;
  }
  .discover-card-name { font-weight: 700; font-size: 14px; }
  .discover-card-counts { display: flex; gap: 10px; font-size: 11px; color: var(--text-3); }
  .online-count { color: #3ba55d; }
  .discover-card-desc {
    font-size: 12px;
    color: var(--text-2);
    line-height: 1.5;
    margin-bottom: 10px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .discover-card-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }
  .discover-tag {
    background: var(--bg-1);
    border-radius: 12px;
    padding: 2px 7px;
    font-size: 10px;
    color: var(--text-3);
  }
  .discover-join-btn { width: 100%; font-size: 13px; padding: 7px; }

  /* Badges */
  .badge { font-size: 10px; border-radius: 4px; padding: 1px 5px; }
  .badge-verified { background: #2d9cdb; color: #fff; }
  .badge-featured  { background: #f59e0b; color: #fff; }
  .badge-boost     { background: #6366f1; color: #fff; }

  /* Empty state */
  .discover-empty {
    grid-column: 1 / -1;
    text-align: center;
    padding: 60px 20px;
    color: var(--text-3);
    font-size: 15px;
  }

  /* Pagination */
  .discover-pagination {
    margin-top: 24px;
    display: flex;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .active-page {
    background: var(--accent) !important;
    color: #fff !important;
  }

  /* Skeleton */
  .discover-skeleton-hero {
    height: 160px;
    background: linear-gradient(135deg, #2d9cdb, #1bc8a8);
    border-radius: 16px;
    margin-bottom: 24px;
    animation: pulse 1.5s ease-in-out infinite;
  }
  .discover-skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 16px;
  }
  .skeleton-card {
    height: 200px;
    background: var(--bg-secondary);
    border-radius: 14px;
    animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: .5; }
  }

  /* Error */
  .discover-error {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-2);
  }
  .discover-error-icon { font-size: 48px; display: block; margin-bottom: 12px; }
</style>
