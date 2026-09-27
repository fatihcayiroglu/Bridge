<!-- client/js/core/GlobalSearchPanel.svelte -->
<!--
  FAZ K/1 — KURESEL ARAMA.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERCEK BOSLUK
  ════════════════════════════════════════════════════════════════════════════
  `GET /api/search/unified` sunucuda calisiyordu ama istemcide TEK BIR
  CAGIRAN yoktu. Mevcut `SearchPanel` yalnizca ACIK SUNUCU icindeki kanal
  mesajlarini arar (`serverId` zorunlu); DM, grup DM ve thread yanitlari
  kullanici icin ARANAMAZ durumdaydi.

  ── KISAYOL CAKISMASI (bilinerek boyle) ────────────────────────────────────
  Ctrl/Cmd+K bu uygulamada ZATEN komut paletini acar (CommandPalettePanel) ve
  Discord'un "hizli gecis" davranisiyla ayni anlama gelir: sunucu/kanal/kisi
  arasinda ATLAMA. Onu devralmak calisan bir yuzeyi bozardi. Bu yuzden:
      Ctrl/Cmd+F        → kuresel arama (Discord'da da arama kisayolu)
      Ctrl/Cmd+Shift+K  → kuresel arama (palet refleksi olanlar icin)
      Ctrl/Cmd+K        → komut paleti (DEGISMEDI)
  Palet, sorgusuna karsilik komut bulamadiginda buraya devreder.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { messageText } from './messages/message-format.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { createLogger } from './logger.js';
  import {
    fetchUnifiedSearch, groupHits, flattenGroups, highlightSegments, snippetAround,
    MIN_QUERY_LENGTH, HAS_OPTIONS, parseFilterSyntax, hasActiveFilters,
    fetchSearchContext,
    type SearchHit, type HitGroup, type ApiFetch, type SearchFilters,
    type ContextMessage,
  } from './search/unified-search-client.ts';
  import {
    loadRecent, saveRecent, addRecent, removeRecent, clearRecent,
  } from './search/recent-searches.ts';
  import { loadSaved, saveSaved, addSaved, removeSaved } from './search/saved-searches.ts';
  import { navigateToHit, FAILURE_MESSAGE } from './search/search-navigation.ts';

  const log = createLogger('GlobalSearch');

  // ── Durum ────────────────────────────────────────────────────────────────
  let isVisible  = $state(false);
  let query      = $state('');
  let hits       = $state<SearchHit[]>([]);
  let hasMore    = $state(false);
  let isLoading  = $state(false);
  let isLoadingMore = $state(false);
  let error      = $state<string | null>(null);
  let selectedIdx = $state(0);
  let recent     = $state<string[]>([]);
  let saved      = $state<string[]>([]);
  let savedUserId = $state('anonymous');
  let statusText = $state('');
  /** Kullanici tarafindan degistirilebilen `from:` / `in:` / `has:` / tarih filtreleri. */
  let filters    = $state<SearchFilters>({});
  /**
   * Kanal-basligi aramasi icin kilitli yapisal kapsam.
   *
   * Bu, kullanicinin yazdigi `in:` filtresinden AYRIDIR: kanal adi benzersiz
   * degildir ve "bu kanalda ara" yuzeyi baska kanala sessizce kacmamalidir.
   */
  let lockedChannelId = $state('');
  let lockedChannelName = $state('');

  let inputEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLElement | undefined = $state();
  let returnFocusEl: HTMLElement | null = null;

  /** Ayni anda yalnizca EN SON sorgunun sonucu kabul edilir. */
  let requestSeq = 0;
  let inFlight: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── BAGLAM ONIZLEMESI ────────────────────────────────────────────────────
  // Tek satirlik isabet cogu zaman yetmez: "tamam" yazan bir mesaj neyin
  // tamam oldugunu soylemez. Secili sonucun cevresindeki konusma gosterilir.
  //
  // NEDEN AYRI BIR DUGME YOK: sonuclar `role="option"` ogeleridir. Icine
  // buton koymak `nested-interactive` (axe: serious) uretirdi — ayni kusur
  // kanal listesinde olculup duzeltilmisti. Onizleme bu yuzden SECILI
  // sonuca gore kendiliginden yuklenir; ek etkilesim ogesi YOKTUR.
  //
  // ISTEK SAYISI: sonuc basina EN FAZLA BIR istek. Onbellek kalicidir
  // (panel kapanana kadar), gezinme geri donunce yeniden istek ATILMAZ.
  let contextCache = $state<Record<string, ContextMessage[]>>({});
  let contextLoading = $state<string | null>(null);
  let contextSeq = 0;
  let contextInFlight: AbortController | null = null;
  let contextTimer: ReturnType<typeof setTimeout> | null = null;

  const hitKey = (hit: SearchHit) => `${hit.source}:${hit.id}`;
  // Channel messages are stored HTML-sanitized; DM and thread messages are raw (Final21 Phase 15).
  const hitText = (hit: SearchHit): string => (hit.source === 'channel' ? messageText(hit) : String(hit.content ?? ''));

  // ── Turetilenler ─────────────────────────────────────────────────────────
  // Sohbet sozdizimi (`from:ayse merhaba`) ayiklanir: kalan metin arama
  // terimidir, ayiklananlar filtre olur. Boylece kullanici hem yazarak hem
  // kontrolle ayni seyi yapabilir.
  let parsed  = $derived(parseFilterSyntax(query));
  let trimmed = $derived(parsed.text.trim());

  function effectiveFilters(): SearchFilters {
    const merged: SearchFilters = { ...filters, ...parsed.filters };
    if (lockedChannelId) {
      // Yapısal kanal kapsamı kullanıcı metnindeki `in:` filtresinden daha
      // güçlüdür. Kanal başlığından açılan arama hiçbir zaman başka kanala
      // dönüşmez.
      delete merged.in;
      merged.channelId = lockedChannelId;
    }
    return merged;
  }

  let activeFilters = $derived<SearchFilters>(effectiveFilters());
  let editableFiltersOn = $derived(hasActiveFilters({ ...filters, ...parsed.filters }));
  let groups  = $derived<HitGroup[]>(groupHits(hits));
  let flat    = $derived<SearchHit[]>(flattenGroups(groups));
  let showDiscovery = $derived(trimmed.length < MIN_QUERY_LENGTH && (saved.length > 0 || recent.length > 0));
  let selected = $derived<SearchHit | null>(flat[selectedIdx] ?? null);

  // ── Arama ────────────────────────────────────────────────────────────────
  function apiFetch(): ApiFetch | null {
    return BridgeRegistry.get<ApiFetch>('apiFetch') ?? null;
  }

  async function runSearch(q: string, append = false): Promise<void> {
    if (append && (!hasMore || isLoading || isLoadingMore)) return;
    const seq = ++requestSeq;
    inFlight?.abort();
    const controller = new AbortController();
    inFlight = controller;

    const fetcher = apiFetch();
    if (!fetcher) {
      // Sessizce bos donmek "sonuc yok" gibi gorunurdu; bu bir ARIZA.
      error = t("ui_arama_su_anda_kullanilamiyor", "Arama şu anda kullanılamıyor.");
      isLoading = false;
      isLoadingMore = false;
      return;
    }

    if (append) isLoadingMore = true;
    else isLoading = true;
    error = null;
    try {
      const res = await fetchUnifiedSearch(fetcher, q, {
        limit: 40,
        offset: append ? hits.length : 0,
        signal: controller.signal,
        filters: activeFilters,
      });
      if (seq !== requestSeq) return;          // eskimis yanit — yoksayilir
      if (append) {
        const seen = new Set(hits.map(hitKey));
        hits = [...hits, ...res.hits.filter(hit => !seen.has(hitKey(hit)))];
      } else {
        hits = res.hits;
        selectedIdx = 0;
      }
      hasMore = res.hasMore;
      statusText = hits.length
        ? hasMore ? t('search_results_more', '{count} sonuç gösteriliyor, daha fazlası var', { count: hits.length }) : t('search_result_count', '{count} sonuç', { count: hits.length })
        : t("bmp_no_results", "Sonuç bulunamadı");
    } catch (err) {
      if (controller.signal.aborted || seq !== requestSeq) return;
      log.error('Kuresel arama basarisiz', err);
      if (!append) hits = [];
      const status = (err as { status?: number }).status;
      error = status === 503
        ? t("ui_arama_servisi_su_anda_kullanilamiyor", "Arama servisi şu anda kullanılamıyor.")
        : append ? t("ui_daha_fazla_sonuc_yuklenemedi", "Daha fazla sonuç yüklenemedi.") : t("ui_arama_sirasinda_bir_hata_olustu", "Arama sırasında bir hata oluştu.");
      statusText = error;
    } finally {
      if (seq === requestSeq) {
        isLoading = false;
        isLoadingMore = false;
      }
    }
  }

  /**
   * Secili sonucun cevresindeki konusmayi yukler.
   *
   * HATA SESSIZ: onizleme bir KOLAYLIKTIR. Gelmezse sonuc listesi aynen
   * calisir; kullaniciya hata gosterip aramayi gurultulu hale getirmeyiz.
   * Yetkisiz/bulunamayan durum zaten `null` doner (sunucu varligi
   * sizdirmamak icin ikisini ayirmaz) — bu bir HATA DEGILDIR.
   */
  async function loadContext(hit: SearchHit): Promise<void> {
    const key = hitKey(hit);
    if (contextCache[key]) return;             // onbellekte — istek YOK

    const fetcher = apiFetch();
    if (!fetcher) return;

    const seq = ++contextSeq;
    contextInFlight?.abort();
    const controller = new AbortController();
    contextInFlight = controller;
    contextLoading = key;

    try {
      const res = await fetchSearchContext(fetcher, hit.id, hit.source, {
        radius: 2, signal: controller.signal,
      });
      if (seq !== contextSeq) return;          // eskimis yanit
      // `null` = baglam yok VEYA yetkisiz. Bos dizi onbellege yazilir ki
      // ayni sonuc icin tekrar istek atilmasin.
      contextCache = { ...contextCache, [key]: res?.messages ?? [] };
    } catch (err) {
      if (controller.signal.aborted || seq !== contextSeq) return;
      log.warn('Baglam onizlemesi yuklenemedi', err);
      contextCache = { ...contextCache, [key]: [] };
    } finally {
      if (seq === contextSeq) contextLoading = null;
    }
  }

  // Secim degisince onizleme yuklenir. Gecikme, klavyeyle hizlica gezinen
  // kullanicinin her satir icin istek uretmesini onler.
  $effect(() => {
    const hit = selected;
    if (contextTimer) clearTimeout(contextTimer);
    if (!isVisible || !hit) return;
    if (contextCache[hitKey(hit)]) return;

    contextTimer = setTimeout(() => void loadContext(hit), 220);
    return () => { if (contextTimer) clearTimeout(contextTimer); };
  });

  $effect(() => {
    const q = trimmed;
    filters;                                   // filtre degisimi de aramayi tazeler
    lockedChannelId;                           // yapisal kapsam degisimi de
    if (debounceTimer) clearTimeout(debounceTimer);
    if (!isVisible) return;

    if (q.length < MIN_QUERY_LENGTH) {
      inFlight?.abort();
      requestSeq++;                            // ucus halindeki yaniti gecersiz kil
      hits = [];
      hasMore = false;
      error = null;
      isLoading = false;
      isLoadingMore = false;
      statusText = '';
      return;
    }
    // Anlik his: kisa gecikme yalnizca her tus vurusunda istek atmayi onler.
    debounceTimer = setTimeout(() => void runSearch(q), 180);
    return () => { if (debounceTimer) clearTimeout(debounceTimer); };
  });

  // ── Acilis / kapanis ─────────────────────────────────────────────────────
  // Kullanici filtreleri ile urun ici KILITLI kapsam birbirinden ayridir.
  // `openChannelSearch` kanal kimligini kilitler; "Temizle" bu kapsami kaldirmaz.
  function open(
    initialQuery = '',
    scope: { channelId?: string; channelName?: string } = {},
  ): void {
    closeExclusivePeers('search');
    returnFocusEl = (document.activeElement as HTMLElement | null) ?? null;
    recent = loadRecent();
    const me = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe');
    savedUserId = String(me?._id ?? me?.id ?? 'anonymous').slice(0, 128);
    saved = loadSaved(savedUserId);
    query = initialQuery;
    filters = {};
    lockedChannelId = scope.channelId?.trim() ?? '';
    lockedChannelName = scope.channelName?.trim() ?? '';
    selectedIdx = 0;
    error = null;
    isVisible = true;
    queueMicrotask(() => inputEl?.focus());
  }

  function close(restoreFocus: boolean | Event = true): void {
    if (!isVisible) return;
    const shouldRestoreFocus = typeof restoreFocus === 'boolean' ? restoreFocus : true;
    isVisible = false;
    inFlight?.abort();
    requestSeq++;
    hits = [];
    query = '';
    filters = {};
    lockedChannelId = '';
    lockedChannelName = '';
    statusText = '';
    isLoadingMore = false;
    // Odak, aramayi acan kontrole geri verilir — klavye kullanicisi
    // belgenin basina firlatilmamalidir.
    const target = returnFocusEl;
    returnFocusEl = null;
    if (shouldRestoreFocus && target?.isConnected) target.focus();
  }

  // ── Sonuca gitme ─────────────────────────────────────────────────────────
  async function activate(hit: SearchHit): Promise<void> {
    const q = trimmed;
    const result = await navigateToHit(hit, {
      registry: {
        has: (key: string) => BridgeRegistry.has(key),
        call: <T,>(key: string, ...args: unknown[]) => BridgeRegistry.call<T>(key, ...args),
      },
      apiFetch: apiFetch() ?? undefined,
    });

    if (result.status === 'error') {
      // Olu baglanti YASAK: gidilemiyorsa kullanici bunu OGRENIR.
      error = FAILURE_MESSAGE[result.reason];
      statusText = error;
      log.warn('Sonuca gidilemedi', { source: hit.source, reason: result.reason });
      return;
    }

    if (q) {
      recent = addRecent(recent, q);
      saveRecent(recent);
    }
    close();
  }

  function setFilter(key: keyof SearchFilters, value: string): void {
    // Ayni degere tekrar basmak filtreyi KALDIRIR (acma/kapama).
    filters = filters[key] === value
      ? Object.fromEntries(Object.entries(filters).filter(([k]) => k !== key))
      : { ...filters, [key]: value };
    selectedIdx = 0;
  }

  function clearFilters(): void {
    filters = {};
    // Sohbet sozdizimiyle yazilmis filtreler metnin icindedir; onlar da
    // temizlenmeli, yoksa "temizle" yarim is yapmis olur.
    query = parsed.text;
  }

  function useRecent(value: string): void {
    query = value;
    queueMicrotask(() => inputEl?.focus());
  }

  function dropRecent(value: string): void {
    recent = removeRecent(recent, value);
    saveRecent(recent);
  }

  function clearAllRecent(): void {
    recent = [];
    clearRecent();
  }

  function canonicalSavedQuery(): string {
    if (lockedChannelId) return ''; // stable channel scope is structural, never persisted as a display-name shortcut
    const merged: SearchFilters = { ...filters, ...parsed.filters };
    const parts = [parsed.text.trim()];
    for (const key of ['from', 'in', 'has', 'after', 'before'] as const) {
      const value = merged[key]?.trim();
      if (value) parts.push(`${key}:${value}`);
    }
    return parts.filter(Boolean).join(' ').trim();
  }

  function saveCurrentSearch(): void {
    const value = canonicalSavedQuery();
    if (value.length < MIN_QUERY_LENGTH) return;
    saved = addSaved(saved, value);
    saveSaved(savedUserId, saved);
    statusText = 'Arama kaydedildi';
  }

  function useSaved(value: string): void {
    filters = {};
    query = value;
    queueMicrotask(() => inputEl?.focus());
  }

  function dropSaved(value: string): void {
    saved = removeSaved(saved, value);
    saveSaved(savedUserId, saved);
  }

  // ── Klavye ───────────────────────────────────────────────────────────────
  function moveSelection(delta: number): void {
    if (!flat.length) return;
    const next = selectedIdx + delta;
    // Uclarda sarma YOK: listenin sonunda ok tusuna basmak kullaniciyi
    // beklenmedik sekilde basa firlatmasin.
    selectedIdx = Math.max(0, Math.min(flat.length - 1, next));
    scrollSelectionIntoView();
  }

  function scrollSelectionIntoView(): void {
    queueMicrotask(() => {
      const node = listEl?.querySelector<HTMLElement>('[aria-selected="true"]');
      // `scrollIntoView` her ortamda YOKTUR (jsdom, bazi gomulu webview'ler).
      // Mikro gorevin icinde firlayan hata YAKALANAMAZ ve yakalanmamis
      // reddedilme olarak disari cikar; gorunmez bir kaydirma kolayligi icin
      // klavye gezinmesini riske atmak gerekmez.
      if (typeof node?.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' });
    });
  }

  function onPanelKeyDown(e: KeyboardEvent): void {
    switch (e.key) {
      case 'Escape':   e.preventDefault(); close(); break;
      case 'ArrowDown': e.preventDefault(); moveSelection(1); break;
      case 'ArrowUp':   e.preventDefault(); moveSelection(-1); break;
      case 'Home':      if (flat.length) { e.preventDefault(); selectedIdx = 0; scrollSelectionIntoView(); } break;
      case 'End':       if (flat.length) { e.preventDefault(); selectedIdx = flat.length - 1; scrollSelectionIntoView(); } break;
      case 'Enter':
        e.preventDefault();
        if (selected) void activate(selected);
        else if (showDiscovery && saved[0]) useSaved(saved[0]);
        else if (showDiscovery && recent[0]) useRecent(recent[0]);
        break;
    }
  }

  function onGlobalKeyDown(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;

    // Ctrl/Cmd+F — tarayicinin sayfa ici aramasi yerine urun aramasi.
    // Ctrl/Cmd+Shift+K — palet refleksi olan kullanicilar icin ikinci yol.
    const isSearchKey = (e.key === 'f' || e.key === 'F') && !e.shiftKey;
    const isAltKey    = (e.key === 'k' || e.key === 'K') && e.shiftKey;
    if (!isSearchKey && !isAltKey) return;

    e.preventDefault();
    isVisible ? close() : open();
  }

  // ── Sunum yardimcilari ───────────────────────────────────────────────────
  function contextLabel(hit: SearchHit): string {
    if (hit.source === 'channel') return hit.channelName ? `#${hit.channelName}` : t("ui_kanal", "Kanal");
    if (hit.source === 'thread')  return hit.channelName ? `#${hit.channelName} · ${t('search_thread_label_lower', 'konu')}` : t('search_thread_label', 'Konu');
    if (hit.source === 'dm')      return t("ui_direkt_mesaj", "Direkt mesaj");
    return 'Grup mesaji';
  }

  function timeLabel(ts: number): string {
    if (!ts) return '';
    const date = new Date(ts);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return sameDay
      ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : date.toLocaleDateString([], { day: '2-digit', month: 'short' });
  }

  function indexOfHit(hit: SearchHit): number {
    return flat.findIndex(h => h.id === hit.id && h.source === hit.source);
  }

  // ── Yasam dongusu ────────────────────────────────────────────────────────
  onMount(() => {
    BridgeRegistry.register('openGlobalSearch', (initial?: string) => open(typeof initial === 'string' ? initial : ''));
    BridgeRegistry.register('closeGlobalSearch', close);
    // Kanal-ici arama: ayni kanitli arama panelini ACIK KANALA tam kimlikle
    // kilitler. Isim yalnizca kullaniciya kapsam etiketi gostermek icindir;
    // backend daraltmasi `_id` ile yapilir.
    BridgeRegistry.register('openChannelSearch', () => {
      const ch = BridgeRegistry.call<{ _id?: string; id?: string; name?: string } | null>('getCurrentChannel');
      const channelId = typeof (ch?._id ?? ch?.id) === 'string' ? String(ch?._id ?? ch?.id).trim() : '';
      const channelName = typeof ch?.name === 'string' ? ch.name.trim() : '';
      open('', channelId ? { channelId, channelName } : {});
    });
    log.info('Kuresel arama hazir');
  });

  onDestroy(() => {
    if (debounceTimer) clearTimeout(debounceTimer);
    inFlight?.abort();
    BridgeRegistry.unregister('openGlobalSearch');
    BridgeRegistry.unregister('closeGlobalSearch');
    BridgeRegistry.unregister('openChannelSearch');
  });
</script>

<svelte:window onkeydown={onGlobalKeyDown} />

{#if isVisible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="gs-overlay" role="presentation" onclick={close}>
  <div
    class="gs-panel"
    role="dialog"
    aria-modal="true"
    aria-label={t("ui_global_search_aria")}
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onPanelKeyDown}
    use:focusTrap={{ active: isVisible, initialFocus: '.gs-input' }}
  >
    <div class="gs-header">
      <span class="gs-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4.5 4.5"/></svg>
      </span>
      <input
        class="gs-input"
        bind:this={inputEl}
        bind:value={query}
        type="text"
        role="combobox"
        placeholder={t('attr_tum_mesajlarda_ara_a90f84e', "Tum mesajlarda ara…")}
        aria-label={t('attr_tum_mesajlarda_ara_332ebf1', "Tum mesajlarda ara")}
        aria-expanded={flat.length > 0}
        aria-controls="gs-listbox"
        aria-autocomplete="list"
        aria-activedescendant={selected ? `gs-hit-${selected.source}-${selected.id}` : undefined}
        autocomplete="off"
        spellcheck="false"
      />
      {#if isLoading}
        <span class="gs-spinner" aria-hidden="true"></span>
      {/if}
      <button type="button" class="gs-esc" onclick={close}>ESC</button>
    </div>

    <!-- FAZ 8/3 — FILTRELER. Sunucuda uygulanir (routes/search.ts); istemci
         yalnizca secimi tasir. Yazarak da yapilabilir: `from:ayse has:file`. -->
    <div class="gs-filters" role="group" aria-label={t('attr_arama_filtreleri_52c4a1e', "Arama filtreleri")}>
      <span class="gs-filter-label">{t('markup_filtrele_4d0a4d0', "Filtrele")}</span>
      {#each HAS_OPTIONS as option (option.id)}
        <button
          type="button"
          class="gs-chip"
          class:active={activeFilters.has === option.id}
          aria-pressed={activeFilters.has === option.id}
          onclick={() => setFilter('has', option.id)}
        >{t(option.labelKey)}</button>
      {/each}
      {#if activeFilters.from}
        <span class="gs-chip gs-chip-static">{t("ui_sender_filter", undefined, { sender: activeFilters.from })}</span>
      {/if}
      {#if lockedChannelId}
        <span class="gs-chip gs-chip-static" data-locked-scope="channel">
          #{lockedChannelName || t('channel', 'Kanal')}
        </span>
      {:else if activeFilters.in}
        <span class="gs-chip gs-chip-static">#{activeFilters.in}</span>
      {/if}
      {#if trimmed.length >= MIN_QUERY_LENGTH && !lockedChannelId}
        <button type="button" class="gs-chip gs-chip-save" onclick={saveCurrentSearch}>{t("search_save")}</button>
      {/if}
      {#if editableFiltersOn}
        <button type="button" class="gs-chip gs-chip-clear" onclick={clearFilters}>{t('ptt_key_clear')}</button>
      {/if}
    </div>

    <!-- Ekran okuyucu duyurusu: gorsel durum degisimleri sessiz kalmamali. -->
    <p class="gs-sr-only" role="status" aria-live="polite">{statusText}</p>

    <div class="gs-body" bind:this={listEl}>
      {#if error}
        <div class="gs-state gs-state-error" role="alert">
          <p>{error}</p>
          {#if trimmed.length >= MIN_QUERY_LENGTH}
            <button type="button" class="gs-retry" onclick={() => void runSearch(trimmed)}>
              {t('retry')}
            </button>
          {/if}
        </div>

      {:else if showDiscovery}
        <div class="gs-recent">
          {#if saved.length}
            <div class="gs-recent-head"><span class="gs-group-label">{t('markup_kaydedilen_aramalar_01b88e6', "Kaydedilen aramalar")}</span></div>
            <ul class="gs-recent-list">
              {#each saved as item (item)}
                <li class="gs-recent-item">
                  <button type="button" class="gs-recent-use" onclick={() => useSaved(item)}>
                    <span class="gs-recent-icon" aria-hidden="true">★</span>
                    <span class="gs-recent-text">{item}</span>
                  </button>
                  <button type="button" class="gs-recent-drop" aria-label={t('search_remove_saved_aria', undefined, { query: item })} onclick={() => dropSaved(item)}>×</button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if recent.length}
            <div class="gs-recent-head">
              <span class="gs-group-label">{t('markup_son_aramalar_6941819', "Son aramalar")}</span>
              <button type="button" class="gs-clear" onclick={clearAllRecent}>{t('ptt_key_clear')}</button>
            </div>
            <ul class="gs-recent-list">
              {#each recent as item (item)}
                <li class="gs-recent-item">
                  <button type="button" class="gs-recent-use" onclick={() => useRecent(item)}>
                    <span class="gs-recent-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/></svg>
                    </span>
                    <span class="gs-recent-text">{item}</span>
                  </button>
                  <button type="button" class="gs-recent-drop" aria-label={t('search_remove_saved_aria', undefined, { query: item })} onclick={() => dropRecent(item)}>×</button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>

      {:else if trimmed.length < MIN_QUERY_LENGTH}
        <div class="gs-state">
          <p class="gs-hint">{t('gsp_scope', 'Mesajlarda, DM\'lerde, grup mesajlarında ve konu yanıtlarında arayın.')}</p>
          <p class="gs-hint gs-hint-syntax">
            <code>from:ayse</code> · <code>in:genel</code> · <code>has:file</code> · <code>after:2026-09-01</code> · <code>before:2026-10-01</code>
          </p>
          <ul class="gs-tips">
            <li><kbd>↑</kbd><kbd>↓</kbd> {t('markup_gezin_efafc56', "gezin")}</li>
            <li><kbd>Enter</kbd> {t('gsp_open', 'aç')}</li>
            <li><kbd>Esc</kbd> {t('close')}</li>
          </ul>
        </div>

      {:else if isLoading && !flat.length}
        <ul class="gs-skeletons" aria-hidden="true">
          {#each [0, 1, 2, 3] as i (i)}
            <li class="gs-skeleton"><span class="gs-skel-line"></span><span class="gs-skel-line short"></span></li>
          {/each}
        </ul>

      {:else if !flat.length}
        <div class="gs-state">
          <p class="gs-empty-title">{t("ui_no_results_for_query", undefined, { query: trimmed })}</p>
          <p class="gs-hint">{t('gsp_no_results', 'Farklı bir kelime deneyin. Arama yalnızca görebildiğiniz konuşmaları kapsar.')}</p>
        </div>

      {:else}
        <ul id="gs-listbox" class="gs-list" role="listbox" aria-label={t('gsp_results', 'Arama sonuçları')}>
          {#each groups as group (group.source)}
            <li class="gs-group" role="presentation">
              <span class="gs-group-label">{group.label}</span>
              <span class="gs-group-count">{group.hits.length}</span>
            </li>
            {#each group.hits as hit (hit.source + hit.id)}
              {@const idx = indexOfHit(hit)}
              {@const isSelected = idx === selectedIdx}
              <li
                id="gs-hit-{hit.source}-{hit.id}"
                class="gs-hit"
                class:selected={isSelected}
                role="option"
                aria-selected={isSelected}
                tabindex="-1"
                onclick={() => void activate(hit)}
                onmousemove={() => { selectedIdx = idx; }}
              >
                <span class="gs-hit-source" data-source={hit.source} aria-hidden="true"></span>
                <span class="gs-hit-body">
                  <span class="gs-hit-meta">
                    <strong class="gs-hit-author">{hit.authorName || t('unknown_user')}</strong>
                    <span class="gs-hit-context">{contextLabel(hit)}</span>
                    <span class="gs-hit-time">{timeLabel(hit.createdAt)}</span>
                  </span>
                  <span class="gs-hit-text">
                    {#each highlightSegments(snippetAround(hitText(hit), trimmed), trimmed) as seg}
                      {#if seg.match}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
                    {/each}
                  </span>
                </span>
                <span class="gs-hit-go" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>
                </span>

                <!--
                  BAGLAM ONIZLEMESI — yalnizca SECILI sonucun altinda.
                  Etkilesimli oge YOKTUR: `role="option"` icinde buton olsa
                  `nested-interactive` (axe: serious) uretirdi.
                  Icerik DUZ METINDIR; Svelte kacisla basar, `innerHTML` yok.
                -->
                {#if isSelected}
                  {@const ctx = contextCache[hitKey(hit)]}
                  {#if ctx?.length}
                    <span class="gs-ctx">
                      {#each ctx as msg (msg._id)}
                        <span class="gs-ctx-line" class:anchor={msg.isAnchor}>
                          <span class="gs-ctx-author">{msg.displayName || t('unknown_user')}</span>
                          <span class="gs-ctx-text">{hit.source === 'channel' ? messageText(msg) : msg.content}</span>
                        </span>
                      {/each}
                    </span>
                  {:else if contextLoading === hitKey(hit)}
                    <span class="gs-ctx gs-ctx-loading" aria-hidden="true">
                      <span class="gs-ctx-line"></span>
                      <span class="gs-ctx-line"></span>
                    </span>
                  {/if}
                {/if}
              </li>
            {/each}
          {/each}
        </ul>

        {#if hasMore}
          <div class="gs-more">
            <button
              type="button"
              class="gs-more-button"
              disabled={isLoadingMore}
              onclick={() => void runSearch(trimmed, true)}
            >{isLoadingMore ? t("loading") : t("surface_daha_fazla_sonuc_yukle_ba3577")}</button>
          </div>
        {/if}
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
.gs-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--layer-modal);
  display: flex;
  justify-content: center;
  padding: clamp(24px, 8dvh, 72px) 16px max(16px, env(safe-area-inset-bottom));
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  backdrop-filter: blur(8px) saturate(110%);
  animation: gs-fade var(--duration-fast) var(--ease-out);
}

.gs-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(680px, 100%);
  max-height: min(620px, calc(var(--bridge-visual-viewport-height, 100dvh) - 96px));
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-modal);
  box-shadow: var(--shadow-xl);
  animation: gs-rise var(--duration-base) var(--ease-spring);
}

.gs-panel::before {
  position: absolute;
  inset: 0 0 auto;
  z-index: 1;
  height: 2px;
  content: '';
  background: linear-gradient(90deg, var(--brand), var(--accent), transparent 88%);
}

/* ── Baslik ── */
.gs-header {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  min-height: 58px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-faint);
}

.gs-icon { display: flex; color: var(--text-muted); }
.gs-icon svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

.gs-input {
  flex: 1;
  min-width: 0;
  font: inherit;
  font-size: var(--text-lg);
  color: var(--text-primary);
  background: none;
  border: 0;
  outline: none;
}
.gs-input::placeholder { color: var(--text-muted); }

.gs-spinner {
  width: 15px;
  height: 15px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--brand);
  border-radius: 50%;
  animation: gs-spin 640ms linear infinite;
}

.gs-esc {
  padding: 3px 8px;
  font-size: var(--text-2xs);
  font-weight: 600;
  letter-spacing: .04em;
  color: var(--text-muted);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.gs-esc:hover { color: var(--text-primary); background: var(--bg-4); }

/* ── Govde ── */
.gs-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  align-items: center;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-faint);
}
.gs-filter-label {
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: .05em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.gs-chip {
  padding: 3px 10px;
  font: inherit;
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.gs-chip:hover { color: var(--text-primary); background: var(--bg-4); }
/* Secili durum RENKTEN baska isaret de tasir: `aria-pressed` ve kalinlasan
   kenarlik. */
.gs-chip.active {
  color: var(--brand);
  background: var(--brand-bg-low, var(--brand-bg));
  border-color: var(--brand);
  font-weight: 600;
}
.gs-chip-static { cursor: default; color: var(--text-muted); }
.gs-chip-clear { color: var(--text-muted); background: none; border-style: dashed; }
.gs-hint-syntax { margin-top: 8px; }
.gs-hint-syntax code {
  padding: 1px 5px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  background: var(--bg-3);
  /* Marka rengi `--bg-3` üzerinde 4.26:1 kalıyordu (WCAG 1.4.3 AA = 4.5:1).
     `--brand-ink` açık temada daha koyu bir marka tonudur; koyu temada
     `--brand`e eşittir, yani koyu tema görünümü değişmez. */
  color: var(--brand-ink, var(--brand));
  border-radius: 4px;
}

.gs-body { flex: 1; overflow-y: auto; overscroll-behavior: contain; }

.gs-list, .gs-recent-list, .gs-skeletons { margin: 0; padding: 6px; list-style: none; }

.gs-group {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  padding: 12px 10px 6px;
}
.gs-group-label {
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: .06em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.gs-group-count {
  padding: 0 6px;
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: var(--bg-3);
  border-radius: 999px;
}

/* ── Sonuc satiri ── */
.gs-hit {
  display: flex;
  flex-wrap: wrap;              /* onizleme kendi satirina insin */
  gap: var(--space-3);
  align-items: flex-start;
  padding: 9px 10px;
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: background var(--duration-fast) var(--ease-out);
}
.gs-hit.selected { background: var(--bg-modifier-selected, var(--bg-3)); }
.gs-hit.selected .gs-hit-go { opacity: 1; transform: translateX(0); }

/* ── BAGLAM ONIZLEMESI ────────────────────────────────────────────────────
   Onizleme `li`nin TAM GENISLIGINDE kendi satirini alir. `.gs-hit` bir flex
   kapsayicidir; sarma olmadan onizleme yan sutuna sikisirdi. */
.gs-ctx {
  display: flex;
  flex: 1 0 100%;
  flex-direction: column;
  gap: 2px;
  padding: 6px 0 2px 11px;
  margin-top: 6px;
  /* Konusma oldugunu gosteren dikey ip — metnin kendisi degil, baglami. */
  border-left: 2px solid var(--bg-modifier-accent, var(--bg-4));
}
.gs-ctx-line {
  display: flex;
  gap: var(--space-2);
  overflow: hidden;
  font-size: var(--text-xs);
  line-height: 1.5;
  color: var(--text-muted);
  white-space: nowrap;
}
.gs-ctx-author {
  flex: 0 0 auto;
  max-width: 12ch;
  overflow: hidden;
  font-weight: 600;
  text-overflow: ellipsis;
}
.gs-ctx-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Isabetin KENDISI: cevresindeki satirlardan ayrilir. */
.gs-ctx-line.anchor { color: var(--text-primary); }
.gs-ctx-line.anchor .gs-ctx-author { color: var(--text-secondary); }

/* Yukleniyor: iki iskelet satiri. Yerini onceden ayirir, boylece onizleme
   gelince liste ZIPLAMAZ. */
.gs-ctx-loading .gs-ctx-line {
  height: 1em;
  background: var(--bg-modifier-accent, var(--bg-4));
  border-radius: var(--radius-sm);
  opacity: 0.5;
  animation: gs-ctx-pulse 1.2s var(--ease-out) infinite;
}
.gs-ctx-loading .gs-ctx-line:last-child { width: 70%; }

@keyframes gs-ctx-pulse {
  50% { opacity: 0.22; }
}
@media (prefers-reduced-motion: reduce) {
  .gs-ctx-loading .gs-ctx-line { animation: none; }
}

/* Kaynak, renkli bir dikey serit ile kodlanir: goz gruplar arasinda
   atlarken satirin turunu basligi tekrar okumadan ayirt eder. */
.gs-hit-source {
  flex: 0 0 3px;
  align-self: stretch;
  min-height: 34px;
  border-radius: 999px;
  background: var(--text-muted);
}
.gs-hit-source[data-source='channel'] { background: var(--brand); }
.gs-hit-source[data-source='dm']      { background: var(--green); }
.gs-hit-source[data-source='gdm']     { background: var(--accent); }
.gs-hit-source[data-source='thread']  { background: var(--yellow); }

.gs-hit-body { flex: 1; min-width: 0; }

.gs-hit-meta {
  display: flex;
  gap: var(--space-2);
  align-items: baseline;
  margin-bottom: 2px;
}
.gs-hit-author {
  overflow: hidden;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gs-hit-context, .gs-hit-time {
  flex-shrink: 0;
  font-size: var(--text-2xs);
  color: var(--text-muted);
}
.gs-hit-time { margin-inline-start: auto; font-variant-numeric: tabular-nums; }

.gs-hit-text {
  display: -webkit-box;
  overflow: hidden;
  font-size: var(--text-sm);
  line-height: 1.45;
  color: var(--text-secondary);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
}
.gs-hit-text mark {
  padding: 0 1px;
  color: var(--text-primary);
  background: var(--brand-bg-low, var(--brand-bg));
  border-radius: 3px;
}

.gs-hit-go {
  display: flex;
  flex-shrink: 0;
  align-self: center;
  color: var(--text-muted);
  opacity: 0;
  transform: translateX(-3px);
  transition: opacity var(--duration-fast) var(--ease-out), transform var(--duration-fast) var(--ease-out);
}
.gs-hit-go svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }

/* ── Durumlar ── */
.gs-state { padding: 28px 22px; text-align: center; }
.gs-empty-title { margin: 0 0 6px; font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
.gs-hint { margin: 0; font-size: var(--text-sm); line-height: 1.5; color: var(--text-muted); }
.gs-state-error { color: var(--danger-text, var(--danger)); }
.gs-state-error p { margin: 0 0 10px; font-size: var(--text-sm); }

.gs-retry, .gs-clear {
  padding: 5px 12px;
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.gs-retry:hover, .gs-clear:hover { background: var(--bg-4); }

.gs-tips {
  display: flex;
  gap: var(--space-4);
  justify-content: center;
  margin: 16px 0 0;
  padding: 0;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  list-style: none;
}
.gs-tips kbd {
  padding: 1px 5px;
  margin-inline-end: 4px;
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 4px;
}

/* ── Son aramalar ── */
.gs-recent-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px 4px; }
.gs-recent-item { display: flex; align-items: center; border-radius: var(--radius-md); }
.gs-recent-item:hover { background: var(--bg-3); }
.gs-recent-use {
  display: flex;
  flex: 1;
  gap: var(--space-3);
  align-items: center;
  min-width: 0;
  padding: 8px 10px;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-align: start;
  cursor: pointer;
  background: none;
  border: 0;
}
.gs-recent-icon { display: flex; color: var(--text-muted); }
.gs-recent-icon svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
.gs-recent-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gs-recent-drop {
  padding: 4px 10px;
  font-size: var(--text-base);
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: 0;
}
.gs-recent-drop:hover { color: var(--text-primary); }

/* ── Iskelet ── */
.gs-skeleton { padding: 11px 10px; }
.gs-skel-line {
  display: block;
  height: 9px;
  margin-bottom: 7px;
  background: linear-gradient(90deg, var(--bridge-skel), var(--bridge-skel2), var(--bridge-skel));
  background-size: 200% 100%;
  border-radius: 4px;
  animation: gs-shimmer 1.3s linear infinite;
}
.gs-skel-line.short { width: 62%; margin-bottom: 0; }

.gs-more {
  display: flex;
  justify-content: center;
  padding: 8px 16px 14px;
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  text-align: center;
}
.gs-more-button {
  padding: 7px 13px;
  font: inherit;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.gs-more-button:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-4); }
.gs-more-button:disabled { cursor: wait; opacity: .65; }

.gs-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@keyframes gs-fade  { from { opacity: 0; } to { opacity: 1; } }
@keyframes gs-rise  { from { opacity: 0; transform: translateY(-10px) scale(.985); } to { opacity: 1; transform: none; } }
@keyframes gs-spin  { to { transform: rotate(360deg); } }
@keyframes gs-shimmer { to { background-position: -200% 0; } }

@media (max-width: 600px) {
  .gs-overlay {
    padding: 0;
    align-items: stretch;
    background: var(--bg-2);
    backdrop-filter: none;
  }
  .gs-panel {
    width: 100%;
    max-height: none;
    height: var(--bridge-visual-viewport-height, 100dvh);
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .gs-panel::before { display: none; }
  .gs-header {
    min-height: 56px;
    padding: max(10px, env(safe-area-inset-top)) 12px 8px;
  }
  .gs-esc { min-width: 40px; min-height: 40px; }
  .gs-filters {
    flex-wrap: nowrap;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    padding-inline: 12px;
  }
  .gs-filters::-webkit-scrollbar { display: none; }
  .gs-filter-label, .gs-chip { flex: none; }
  .gs-chip { min-height: 36px; padding-inline: 12px; }
  .gs-body { padding-bottom: env(safe-area-inset-bottom); }
  .gs-hit { min-height: 56px; }
  .gs-tips { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .gs-overlay, .gs-panel, .gs-skel-line, .gs-spinner { animation: none; }
  .gs-hit, .gs-hit-go { transition: none; }
}
</style>
