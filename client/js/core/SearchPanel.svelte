<!-- client/js/core/SearchPanel.svelte -->
<!-- Sprint 115 — search.ts (555 satır) → Svelte 5 Runes (ADR-0008 Faz 2) -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

  const log = createLogger('SearchPanel');

  // ── State ──────────────────────────────────────────────────────────────────
  let query       = $state('');
  let results     = $state<SearchResult[]>([]);
  let isLoading   = $state(false);
  let isVisible   = $state(false);
  let activeTab   = $state<'messages' | 'members' | 'channels' | 'files'>('messages');
  let page        = $state(1);
  let hasMore     = $state(false);
  let serverId    = $state<string | null>(null);
  let error       = $state<string | null>(null);

  interface SearchResult {
    _id: string;
    type: 'message' | 'member' | 'channel' | 'file';
    content?: string;
    username?: string;
    channelName?: string;
    fileName?: string;
    authorUsername?: string;
    channelId?: string;
    createdAt?: number;
    score?: number;
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  let trimmedQuery  = $derived(query.trim());
  let hasResults    = $derived(results.length > 0);
  let totalLabel    = $derived(results.length > 0
    ? `${results.length}${hasMore ? '+' : ''} sonuç`
    : '');

  // ── Debounce ───────────────────────────────────────────────────────────────
  let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const q = trimmedQuery;
    if (_debounceTimer) clearTimeout(_debounceTimer);
    if (q.length < 2) { results = []; error = null; return; }
    _debounceTimer = setTimeout(() => runSearch(q), 250);
    return () => { if (_debounceTimer) clearTimeout(_debounceTimer); };
  });

  // ── API ────────────────────────────────────────────────────────────────────
  async function runSearch(q: string, p = 1) {
    if (!serverId) return;
    isLoading = true; error = null;
    try {
      const apiFetch = BridgeRegistry.get('apiFetch');
      const url = `/api/servers/${serverId}/search?q=${encodeURIComponent(q)}&type=${activeTab}&page=${p}&limit=20`;
      const res = await apiFetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { results: SearchResult[]; hasMore: boolean };
      results = p === 1 ? data.results : [...results, ...data.results];
      hasMore = data.hasMore;
      page = p;
    } catch (err) {
      log.error('Search failed', err);
      error = 'Arama sırasında hata oluştu. Lütfen tekrar deneyin.';
      results = [];
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
    serverId = sid;
    isVisible = true;
    // focus will be handled by $effect after render
  }
  function close() { isVisible = false; clear(); }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────
  onMount(() => {
    BridgeRegistry.register('openSearch',  open);
    BridgeRegistry.register('closeSearch', close);
  });
  onDestroy(() => {
    if (_debounceTimer) clearTimeout(_debounceTimer);
  });

  function formatDate(ts?: number) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
  }
</script>

<svelte:window onkeydown={onKeyDown} />

{#if isVisible}
<div class="search-overlay" role="dialog" aria-label="Sunucu Arama" aria-modal="true">
  <div class="search-panel">

    <div class="search-header">
      <div class="search-input-wrap">
        <span class="search-icon" aria-hidden="true">🔍</span>
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="search-input"
          type="search"
          bind:value={query}
          placeholder="Mesaj, üye, kanal veya dosya ara…"
          aria-label="Arama sorgusu"
          autocomplete="off"
          autofocus
        />
        {#if query}
          <button class="search-clear" onclick={clear} aria-label="Temizle">✕</button>
        {/if}
      </div>
      <button class="search-close" onclick={close} aria-label="Kapat">✕</button>
    </div>

    <!-- Tab bar -->
    <div class="search-tabs" role="tablist">
      {#each ['messages', 'members', 'channels', 'files'] as tab}
        <button
          class="search-tab {activeTab === tab ? 'active' : ''}"
          role="tab"
          aria-selected={activeTab === tab}
          onclick={() => { activeTab = tab as typeof activeTab; if (trimmedQuery.length >= 2) runSearch(trimmedQuery); }}
        >
          { tab === 'messages' ? '💬 Mesajlar'
          : tab === 'members'  ? '👤 Üyeler'
          : tab === 'channels' ? '# Kanallar'
          : '📎 Dosyalar' }
        </button>
      {/each}
    </div>

    <!-- Results -->
    <div class="search-results" role="listbox">
      {#if isLoading && results.length === 0}
        <div class="search-skeleton" aria-live="polite" aria-label="Yükleniyor">
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
                <span class="result-author">@{result.authorUsername}</span>
                <span class="result-channel">#{result.channelName}</span>
                <span class="result-date">{formatDate(result.createdAt)}</span>
              </div>
              <div class="result-content">{result.content}</div>
            {:else if result.type === 'member'}
              <span class="result-avatar">👤</span>
              <span class="result-name">@{result.username}</span>
            {:else if result.type === 'channel'}
              <span class="result-channel-icon">#</span>
              <span class="result-name">{result.channelName}</span>
            {:else if result.type === 'file'}
              <span class="result-file-icon">📎</span>
              <span class="result-name">{result.fileName}</span>
            {/if}
          </button>
        {/each}
        {#if hasMore}
          <button class="search-load-more" onclick={loadMore} disabled={isLoading}>
            {isLoading ? 'Yükleniyor…' : 'Daha fazla yükle'}
          </button>
        {/if}
      {:else if trimmedQuery.length >= 2 && !isLoading}
        <div class="search-empty" aria-live="polite">
          <p>"{trimmedQuery}" için sonuç bulunamadı.</p>
          <small>Farklı anahtar kelimeler veya sekme deneyebilirsiniz.</small>
        </div>
      {:else if trimmedQuery.length < 2}
        <div class="search-hint">En az 2 karakter girin.</div>
      {/if}
    </div>

  </div>
</div>
{/if}

<style>
.search-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,.6);
  display: flex; justify-content: center; padding-top: 80px;
  z-index: 9000;
  backdrop-filter: blur(3px);
}
.search-panel {
  background: var(--bridge-surface, #1e2124);
  border-radius: 12px;
  width: 100%; max-width: 660px;
  max-height: calc(100vh - 160px);
  display: flex; flex-direction: column;
  box-shadow: 0 8px 32px rgba(0,0,0,.5);
  overflow: hidden;
}
.search-header {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--bridge-border, #2c2f33);
}
.search-input-wrap {
  flex: 1; display: flex; align-items: center; gap: 8px;
  background: var(--bridge-surface2, #2c2f33);
  border-radius: 8px; padding: 6px 12px;
}
.search-input {
  flex: 1; background: none; border: none; outline: none;
  color: var(--bridge-text, #fff); font-size: 1rem;
}
.search-clear, .search-close, .search-icon {
  background: none; border: none; cursor: pointer; color: var(--bridge-muted, #99aab5);
  font-size: .9rem;
}
.search-tabs {
  display: flex; overflow-x: auto;
  border-bottom: 1px solid var(--bridge-border, #2c2f33);
}
.search-tab {
  padding: 10px 16px; background: none; border: none; cursor: pointer;
  color: var(--bridge-muted, #99aab5); font-size: .85rem; white-space: nowrap;
  border-bottom: 2px solid transparent; transition: color .15s, border-color .15s;
}
.search-tab.active {
  color: var(--bridge-blue, #2d9cdb);
  border-bottom-color: var(--bridge-blue, #2d9cdb);
}
.search-results { flex: 1; overflow-y: auto; padding: 8px; }
.search-skeleton-item {
  height: 52px; background: var(--bridge-surface2, #2c2f33);
  border-radius: 8px; margin-bottom: 4px; animation: pulse 1.2s infinite;
}
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
.search-result-item {
  width: 100%; text-align: left; background: none; border: none; cursor: pointer;
  padding: 10px 12px; border-radius: 8px; color: var(--bridge-text, #fff);
  display: flex; flex-direction: column; gap: 2px;
  transition: background .1s;
}
.search-result-item:hover { background: var(--bridge-surface2, #2c2f33); }
.result-meta { display: flex; gap: 8px; font-size: .75rem; color: var(--bridge-muted, #99aab5); }
.result-content { font-size: .9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-name { font-size: .9rem; font-weight: 500; }
.search-count { font-size: .75rem; color: var(--bridge-muted, #99aab5); padding: 4px 12px 8px; }
.search-load-more {
  width: 100%; padding: 10px; background: var(--bridge-surface2, #2c2f33);
  border: none; border-radius: 8px; color: var(--bridge-blue, #2d9cdb);
  cursor: pointer; font-size: .875rem; margin-top: 4px;
}
.search-load-more:disabled { opacity: .5; cursor: default; }
.search-empty, .search-hint {
  padding: 32px 16px; text-align: center; color: var(--bridge-muted, #99aab5); font-size: .9rem;
}
.search-error { padding: 16px; color: var(--bridge-danger, #f04747); text-align: center; }
</style>
