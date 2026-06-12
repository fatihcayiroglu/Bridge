<!-- client/js/core/bot-marketplace/BotMarketplace.svelte -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { escHtml } from '../utils.js';
  import { CATEGORIES, TAG_COLORS } from './catalog-data.js';
  import { getCatalog, loadCatalog } from './bot-catalog.js';
  import { fetchLoadedPlugins, getLoadedPlugins, installBotOnServer, uninstallBotFromServer } from './bot-api.js';
  import { filterBots } from './bot-search.js';
  import { getInstalledBots, isBotInstalled, toggleInstalledLocal, showToast } from './marketplace-state.js';
  import { injectStyles } from './bot-styles.js';
  import type { BotEntry, MarketplaceTab, SortMode } from './types.js';

  interface Props { onClose?: () => void; initialCategory?: string; initialTab?: MarketplaceTab; }
  let { onClose, initialCategory = '', initialTab = 'featured' }: Props = $props();

  function getInitialCategory(): string { return initialCategory; }
  function getInitialTab(): MarketplaceTab { return initialTab; }

  let activeCategory = $state(getInitialCategory());
  let activeTab      = $state<MarketplaceTab>(getInitialTab());
  let searchQuery    = $state('');
  let sortBy         = $state<SortMode>('installs');
  let detailBot      = $state<BotEntry | null>(null);
  let ready          = $state(false);

  // getInstalledBots() vanilla Set döndürür — Svelte 5 runes Set mutasyonunu izlemez.
  // _installedVersion sayacını her toggle'da artırarak $derived'ın yeniden hesaplanmasını sağlarız.
  let _installedVersion = $state(0);
  function installedSet(): Set<string> { return getInstalledBots(); }

  let filtered = $derived((() => {
    void _installedVersion; // reaktif bağımlılık — toggle'da güncellenir
    return filterBots({
      category: activeCategory,
      tab: activeTab,
      searchQuery,
      sortBy,
      installedIds: installedSet(),
    });
  })());

  let featured = $derived(getCatalog().filter(b => b.featured).slice(0, 3));
  let plugins  = $derived(Object.values(getLoadedPlugins()));

  function stars(rating: number): string {
    const n = Math.round(rating);
    return '\u2605'.repeat(n) + '\u2606'.repeat(5 - n);
  }

  function tagHtml(tag: string): string {
    const c = TAG_COLORS[tag] ?? 'var(--brand)';
    return `<span class="mp-tag" style="background:${c}22;color:${c};border:1px solid ${c}44">${escHtml(tag)}</span>`;
  }

  async function toggleBot(bot: BotEntry): Promise<void> {
    const inst = isBotInstalled(bot.id);
    if (!inst) {
      await installBotOnServer(bot.id);
      toggleInstalledLocal(bot.id, true);
      showToast(`${bot.name} eklendi`, 'success');
    } else {
      await uninstallBotFromServer(bot.id);
      toggleInstalledLocal(bot.id, false);
      showToast('Bot kaldirildi', 'info');
    }
    _installedVersion++; // $derived'ı tetikle — Set mutasyonu Svelte tarafından izlenmez
  }

  function close(): void {
    detailBot = null;
    onClose?.();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (detailBot) detailBot = null;
      else close();
    }
  }

  onMount(() => {
    injectStyles();
    window.addEventListener('keydown', onKey);
    void Promise.all([loadCatalog(), fetchLoadedPlugins()]).then(() => { ready = true; });
  });

  onDestroy(() => window.removeEventListener('keydown', onKey));
</script>

<div id="bot-marketplace-overlay" style="display:none" aria-hidden="true"></div>

<div
  id="bot-marketplace-modal"
  role="dialog"
  aria-modal="true"
  aria-label="Bot Marketplace"
  tabindex="-1"
  onkeydown={onKey}
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div class="mp-panel">
    <header class="mp-header">
      <div class="mp-header-top">
        <div>
          <div class="mp-title">Bot Marketplace</div>
          <p class="mp-subtitle">
            Sunucunu guclendir
            <span class="mp-badge">{getCatalog().length} bot</span>
          </p>
        </div>
        <button type="button" class="mp-close" onclick={close} aria-label="Kapat">X</button>
      </div>
      <div class="mp-controls">
        <input class="mp-search" id="mp-search" type="search" placeholder="Bot ara..." bind:value={searchQuery} />
        <select class="mp-sort" bind:value={sortBy}>
          <option value="installs">En Populer</option>
          <option value="rating">En Yuksek Puan</option>
          <option value="name">A-Z</option>
        </select>
      </div>
      <div class="mp-tabs" role="tablist">
        {#each [
          { id: 'featured', label: 'One Cikanlar' },
          { id: 'all', label: 'Tum Botlar' },
          { id: 'installed', label: `Yukluler (${installedSet().size})` },
          { id: 'plugins', label: `Pluginler (${plugins.length})` },
        ] as tab}
          <button
            type="button"
            role="tab"
            class="mp-tab"
            class:active={activeTab === tab.id}
            onclick={() => { activeTab = tab.id as MarketplaceTab; }}
          >{tab.label}</button>
        {/each}
      </div>
    </header>

    <div class="mp-body">
      <aside class="mp-sidebar" id="bm-categories">
        <p class="mp-sidebar-lbl">Kategoriler</p>
        {#each CATEGORIES as cat}
          <button
            type="button"
            class="mp-cat"
            class:active={activeCategory === cat.id}
            onclick={() => { activeCategory = cat.id; }}
          >
            {cat.icon} {cat.label}
            <span class="cc">{cat.id === '' ? getCatalog().length : getCatalog().filter(b => b.category === cat.id).length}</span>
          </button>
        {/each}
      </aside>

      <div class="mp-grid-wrap" id="mp-grid-wrap">
        {#if !ready}
          <p class="mp-empty-t">Yukleniyor...</p>
        {:else if activeTab === 'plugins'}
          <div class="mp-grid">
            {#if plugins.length === 0}
              <p class="mp-empty-t">Yuklu plugin yok</p>
            {:else}
              {#each plugins as p}
                <article class="mp-card installed">
                  <h3 class="mp-card-name">{p.name}</h3>
                  <p class="mp-card-desc">{p.description ?? ''}</p>
                </article>
              {/each}
            {/if}
          </div>
        {:else}
          {#if activeTab === 'featured' && !searchQuery && !activeCategory}
            <div class="mp-feat-banner">
              {#each featured as b}
                <button type="button" class="mp-feat-card" onclick={() => { detailBot = b; }}>
                  <span class="mp-feat-name">{b.name}</span>
                  <span class="mp-feat-desc">{b.description}</span>
                </button>
              {/each}
            </div>
          {/if}
          <div class="mp-grid" id="bm-bots-grid">
            {#if filtered.length === 0}
              <p class="mp-empty-t" id="bm-results-info">Sonuc bulunamadi</p>
            {:else}
              {#each filtered as bot (bot.id)}
                <article class="mp-card" class:installed={isBotInstalled(bot.id)} data-bot-id={bot.id}>
                  <div class="mp-card-top">
                    <span class="mp-card-av">{bot.avatar}</span>
                    <div>
                      <h3 class="mp-card-name">{bot.name}</h3>
                      <p class="mp-card-meta">by {bot.author}</p>
                    </div>
                  </div>
                  <p class="mp-card-desc">{bot.description}</p>
                  <div class="mp-card-tags">{@html bot.tags.slice(0, 2).map(tagHtml).join('')}</div>
                  <p class="mp-rating">{stars(bot.rating)} {bot.rating}</p>
                  <div class="mp-card-foot">
                    <button type="button" class="mp-btn-detail" onclick={() => { detailBot = bot; }}>Detaylar</button>
                    <button
                      type="button"
                      class="mp-btn-inst"
                      class:add={!isBotInstalled(bot.id)}
                      class:rem={isBotInstalled(bot.id)}
                      onclick={() => void toggleBot(bot)}
                    >{isBotInstalled(bot.id) ? 'Yuklu' : 'Ekle'}</button>
                  </div>
                </article>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>

{#if detailBot}
  <div id="mp-detail-overlay" role="dialog" aria-modal="true" tabindex="-1" onkeydown={onKey} onclick={(e) => { if (e.target === e.currentTarget) detailBot = null; }}>
    <div class="mp-det-panel">
      <div class="mp-det-hero">
        <span class="mp-det-av">{detailBot.avatar}</span>
        <h2 class="mp-det-name">{detailBot.name}</h2>
      </div>
      <div class="mp-det-body">
        <p class="mp-det-desc">{detailBot.longDescription}</p>
        <div class="mp-cmds">
          {#each detailBot.commands as cmd}<span class="mp-cmd">{cmd}</span>{/each}
        </div>
      </div>
      <footer class="mp-det-foot">
        <button type="button" class="mp-det-cls" onclick={() => { detailBot = null; }}>Kapat</button>
        <button type="button" class="mp-inst-big add" onclick={() => detailBot && void toggleBot(detailBot)}>
          {isBotInstalled(detailBot.id) ? 'Kaldir' : 'Ekle'}
        </button>
      </footer>
    </div>
  </div>
{/if}
