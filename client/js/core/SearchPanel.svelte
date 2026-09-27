<!-- client/js/core/SearchPanel.svelte -->
<!-- Sprint 115 — search.ts (555 satır) → Svelte 5 Runes (ADR-0008 Faz 2) -->
<script lang="ts">
  import { t, localeTag} from './i18n/reactive.svelte.ts';
  import { messageText } from './messages/message-format.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { createLogger } from './logger.js';

  const log = createLogger('SearchPanel');

  // ── State ──────────────────────────────────────────────────────────────────
  let query       = $state('');
  let results     = $state<SearchResult[]>([]);
  let isLoading   = $state(false);
  let isVisible   = $state(false);
  // FAZ F — 'files' sekmesi KALDIRILDI: sunucunun arama ucunda dosya dali
  // YOKTUR (yalniz messages/channels/users). Sekmeyi birakmak, kullaniciya
  // her zaman BOS donen bir yuzey gostermek olurdu; uydurma bir sozlesme
  // eklemek ise yasak. Dosya aramasi = ABSENT.
  let activeTab   = $state<'messages' | 'members' | 'channels'>('messages');
  let page        = $state(1);
  let hasMore     = $state(false);
  let serverId    = $state<string | null>(null);
  let error       = $state<string | null>(null);

  /** Sunucunun GERCEK yanit govdesi (server/routes/search.ts:333). */
  interface SearchResponse {
    messages?: Array<{ _id: unknown; content?: string; channelId?: string;
                       channelName?: string | null; username?: string;
                       displayName?: string; createdAt?: number }>;
    channels?: Array<{ _id: unknown; name?: string }>;
    members?:  Array<{ _id: unknown; username?: string; displayName?: string }>;
    hasMore?:  boolean;
  }

  interface SearchResult {
    _id: string;
    type: 'message' | 'member' | 'channel';
    content?: string;
    username?: string;
    channelName?: string;
    authorUsername?: string;
    channelId?: string;
    createdAt?: number;
    score?: number;
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  let trimmedQuery  = $derived(query.trim());
  let hasResults    = $derived(results.length > 0);
  let totalLabel    = $derived(results.length > 0
    ? t('search_result_count', '{count} sonuç', { count: `${results.length}${hasMore ? '+' : ''}` })
    : '');

  // ── Debounce ───────────────────────────────────────────────────────────────
  let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const q = trimmedQuery;
    if (_debounceTimer) clearTimeout(_debounceTimer);
    if (q.length < 2) { results = []; error = null; return; }
    _debounceTimer = setTimeout(() => {
      // Do not retain an expired timer handle: later effect cleanup must only
      // cancel work that is still pending.
      _debounceTimer = null;
      void runSearch(q);
    }, 250);
    return () => { if (_debounceTimer) clearTimeout(_debounceTimer); };
  });

  // ── API ────────────────────────────────────────────────────────────────────
  //
  // FAZ F — İSTEMCİ GERÇEK SUNUCU SÖZLEŞMESİNE HİZALANDI.
  //
  // Bu panel uykudayken üç ayrı uyumsuzluk birikmişti; hiçbiri fark edilmemişti
  // çünkü kod HİÇ çalışmıyordu (SearchPanel hiçbir giriş noktasının import
  // kapanışında değildi). Uyandırmadan önce üçü de düzeltildi:
  //
  //   1. YOL      : `/api/servers/:id/search` ÇAĞRILIYORDU — böyle bir rota YOK.
  //                 `server/routes/search.ts` yalnız `router.get('/')` tanımlar
  //                 ve `/api/search` altına monte edilir. Eski yol 404 dönerdi.
  //   2. SAYFALAMA: `page` gönderiliyordu; sunucu `offset` okur.
  //   3. GÖVDE    : `{ results }` bekleniyordu; sunucu `{ messages, channels,
  //                 members, hasMore }` döndürür.
  //
  // AYRICA sunucu üye dalını `type === 'users'` ile anahtarlar ('members' DEĞİL).
  //
  // Sunucu SÖZLEŞMESİ DEĞİŞTİRİLMEDİ: Faz D'de eklenen VIEW_CHANNELS kapsama
  // denetimi (`viewableChannelIds`) tam olarak bu uçta yaşıyor. İstemciyi
  // uydurmak yerine sunucuyu değiştirmek o sertleştirmeyi riske atardı.
  const PAGE_SIZE = 20;

  /** İstemci sekmesi → sunucu `type` parametresi. */
  function serverType(tab: typeof activeTab): string {
    return tab === 'members' ? 'users' : tab;
  }

  /** Sunucunun ayrı dizilerini panelin düz listesine indirger. */
  function toResults(data: SearchResponse, tab: typeof activeTab): SearchResult[] {
    if (tab === 'channels') {
      return (data.channels ?? []).map(c => ({
        _id: String(c._id), type: 'channel' as const, channelName: c.name ?? '',
      }));
    }
    if (tab === 'members') {
      return (data.members ?? []).map(u => ({
        _id: String(u._id), type: 'member' as const,
        username: u.displayName ?? u.username ?? '',
      }));
    }
    return (data.messages ?? []).map(m => ({
      _id: String(m._id), type: 'message' as const,
      content: m.content ?? '',
      // `||`: hesabı silinen kişinin mesajında ad BOŞ dizgedir (Final21 Faz 19) — `??` onu
      // geçirip boş bir "@" çiziyordu.
      authorUsername: m.displayName || m.username || '',
      channelName: m.channelName ?? '',
      channelId: m.channelId,
      createdAt: m.createdAt,
    }));
  }

  async function runSearch(q: string, p = 1) {
    if (!serverId) return;
    isLoading = true; error = null;
    try {
      const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_kayitli_degil", "apiFetch kayıtlı değil"));
      const params = new URLSearchParams({
        q,
        serverId,
        type:   serverType(activeTab),
        limit:  String(PAGE_SIZE),
        offset: String((p - 1) * PAGE_SIZE),
      });
      const res = await apiFetch(`/api/search?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as SearchResponse;
      const mapped = toResults(data, activeTab);
      results = p === 1 ? mapped : [...results, ...mapped];
      // `hasMore` yalnız mesaj dalı için anlamlıdır (sunucu kanal/üyeyi
      // sabit üst sınırla döndürür), bu yüzden diğer sekmelerde zorlanmaz.
      hasMore = activeTab === 'messages' ? Boolean(data.hasMore) : false;
      page = p;
    } catch (err) {
      log.error('Search failed', err);
      error = t("ui_arama_sirasinda_hata_olustu_lutfen_tekrar_deneyin", "Arama sırasında hata oluştu. Lütfen tekrar deneyin.");
      results = [];
      hasMore = false;
    } finally {
      isLoading = false;
    }
  }

  function loadMore() { if (hasMore && !isLoading) runSearch(trimmedQuery, page + 1); }

  function clear() {
    query = ''; results = []; error = null; page = 1; hasMore = false;
  }

  function navigateToResult(result: SearchResult) {
    if (result.channelId) {
      BridgeRegistry.call('navigateToChannel', result.channelId, result._id);
    }
    close();
  }

  function open(sid: string) {
    closeExclusivePeers('server-search');
    serverId = sid;
    isVisible = true;
    // focus will be handled by $effect after render
  }
  function close(_restoreFocus: boolean | Event = true) { isVisible = false; clear(); }

  // FAZ F — Escape yalniz panel GORUNURKEN is gorur.
  // Dinleyici `svelte:window` uzerindedir ve panel gizliyken de baglidir;
  // kosulsuz `close()` cagirmak, her Escape'te gereksiz durum sifirlamasi
  // yapar ve baska yuzeylerin tusuyla yarisir. DmPanel/FriendsPanel/GDM ile
  // ayni sozlesme.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || !isVisible) return;
    close();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  /**
   * FAZ F — KABUK ADAPTORU (IKINCI SAHIP DEGIL).
   *
   * `index.html`'deki tek dispatcher eylemleri
   * `BridgeRegistry.call(action, el, ...arg)` seklinde cagirir: ILK argüman
   * her zaman TIKLANAN ELEMANDIR. Yani `openSearch(sid)` kabuk dugmesine
   * dogrudan baglanamaz — `sid` yerine bir HTMLElement alirdi.
   *
   * Bu adaptor aktif sunucuyu kanonik kaynaktan (`AppState`) kendisi cozer ve
   * AYNI `open()`u cagirir. Ayri bir durum sahibi olusmaz: tek state, tek
   * panel, iki giris sozlesmesi (Komut Paleti sid ile, kabuk sid'siz).
   */
  /**
   * FAZ K/1 — OLU DUGME DUZELTILDI.
   *
   * Kabuktaki arama dugmesi sunucu SECILI DEGILKEN sessizce hicbir sey
   * yapmiyordu (`if (!server?._id) return`): DM'deyken ya da acilistan hemen
   * sonra gorunur bir dugmeye basmak HICBIR tepki uretmiyordu — kullanici
   * icin bu, bozuk bir uygulama demektir.
   *
   * Artik sunucu yoksa KURESEL aramaya dusulur; o yuzey sunucu uyeligi
   * gerektirmez (DM ve grup DM kullanici bazlidir). Sunucu varsa davranis
   * DEGISMEZ: sunucu ici arama panelinin uye/kanal sekmeleri kuresel aramada
   * yoktur, dolayisiyla biri digerinin yerine gecmez.
   */
  function openSearchFromShell(): void {
    const server = BridgeRegistry.call<{ _id?: string } | null>('currentServer');
    if (server?._id) { open(server._id); return; }
    if (BridgeRegistry.has('openGlobalSearch')) BridgeRegistry.call('openGlobalSearch');
  }

  onMount(() => {
    BridgeRegistry.register('openSearch',  open);
    BridgeRegistry.register('closeSearch', close);
    BridgeRegistry.register('openSearchFromShell', openSearchFromShell);
  });
  onDestroy(() => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
    // FAZ F — kayitlar BIRAKILIR. Birakilmazsa sokulmus bir bilesenin
    // `open`'i kayitli kalir; Komut Paleti `has('openSearch')` gorup komutu
    // GOSTERIR ama cagri olu bilesene gider.
    BridgeRegistry.unregister?.('openSearch');
    BridgeRegistry.unregister?.('closeSearch');
    BridgeRegistry.unregister?.('openSearchFromShell');
  });

  function formatDate(ts?: number) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short' });
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if isVisible}
<div class="search-overlay" role="dialog" aria-label={t('attr_sunucu_arama_326e776', "Sunucu Arama")} aria-modal="true"
     use:focusTrap={{ initialFocus: ".search-input" }}>
  <div class="search-panel">

    <div class="search-header">
      <div class="search-input-wrap">
        <span class="search-icon" aria-hidden="true">🔍</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="search-input"
          type="search"
          bind:value={query}
          placeholder={t('sp_placeholder', 'Mesaj, üye veya kanal ara…')}
          aria-label={t("ui_search_query_aria")}
          autocomplete="off"
          autofocus
        />
        {#if query}
          <button class="search-clear" onclick={clear} aria-label={t('ptt_key_clear')}>✕</button>
        {/if}
      </div>
      <button class="search-close" onclick={close} aria-label={t('close')}>✕</button>
    </div>

    <!-- Tab bar -->
    <div class="search-tabs" role="tablist">
      {#each ['messages', 'members', 'channels'] as tab}
        <button
          class="search-tab {activeTab === tab ? 'active' : ''}"
          role="tab"
          aria-selected={activeTab === tab}
          onclick={() => { activeTab = tab as typeof activeTab; if (trimmedQuery.length >= 2) runSearch(trimmedQuery); }}
        >
          { tab === 'messages' ? t('search_tab_messages', '💬 Mesajlar')
          : tab === 'members'  ? t("surface_uyeler_d3beea")
          : t('search_tab_channels', '# Kanallar') }
        </button>
      {/each}
    </div>

    <!-- Results -->
    <div class="search-results" role="listbox">
      {#if isLoading && results.length === 0}
        <div class="search-skeleton" aria-live="polite" aria-label={t('sp_loading', 'Yükleniyor')}>
          {#each Array(5) as _}
            <div class="search-skeleton-item"></div>
          {/each}
        </div>
      {:else if error}
        <div class="search-error" role="alert">{error}</div>
      {:else if hasResults}
        <div class="search-count" aria-live="polite">{totalLabel}</div>
        {#each results as result (result._id)}
          <button
            class="search-result-item"
            role="option"
            aria-selected="false"
            onclick={() => navigateToResult(result)}
          >
            {#if result.type === 'message'}
              <div class="result-meta">
                <span class="result-author">{result.authorUsername ? `@${result.authorUsername}` : t('unknown_user')}</span>
                <span class="result-channel">#{result.channelName}</span>
                <span class="result-date">{formatDate(result.createdAt)}</span>
              </div>
              <div class="result-content">{messageText(result)}</div>
            {:else if result.type === 'member'}
              <span class="result-avatar">👤</span>
              <span class="result-name">@{result.username}</span>
            {:else if result.type === 'channel'}
              <span class="result-channel-icon">#</span>
              <span class="result-name">{result.channelName}</span>
            {/if}
          </button>
        {/each}
        {#if hasMore}
          <button class="search-load-more" onclick={loadMore} disabled={isLoading}>
            {isLoading ? t("loading") : t("surface_daha_fazla_yukle_776858")}
          </button>
        {/if}
      {:else if trimmedQuery.length >= 2 && !isLoading}
        <div class="search-empty" aria-live="polite">
          <p>{t("ui_search_no_results", undefined, { query: trimmedQuery })}</p>
          <small>{t('sp_try_other', 'Farklı anahtar kelimeler veya sekme deneyebilirsiniz.')}</small>
        </div>
      {:else if trimmedQuery.length < 2}
        <div class="search-hint">{t('markup_en_az_2_karakter_girin_91e9f5c', "En az 2 karakter girin.")}</div>
      {/if}
    </div>

  </div>
</div>
{/if}

<style>
.search-overlay {
  position: fixed; inset: 0;
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  display: flex; justify-content: center; padding: 80px 16px 24px;
  /* Arama ortusu bir modaldir. */
  z-index: var(--layer-modal);
  backdrop-filter: blur(3px);
}
.search-panel {
  background: var(--bridge-surface, #1e2124);
  border-radius: var(--radius-modal);
  width: 100%; max-width: 660px;
  max-height: min(680px, calc(var(--bridge-visual-viewport-height, 100dvh) - 104px));
  display: flex; flex-direction: column;
  box-shadow: var(--shadow-xl);
  overflow: hidden;
}
.search-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--bridge-border, #232636);
}
.search-input-wrap {
  flex: 1; display: flex; align-items: center; gap: 8px;
  background: var(--bridge-surface2, #232636);
  border-radius: 8px; padding: 6px 12px;
}
.search-input {
  flex: 1; background: none; border: none; outline: none;
  color: var(--bridge-text, #fff); font-size: 1rem;
}
.search-clear, .search-close, .search-icon {
  background: none; border: none; cursor: pointer; color: var(--bridge-muted, #8a91ad);
  font-size: .9rem;
}
.search-tabs {
  display: flex; overflow-x: auto;
  border-bottom: 1px solid var(--bridge-border, #232636);
}
.search-tab {
  padding: 10px 16px; background: none; border: none; cursor: pointer;
  color: var(--bridge-muted, #8a91ad); font-size: .85rem; white-space: nowrap;
  border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
}
.search-tab.active {
  color: var(--bridge-blue, #2d9cdb);
  border-bottom-color: var(--bridge-blue, #2d9cdb);
}
.search-results { flex: 1; overflow-y: auto; padding: 8px; }
.search-skeleton-item {
  height: 52px; background: var(--bridge-surface2, #232636);
  border-radius: 8px; margin-bottom: 4px; animation: pulse 1.2s infinite;
}
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
.search-result-item {
  width: 100%; text-align: left; background: none; border: none; cursor: pointer;
  padding: 10px 12px; border-radius: 8px; color: var(--bridge-text, #fff);
  display: flex; flex-direction: column; gap: 2px;
  transition: background .1s;
}
.search-result-item:hover { background: var(--bridge-surface2, #232636); }
.result-meta { display: flex; gap: 8px; font-size: .75rem; color: var(--bridge-muted, #8a91ad); }
.result-content { font-size: .9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-name { font-size: .9rem; font-weight: 500; }
.search-count { font-size: .75rem; color: var(--bridge-muted, #8a91ad); padding: 4px 12px 8px; }
.search-load-more {
  width: 100%; padding: 10px; background: var(--bridge-surface2, #232636);
  border: none; border-radius: 8px; color: var(--bridge-blue, #2d9cdb);
  cursor: pointer; font-size: .875rem; margin-top: 4px;
}
.search-load-more:disabled { opacity: .5; cursor: default; }
.search-empty, .search-hint {
  padding: 32px 16px; text-align: center; color: var(--bridge-muted, #8a91ad); font-size: .9rem;
}
.search-error { padding: 16px; color: var(--bridge-danger, #e05260); text-align: center; }

@media (max-width: 600px) {
  .search-overlay { padding: 0; align-items: stretch; background: var(--bridge-surface, var(--bg-2)); backdrop-filter: none; }
  .search-panel { width: 100%; max-width: none; max-height: none; height: var(--bridge-visual-viewport-height, 100dvh); border-radius: 0; box-shadow: none; }
  .search-header { padding: max(10px, env(safe-area-inset-top)) 12px 8px; min-height: 56px; }
  .search-close, .search-clear { min-width: 40px; min-height: 40px; }
  .search-tabs { scrollbar-width: none; }
  .search-tabs::-webkit-scrollbar { display: none; }
  .search-tab { min-height: 44px; padding-inline: 14px; }
  .search-results { padding-bottom: calc(8px + env(safe-area-inset-bottom)); }
  .result-meta { min-width: 0; flex-wrap: wrap; }
  .result-content { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
}
@media (prefers-reduced-motion: reduce) { .search-skeleton-item { animation: none; } .search-tab,.search-result-item { transition: none; } }
</style>
