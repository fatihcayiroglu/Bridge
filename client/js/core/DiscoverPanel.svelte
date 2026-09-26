<script lang="ts">
  import { t, localeTag } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  // client/js/core/DiscoverPanel.svelte
  // Sprint 114: discover.ts + discover-enhanced.ts → Svelte 5 Runes (ADR-0008 Faz 2)
  //
  // Vanilla TS'deki window.* global handler'lar, string template render döngüsü
  // ve manual DOM manipülasyonu tamamen Svelte reaktivitesiyle değiştirildi.
  // Servis katmanı (apiFetch, getAPI, BridgeRegistry) değişmedi — ADR-0008 sınır kuralı.

  import { BridgeRegistry } from './bridge-registry.js';
  import { apiFetch }        from './api-fetch.js';
  import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';
  import { getAPI }          from './globals.js';
  import { resolveLocalAssetUrl } from './local-asset-url.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';

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

  type DiscoverTab      = 'featured' | 'trending' | 'new' | 'foryou';
  type DiscoverCategory =
    | '' | 'gaming' | 'education' | 'tech' | 'art'
    | 'music' | 'community' | 'anime' | 'science' | 'social';
  // ── Sabitler ─────────────────────────────────────────────────────────────────

  const PAGE_SIZE = 18;
  const MAX_SERVERS = 1000;
  const MAX_FEATURED_SERVERS = 100;
  const MAX_COUNT = 1_000_000_000;

  const DISCOVER_CATEGORIES: { id: DiscoverCategory; label: string; icon: string }[] = $derived.by(() => [
    { id: '',          label: t("all", "Tümü"),       icon: '🌟' },
    { id: 'gaming',    label: t('ui_discover_gaming', 'Oyun'),       icon: '🎮' },
    { id: 'community', label: t('ui_discover_community', 'Topluluk'),   icon: '👥' },
    { id: 'tech',      label: t('ui_discover_technology', 'Teknoloji'),  icon: '💻' },
    { id: 'education', label: t("ui_egitim", "Eğitim"),     icon: '📚' },
    { id: 'art',       label: t('ui_discover_art', 'Sanat'),      icon: '🎨' },
    { id: 'music',     label: t("ui_muzik", "Müzik"),      icon: '🎵' },
    { id: 'anime',     label: t('ui_discover_anime', 'Anime'),      icon: '⛩️' },
    { id: 'science',   label: t('ui_discover_science', 'Bilim'),      icon: '🔬' },
    { id: 'social',    label: t('ui_discover_social', 'Sosyal'),     icon: '💬' },
  ]);
  // `DISCOVER_CATEGORIES` bir `$derived.by` (dil degisince yeniden kurulur).
  // Bunu duz bir `new Set(...)` ile bir KEZ yakalamak, kategori kumesi
  // ileride gercekten degistiginde sessizce bayat kalirdi.
  const DISCOVER_CATEGORY_IDS = $derived(new Set(DISCOVER_CATEGORIES.map(({ id }) => id)));

  // ── Svelte 5 Runes — State ───────────────────────────────────────────────────

  let allServers   = $state<DiscoverServer[]>([]);
  let featured     = $state<DiscoverServer[]>([]);
  let loading      = $state(true);
  let error        = $state('');

  // Filtre state'i
  const TAB_IDS: DiscoverTab[] = ['featured', 'trending', 'new', 'foryou'];
  let tab          = $state<DiscoverTab>('featured');
  let category     = $state<DiscoverCategory>('');
  let query        = $state('');
  let page         = $state(0);
  let joining      = $state<Set<string>>(new Set());
  let requestSeq   = 0;

  // Socket abonelik takibi (reactive olmayan — sadece cleanup için)
  type DiscoverSocket = {
    emit(e: string, d?: unknown): void;
    on<T>(e: string, cb: (d: T) => void): void;
    off<T>(e: string, cb?: (d: T) => void): void;
  };
  let boundSocket: DiscoverSocket | null = null;

  function boundedText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.trim().slice(0, maxLength);
    return text || undefined;
  }

  function boundedNumber(value: unknown, max = MAX_COUNT): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
    return Math.min(Math.trunc(value), max);
  }

  function normalizeServer(value: unknown): DiscoverServer | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, unknown>;
    const _id = boundedText(raw._id, 128);
    const name = boundedText(raw.name, 120);
    if (!_id || !name) return null;

    const rawCategory = boundedText(raw.category, 32);
    const category = rawCategory && DISCOVER_CATEGORY_IDS.has(rawCategory as DiscoverCategory)
      ? rawCategory as DiscoverCategory
      : undefined;
    const tags = Array.isArray(raw.tags)
      ? [...new Set(raw.tags
          .map(tag => boundedText(tag, 32))
          .filter((tag): tag is string => Boolean(tag)))]
          .slice(0, 12)
      : undefined;

    return {
      _id,
      name,
      description: boundedText(raw.description, 1000),
      iconUrl: boundedText(raw.iconUrl, 2048),
      bannerUrl: boundedText(raw.bannerUrl, 2048),
      memberCount: boundedNumber(raw.memberCount),
      onlineCount: boundedNumber(raw.onlineCount),
      tags,
      category,
      boostLevel: boundedNumber(raw.boostLevel, 100),
      verified: raw.verified === true,
      featured: raw.featured === true,
      createdAt: boundedNumber(raw.createdAt, Number.MAX_SAFE_INTEGER),
    };
  }

  function normalizeServers(value: unknown, limit: number): DiscoverServer[] {
    if (!Array.isArray(value)) return [];
    const servers: DiscoverServer[] = [];
    const ids = new Set<string>();
    for (const candidate of value) {
      const server = normalizeServer(candidate);
      if (!server || ids.has(server._id)) continue;
      ids.add(server._id);
      servers.push(server);
      if (servers.length === limit) break;
    }
    return servers;
  }

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

  // Final21 UX: varsayılan sekme "Öne Çıkan" idi; kimsenin öne çıkarmadığı bir örnekte
  // (kendi barındırılan kurulumların neredeyse tamamı) açılış ekranı "Topluluk bulunamadı"
  // diyordu, hemen üstündeki başlık ise "10 topluluk seni bekliyor". "Sizin İçin" de 51–4999
  // üyeli sunucuları süzdüğü için küçük örneklerde HEP boştu. İçeriği olmayan sekme
  // gösterilmez; kullanıcı bir sekme seçmediyse içeriği olan ilk sekme açılır.
  function tabHasContent(id: DiscoverTab): boolean {
    if (id === 'featured') return featured.length > 0 || allServers.some(s => s.featured);
    if (id === 'foryou') return allServers.some(s => (s.memberCount ?? 0) > 50 && (s.memberCount ?? 0) < 5000);
    return allServers.length > 0;
  }
  let tabChosenByUser = false;
  const visibleTabs = $derived(TAB_IDS.filter((id) => tabHasContent(id)));
  $effect(() => {
    if (tabChosenByUser || !visibleTabs.length || visibleTabs.includes(tab)) return;
    tab = visibleTabs[0]!;
  });

  const filteredList = $derived.by((): DiscoverServer[] => {
    let list: DiscoverServer[];

    switch (tab) {
      case 'featured':
        list = featured.length ? featured : allServers.filter(s => s.featured);
        break;
      case 'trending':
        list = [...allServers].sort((a, b) => b._trendScore! - a._trendScore!);
        break;
      case 'new':
        list = [...allServers].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        break;
      case 'foryou':
        list = [...allServers]
          .filter(s => {
            const memberCount = s.memberCount ?? 0;
            return memberCount > 50 && memberCount < 5000;
          })
          .sort((a, b) => b._trendScore! - a._trendScore!)
          .slice(0, 60);
        break;
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

  $effect(() => {
    const lastPage = Math.max(pageCount - 1, 0);
    if (page > lastPage) page = lastPage;
  });

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    const seq = ++requestSeq;
    loading = true;
    error   = '';
    const API = getAPI();

    try {
      const [allRes, featuredRes] = await Promise.all([
        apiFetch(`${API}/api/discover?limit=${MAX_SERVERS}`),
        apiFetch(`${API}/api/discover/featured`),
      ]);

      if (!allRes.ok) throw new ApiResponseError(allRes);
      const [rawServers, rawFeatured] = await Promise.all([
        allRes.json() as Promise<unknown>,
        featuredRes.ok ? featuredRes.json() as Promise<unknown> : Promise.resolve([]),
      ]);

      const nextServers = normalizeServers(rawServers, MAX_SERVERS);
      const nextFeatured = normalizeServers(rawFeatured, MAX_FEATURED_SERVERS);
      if (seq !== requestSeq || !isVisible) return;

      // Trend skorlarını hesapla
      nextServers.forEach(s => { s._trendScore = trendScore(s); });
      nextFeatured.forEach(s => { s._trendScore = trendScore(s); });
      allServers = nextServers;
      featured = nextFeatured;

    } catch (e) {
      if (seq === requestSeq && isVisible) {
        error = safeApiErrorMessage(e, t('discover_load_failed', 'Sunucular yüklenemedi. Tekrar dene.'), { report: true });
      }
    } finally {
      if (seq === requestSeq && isVisible) loading = false;
    }

    if (seq === requestSeq && isVisible) subscribeRealtimeCounts();
  }

  // ── Socket: gerçek zamanlı üye/online güncellemeleri ─────────────────────────

  function withRealtimeCounts(
    server: DiscoverServer,
    serverId: string,
    counts: Pick<DiscoverServer, 'memberCount' | 'onlineCount'> | Pick<DiscoverServer, 'onlineCount'>,
  ): DiscoverServer {
    if (server._id !== serverId) return server;
    const updated = { ...server, ...counts };
    updated._trendScore = trendScore(updated);
    return updated;
  }

  function onMemberCount(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const raw = payload as Record<string, unknown>;
    const serverId = boundedText(raw.serverId, 128);
    const memberCount = boundedNumber(raw.memberCount);
    const onlineCount = boundedNumber(raw.onlineCount);
    if (!serverId || memberCount === undefined || onlineCount === undefined) return;
    allServers = allServers.map(s => withRealtimeCounts(s, serverId, { memberCount, onlineCount }));
    featured = featured.map(s => withRealtimeCounts(s, serverId, { memberCount, onlineCount }));
  }

  function onOnlineUpdate(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const raw = payload as Record<string, unknown>;
    const serverId = boundedText(raw.serverId, 128);
    const count = boundedNumber(raw.count);
    if (!serverId || count === undefined) return;
    allServers = allServers.map(s => withRealtimeCounts(s, serverId, { onlineCount: count }));
    featured = featured.map(s => withRealtimeCounts(s, serverId, { onlineCount: count }));
  }

  function unsubscribeRealtimeCounts(): void {
    const sock = boundSocket;
    if (!sock) return;
    // Remove only listeners owned by this panel. `off(event)` would erase
    // unrelated consumers sharing the same Socket.IO event.
    sock.off('discover:memberCount', onMemberCount);
    sock.off('discover:online_update', onOnlineUpdate);
    sock.emit('discover:unsubscribe');
    boundSocket = null;
  }

  function subscribeRealtimeCounts(): void {
    const sock = BridgeRegistry.get<DiscoverSocket>('socket');
    if (sock === boundSocket) return;
    unsubscribeRealtimeCounts();
    if (!sock) return;
    boundSocket = sock;
    sock.emit('discover:subscribe');
    sock.on('discover:memberCount', onMemberCount);
    sock.on('discover:online_update', onOnlineUpdate);
  }

  function onSocketReady(): void {
    if (isVisible) subscribeRealtimeCounts();
  }

  // ── Aksiyonlar ───────────────────────────────────────────────────────────────

  async function joinServer(serverId: string): Promise<void> {
    if (joining.has(serverId)) return;
    joining = new Set(joining).add(serverId);
    const API = getAPI();
    try {
      const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(serverId)}/join`, { method: 'POST' });
      if (!r.ok) {
        BridgeRegistry.call('toast', safeApiErrorMessage(r, t('discover_join_failed', 'Topluluğa katılınamadı. Tekrar dene.'), { report: true }), 'error');
        return;
      }
      BridgeRegistry.call('toast', t("ui_topluluga_katildin", "✅ Topluluğa katıldın!"), 'success');
      BridgeRegistry.call('loadServers');
    } catch (e) {
      BridgeRegistry.call('toast', safeApiErrorMessage(e, t('discover_join_failed', 'Topluluğa katılınamadı. Tekrar dene.'), { report: true }), 'error');
    } finally {
      const next = new Set(joining);
      next.delete(serverId);
      joining = next;
    }
  }

  function openServerPreview(serverId: string): void {
    BridgeRegistry.call('openServerPreview', serverId);
  }

  function assetUrl(value: unknown): string {
    return resolveLocalAssetUrl(value, getAPI(), window.location.origin);
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

  // ── Görünürlük sözleşmesi ────────────────────────────────────────────────────
  //
  // Faz 12 sonrası — KEŞFET BAĞLANDI.
  // Bileşen 798 satırlık gerçek bir uygulamaydı ama hiçbir yerden açılamıyordu:
  // shim'i import edilmiyordu, `#discover-root` yoktu ve bir açıcı kontrol de
  // bulunmuyordu. Görünürlük modeli kardeş yüzey FriendsPanel ile AYNIdır
  // (isVisible + registry show/hide) — yeni bir mimari getirilmez.
  let isVisible = $state(false);

  function open(): void {
    closeExclusivePeers('discover');
    if (isVisible) return;      // tekrar açmak ikinci bir yükleme başlatmaz
    isVisible = true;
    // Realtime ownership must not wait for two REST requests.  If discovery
    // HTTP is slow/offline, the visible panel still owns exactly one socket
    // subscription and reconnect can rebind it immediately.
    subscribeRealtimeCounts();
    void init();
  }

  function close(): void {
    requestSeq += 1;
    clearTimeout(searchDebounce);
    isVisible = false;
    unsubscribeRealtimeCounts();   // bayat socket dinleyicisi bırakma
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape' && isVisible) close();
  }

  // ── Svelte lifecycle ─────────────────────────────────────────────────────────

  $effect(() => {
    BridgeRegistry.register('showDiscoverPanel', open);
    BridgeRegistry.register('openDiscoverPanel', open);
    BridgeRegistry.register('hideDiscoverPanel', close);
    window.addEventListener('keydown', onKeydown);
    document.addEventListener('bridge:socket-ready', onSocketReady);
    document.addEventListener('bridge:socket-reconnected', onSocketReady);

    return () => {
      window.removeEventListener('keydown', onKeydown);
      document.removeEventListener('bridge:socket-ready', onSocketReady);
      document.removeEventListener('bridge:socket-reconnected', onSocketReady);
      requestSeq += 1;
      clearTimeout(searchDebounce);
      unsubscribeRealtimeCounts();
      if (BridgeRegistry.get('showDiscoverPanel') === open) BridgeRegistry.unregister('showDiscoverPanel');
      if (BridgeRegistry.get('openDiscoverPanel') === open) BridgeRegistry.unregister('openDiscoverPanel');
      if (BridgeRegistry.get('hideDiscoverPanel') === close) BridgeRegistry.unregister('hideDiscoverPanel');
    };
  });
</script>

<!-- ── Template ──────────────────────────────────────────────────────────────── -->

{#if isVisible}
<div class="discover-root" role="dialog" aria-modal="true" aria-label={t('disc_open', 'Toplulukları Keşfet')} use:focusTrap>

  <button
    type="button"
    class="discover-close"
    aria-label={t('disc_close', 'Keşfet\'i kapat')}
    onclick={close}
  >✕</button>

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
      <button class="btn btn-secondary" onclick={() => void init()}>{t('retry')}</button>
    </div>

  {:else}
    <!-- Hero Banner -->
    <div class="discover-hero">
      <div class="discover-hero-bg"></div>
      <div class="discover-hero-content">
        <h1 class="discover-hero-title">{t('disc_title', '🌉 Toplulukları Keşfet')}</h1>
        <p class="discover-hero-sub">{t('discover_community_waiting_count', undefined, { count: allServers.length.toLocaleString() })}</p>
        <div class="discover-searchbar-wrap">
          <span class="discover-search-icon">🔍</span>
          <input
            type="text"
            class="discover-search-input"
            placeholder={t('attr_topluluk_ara_66d38cb', "Topluluk ara...")}
            value={query}
            oninput={onSearchInput}
          />
        </div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="discover-tabs">
      {#each ([['featured',t("surface_one_c_kan_06f876")],['trending',t('discover_tab_trending', '📈 Trend')],['new',t('discover_tab_new', '✨ Yeni')],['foryou',t("surface_sizin_icin_0ccd9c")]] as const).filter(([id]) => visibleTabs.includes(id)) as [id, label]}
        <button
          type="button"
          class="discover-tab-btn"
          class:active={tab === id}
          aria-pressed={tab === id}
          onclick={() => { tabChosenByUser = true; setTab(id as DiscoverTab); }}
        >{label}</button>
      {/each}
    </div>

    <!-- Category chips -->
    <div class="discover-categories">
      {#each DISCOVER_CATEGORIES as cat}
        <button
          type="button"
          class="cat-chip"
          class:active={category === cat.id}
          aria-pressed={category === cat.id}
          onclick={() => setCat(cat.id as DiscoverCategory)}
        >{cat.icon} {cat.label}</button>
      {/each}
    </div>

    <!-- Trending stats bar -->
    {#if tab === 'trending'}
      <div class="discover-stats-bar">
        <span><span class="online-dot">●</span> <strong>{totalOnline.toLocaleString()}</strong> {t('disc_online', 'çevrimiçi')}</span>
        <span>👥 <strong>{totalMembers.toLocaleString()}</strong> {t('disc_total_members', 'toplam üye')}</span>
        <span>🌐 <strong>{allServers.length.toLocaleString()}</strong> {t('ui_discover_community')}</span>
      </div>
    {/if}

    <!-- Featured section (tab = featured + featured listesi doluysa) -->
    {#if tab === 'featured' && featured.length > 0 && !query && !category}
      <section class="discover-featured-section">
        <h2 class="discover-section-title">{t('disc_featured', '⭐ Öne Çıkan Sunucular')}</h2>
        <div class="discover-featured-list">
          {#each featured as s (s._id)}
            {@const bannerAssetUrl = assetUrl(s.bannerUrl)}
            {@const iconAssetUrl = assetUrl(s.iconUrl)}
            <div class="featured-card">
              {#if bannerAssetUrl}
                <div class="featured-banner" style:background-image={`url("${bannerAssetUrl}")`}></div>
              {:else}
                <div class="featured-banner featured-banner--placeholder"></div>
              {/if}
              <div class="featured-card-body">
                {#if iconAssetUrl}
                  <img src={iconAssetUrl} class="featured-icon" alt="" loading="lazy" />
                {:else}
                  <div class="featured-icon featured-icon--letter">{s.name[0]}</div>
                {/if}
                <div class="featured-card-info">
                  <div class="featured-card-name">{s.name}</div>
                  <div class="featured-card-desc">{(s.description ?? '').slice(0, 80)}</div>
                  <div class="featured-card-meta">
                    <span class="discover-member-count">{t("ui_member_count", undefined, { count: (s.memberCount ?? 0).toLocaleString(localeTag()) })}</span>
                    <span class="discover-online-count" class:none={!s.onlineCount}>{t("ui_online_count", undefined, { count: s.onlineCount ?? 0 })}</span>
                  </div>
                </div>
                <button
                  class="btn btn-primary btn-sm"
                  disabled={joining.has(s._id)}
                  onclick={(e) => { e.stopPropagation(); void joinServer(s._id); }}
                >{t('disc_join', 'Katıl')}</button>
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
          <p>{t('disc_none_found', 'Topluluk bulunamadı')}</p>
          {#if query || category}
            <button class="btn btn-secondary btn-sm" onclick={() => { query = ''; category = ''; page = 0; }}>
              {t('markup_filtreleri_temizle_9cc74ff', "Filtreleri Temizle")}
            </button>
          {/if}
        </div>
      {:else}
        {#each pagedServers as s (s._id)}
          {@const bannerAssetUrl = assetUrl(s.bannerUrl)}
          {@const iconAssetUrl = assetUrl(s.iconUrl)}
          <!-- Server Card -->
          <div
            class="discover-card"
            role="button"
            tabindex="0"
            onclick={() => openServerPreview(s._id)}
            onkeydown={(e) => e.key === 'Enter' && openServerPreview(s._id)}
          >
            {#if bannerAssetUrl}
              <div class="discover-card-banner" style:background-image={`url("${bannerAssetUrl}")`}></div>
            {:else}
              <div class="discover-card-banner-accent"></div>
            {/if}

            <div class="discover-card-body">
              <div class="discover-card-header">
                {#if iconAssetUrl}
                  <img src={iconAssetUrl} class="discover-card-icon" alt="" loading="lazy" />
                {:else}
                  <div class="discover-card-icon discover-card-icon--letter">{s.name[0]}</div>
                {/if}
                <div class="discover-card-meta-wrap">
                  <div class="discover-card-name-row">
                    <span class="discover-card-name">{s.name}</span>
                    {#if s.verified}
                      <span class="badge badge-verified" title={t('disc_verified', 'Doğrulanmış')}>{t('markup_resmi_72755fa', "✓ Resmi")}</span>
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
                    <span class="online-count" class:none={!s.onlineCount}>{t("ui_online_count", undefined, { count: (s.onlineCount ?? 0).toLocaleString(localeTag()) })}</span>
                  </div>
                </div>
              </div>

              {#if s.description}
                <p class="discover-card-desc">{s.description}</p>
              {/if}

              {#if s.tags?.length}
                <div class="discover-card-tags">
                  {#each s.tags.slice(0, 3) as tag}
                    <span class="discover-tag">{tag}</span>
                  {/each}
                </div>
              {/if}

              <button
                class="btn btn-primary discover-join-btn"
                disabled={joining.has(s._id)}
                onclick={(e) => { e.stopPropagation(); void joinServer(s._id); }}
              >{t('disc_join_community', 'Topluluğa Katıl')}</button>
            </div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Pagination -->
    {#if pageCount > 1}
      <div class="discover-pagination">
        {#if page > 0}
          <button class="btn btn-secondary btn-sm" onclick={() => page -= 1}>{t('disc_prev', '‹ Önceki')}</button>
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
          <button class="btn btn-secondary btn-sm" onclick={() => page += 1}>{t('markup_sonraki_59807ab', "Sonraki ›")}</button>
        {/if}
      </div>
    {/if}
  {/if}

</div>
{/if}

<!-- ── Styles ─────────────────────────────────────────────────────────────────── -->

<style>
  /* Keşfet artık üst katman bir yüzeydir (rail'deki Keşfet düğmesiyle açılır).
     Daha önce sayfa içi bir blok olarak tasarlanmıştı ama hiç mount edilmiyordu. */
  .discover-root {
    position: fixed;
    inset: 0;
    z-index: var(--layer-modal);
    overflow-y: auto;
    max-width: none;
    min-height: var(--bridge-visual-viewport-height, 100dvh);
    margin: 0;
    padding: 24px 20px 48px;
    background: var(--bg-1, #0f1117);
  }

  .discover-root > :global(*) { max-width: 1100px; margin-inline: auto; }

  .discover-close {
    position: absolute;
    top: 16px;
    right: 20px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: 18px;
    cursor: pointer;
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 50%;
  }
  .discover-close:hover { color: var(--text-primary); background: var(--bg-4); }
  .discover-close:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  /* Hero */
  .discover-hero {
    background: linear-gradient(135deg, var(--brand), #1bc8a8);
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
    color: var(--text-on-solid);
    margin: 0 0 8px;
  }
  .discover-hero-sub {
    color: color-mix(in srgb, var(--text-on-solid) 80%, transparent);
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
    background: var(--text-on-solid);
    color: var(--bg-4);
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
    color: var(--text-on-solid);
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
  .online-dot { color: var(--success); font-size: 16px; }

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
    color: var(--text-on-solid);
    font-weight: 800;
    font-size: 18px;
  }
  .featured-card-info { flex: 1; min-width: 0; }
  .featured-card-name { font-weight: 700; font-size: 13px; }
  .featured-card-desc { font-size: 11px; color: var(--text-2); margin: 2px 0; }
  .featured-card-meta { display: flex; gap: 8px; font-size: 11px; color: var(--text-3); }
  .discover-online-count { color: var(--success); }

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
    /* Final21 UX: sabit açık gradyan (turuncu→turkuaz) + temaya göre dönen mürekkep, açık temada
       beyaz harfi ~1.9:1 bırakıyordu. Solid marka dolgusu + --text-on-solid her temada doğru eşleşmedir. */
    background: var(--brand);
    color: var(--text-on-solid);
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
  .online-count { color: var(--success); }
  /* Final21 UX: çeviri "●" ile başlıyor, işaretleme bir tane daha ekliyordu ("● ● 0 çevrimiçi"); sıfırda yeşil de yanıltıcıydı. */
  .online-count.none, .discover-online-count.none { color: var(--text-muted); }
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
  .badge-verified { background: var(--brand); color: var(--text-on-solid); }
  .badge-featured  { background: var(--accent); color: var(--text-on-solid); }
  .badge-boost     { background: var(--brand); color: var(--text-on-solid); }

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
    color: var(--text-on-solid) !important;
  }

  /* Skeleton */
  .discover-skeleton-hero {
    height: 160px;
    background: linear-gradient(135deg, var(--brand), #1bc8a8);
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

  @media (max-width: 700px) {
    .discover-root {
      height: var(--bridge-visual-viewport-height, 100dvh);
      min-height: 0;
      padding: max(14px, env(safe-area-inset-top)) 12px calc(28px + env(safe-area-inset-bottom));
      overscroll-behavior: contain;
    }
    .discover-close { position: sticky; top: 0; margin-left: auto; z-index: 2; width: 40px; height: 40px; }
    .discover-hero { padding: 24px 16px; margin-top: 4px; margin-bottom: 18px; border-radius: var(--radius-modal); }
    .discover-hero-title { font-size: 26px; }
    .discover-hero-sub { font-size: 14px; }
    .discover-search-input { min-height: 44px; }
    .discover-tabs { overflow-x: auto; scrollbar-width: none; }
    .discover-tabs::-webkit-scrollbar { display: none; }
    .discover-tab-btn { flex: none; min-height: 40px; white-space: nowrap; }
    .cat-chip { min-height: 36px; }
    .discover-featured-list { scroll-snap-type: x proximity; }
    .featured-card { min-width: min(78vw, 300px); scroll-snap-align: start; }
    .discover-stats-bar { gap: 8px 12px; }
  }

  @media (max-width: 420px) {
    .discover-hero-title { font-size: 23px; }
    .discover-hero { padding-inline: 14px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .discover-tab-btn, .cat-chip { transition: none; }
  }
</style>
