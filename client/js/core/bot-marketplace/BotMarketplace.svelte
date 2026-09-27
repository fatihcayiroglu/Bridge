<!-- client/js/core/bot-marketplace/BotMarketplace.svelte -->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from '../a11y/focusTrap.ts';
  import { CATEGORIES, TAG_COLORS } from './catalog-data.js';
  import { getCatalog, loadCatalog } from './bot-catalog.js';
  import { fetchLoadedPlugins, getLoadedPlugins, fetchInstallState, installBotOnServer, uninstallBotFromServer, BotConsentOutdatedError } from './bot-api.js';
  import { describeBotPermission, sameScopes } from './bot-permissions.js';
  import { BridgeRegistry } from '../bridge-registry.js';
  import { safeApiErrorMessage } from '../api-error.ts';
  import { confirmProductAction } from '../product-dialog.ts';
  import { fetchMyPermissions, hasPerm, PERM_MANAGE_SERVER } from '../permissions/myPermissions.js';
  import { filterBots } from './bot-search.js';
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
  let installedIds   = $state<Set<string>>(new Set());
  let grants         = $state<Map<string, string[]>>(new Map());
  // The catalog and plugin lists live in plain module arrays that Svelte cannot
  // track. Without this counter a Retry after a failed load fetched the catalog
  // but left the grid empty ("0 bot") — the button did nothing visible.
  let catalogVersion = $state(0);
  let canManage      = $state(false);
  let installBusyId  = $state('');
  let installError   = $state('');

  const MARKETPLACE_TABS: Array<{ id: MarketplaceTab; label: string }> = $derived.by(() => [
    { id: 'featured', label: t("ui_one_cikanlar", "Öne Çıkanlar") },
    { id: 'all', label: t("ui_tum_botlar", "Tüm Botlar") },
    { id: 'plugins', label: t('ui_plugins', 'Pluginler') },
  ]);

  let catalogItems = $derived.by(() => { void catalogVersion; return [...getCatalog()]; });
  let filtered = $derived.by(() => {
    void catalogVersion;
    return filterBots({ category: activeCategory, tab: activeTab, searchQuery, sortBy });
  });

  let featured = $derived(catalogItems.filter(b => b.featured).slice(0, 3));
  let plugins  = $derived.by(() => { void catalogVersion; return Object.values(getLoadedPlugins()); });

  function requestedScopesOf(bot: BotEntry): string[] {
    return bot.requestedScopes?.length ? bot.requestedScopes : ['commands'];
  }

  /** Installed, but the listing now asks for different scopes than this server granted. */
  function needsReconsent(bot: BotEntry): boolean {
    const granted = grants.get(bot.id);
    return installedIds.has(bot.id) && granted !== undefined && !sameScopes(granted, requestedScopesOf(bot));
  }

  function trustLabel(bot: BotEntry): string {
    return bot.authorVerified ? t('bot_author_verified', 'Doğrulanmış geliştirici') : t('bot_author_unverified', 'Doğrulanmamış geliştirici');
  }

  function stars(rating: number): string {
    const safe = Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : 0;
    const n = Math.round(safe);
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  function tagColor(tag: string): string {
    const value = TAG_COLORS[tag];
    return typeof value === 'string' && (/^#[0-9a-fA-F]{3,8}$/.test(value) || /^var\(--[a-zA-Z0-9_-]+\)$/.test(value))
      ? value
      : 'var(--brand)';
  }

  function close(): void {
    detailBot = null;
    onClose?.();
  }

  function currentServerId(): string {
    if (!BridgeRegistry.has('currentServer')) return '';
    try {
      const server = BridgeRegistry.call<Record<string, unknown> | null>('currentServer') ?? {};
      return String(server._id ?? server.id ?? '');
    } catch { return ''; }
  }

  async function loadInstallState(): Promise<void> {
    const sid = currentServerId();
    if (!sid) { installedIds = new Set(); grants = new Map(); canManage = false; return; }
    try {
      const [state, perms] = await Promise.all([fetchInstallState(sid), fetchMyPermissions(sid)]);
      if (sid !== currentServerId()) return;
      installedIds = state.installed;
      grants = state.grants;
      canManage = hasPerm(perms, PERM_MANAGE_SERVER);
    } catch (cause) {
      installError = safeApiErrorMessage(cause, t("ui_bot_kurulum_durumu_yuklenemedi", "Bot kurulum durumu yüklenemedi."), { report: true });
    }
  }

  async function mutateInstall(bot: BotEntry, next: boolean): Promise<void> {
    const sid = currentServerId();
    if (!sid || !bot.installable || !canManage || installBusyId) return;
    // Installing is consent: the admin sees, in plain language, exactly the scopes the
    // server will record, and the request carries that list back. Nothing is granted
    // that was not shown (Final21 Phase 14).
    const scopes = requestedScopesOf(bot);
    if (next) {
      const lines = scopes.map(scope => `• ${describeBotPermission(scope, t)}`).join('\n');
      const author = `${t('market_by_author', undefined, { author: bot.author ?? '' })} · ${trustLabel(bot)}`;
      const ok = await confirmProductAction({
        title: t('bot_install_consent_title', '{name} kurulsun mu?', { name: bot.name }),
        message: `${t('bot_install_consent_intro', 'Kurarsan bu bot bu sunucuda şunları yapabilecek:')}\n\n${lines}\n\n${author}`,
        confirmLabel: t('market_install_to_server'),
        cancelLabel: t('cancel', 'İptal'),
      });
      if (!ok) return;
    } else {
      const ok = await confirmProductAction({ title: t("ui_botu_kaldir", "Botu kaldır"), message: t('bot_remove_confirm_named', '{name} bu sunucudan kaldırılsın mı?', { name: bot.name }), confirmLabel: t("ui_kaldir", "Kaldır"), tone: 'danger' });
      if (!ok) return;
    }
    installBusyId = bot.id; installError = '';
    try {
      if (next) await installBotOnServer(bot.id, sid, scopes); else await uninstallBotFromServer(bot.id, sid);
      await loadInstallState();
    } catch (cause) {
      if (cause instanceof BotConsentOutdatedError) {
        // The listing changed after it was shown. Refresh it so the next attempt shows
        // (and consents to) what the server will actually record.
        await loadCatalog().then(() => { catalogVersion += 1; }).catch(() => undefined);
        installError = t('bot_consent_outdated', 'Bu botun istediği izinler değişti. İzinleri yeniden inceleyip tekrar dene.');
      } else {
        installError = safeApiErrorMessage(cause, next ? t("ui_bot_kurulamadi", "Bot kurulamadı.") : t("ui_bot_kaldirilamadi", "Bot kaldırılamadı."), { report: true });
      }
      await loadInstallState();
    } finally { installBusyId = ''; }
  }

  function onTabKey(e: KeyboardEvent, index: number): void {
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % MARKETPLACE_TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + MARKETPLACE_TABS.length) % MARKETPLACE_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = MARKETPLACE_TABS.length - 1;
    else return;
    e.preventDefault();
    activeTab = MARKETPLACE_TABS[next].id;
    const tabs = (e.currentTarget as HTMLElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[next]?.focus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      if (detailBot) detailBot = null;
      else close();
    }
  }

  async function initializeMarketplace(): Promise<void> {
    ready = false;
    installError = '';
    const results = await Promise.allSettled([loadCatalog(), fetchLoadedPlugins(), loadInstallState()]);
    catalogVersion += 1;
    const catalogFailure = results[0].status === 'rejected' ? results[0].reason : null;
    const pluginFailure = results[1].status === 'rejected' ? results[1].reason : null;
    if (catalogFailure) {
      installError = safeApiErrorMessage(catalogFailure, t("ui_bot_katalogu_yuklenemedi_tekrar_deneyebilirsin", "Bot kataloğu yüklenemedi. Tekrar deneyebilirsin."), { report: true });
    } else if (pluginFailure && !installError) {
      // Plugin discovery is secondary; keep the bot catalog usable and surface
      // one bounded status instead of leaving an unhandled rejection behind.
      installError = safeApiErrorMessage(pluginFailure, t("ui_plugin_listesi_yuklenemedi", "Plugin listesi yüklenemedi."), { report: true });
    }
    ready = true;
  }

  function onServerContextChange(): void {
    installedIds = new Set();
    grants = new Map();
    canManage = false;
    installBusyId = '';
    installError = '';
    void loadInstallState();
  }

  onMount(() => {
    injectStyles();
    window.addEventListener('keydown', onKey);
    document.addEventListener('bridge:load-channels', onServerContextChange);
    void initializeMarketplace();
  });

  onDestroy(() => {
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('bridge:load-channels', onServerContextChange);
  });
</script>

<div id="bot-marketplace-overlay" style="display:none" aria-hidden="true"></div>

<div
  id="bot-marketplace-modal"
  role="presentation"
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    class="mp-panel"
    role="dialog"
    aria-modal="true"
    aria-label={t('markup_bot_marketplace_0a53097')}
    tabindex="-1"
    use:focusTrap={{ initialFocus: '.mp-search' }}
  >
    <header class="mp-header">
      <div class="mp-header-top">
        <div>
          <div class="mp-title">{t('markup_bot_marketplace_0a53097', "Bot Marketplace")}</div>
          <p class="mp-subtitle">
            {t('markup_sunucunu_guclendir_2666e95', "Sunucunu güçlendir")}
            <span class="mp-badge">{t('market_bot_count', undefined, { count: catalogItems.length })}</span>
          </p>
        </div>
        <button type="button" class="mp-close" onclick={close} aria-label={t('close')}>X</button>
      </div>
      <div class="mp-controls">
        <input class="mp-search" id="mp-search" type="search" placeholder={t('attr_bot_ara_83496d9', "Bot ara...")} aria-label={t('attr_bot_ara_0294678', "Bot ara")} bind:value={searchQuery} />
        <select class="mp-sort" aria-label={t("market_sort_bots")} bind:value={sortBy}>
          <option value="installs">{t('markup_en_populer_438be55', "En Popüler")}</option>
          <option value="rating">{t('markup_en_yuksek_puan_367752e', "En Yüksek Puan")}</option>
          <option value="name">A-Z</option>
        </select>
      </div>
      <div class="mp-tabs" role="tablist" aria-label={t("market_view")}>
        {#each MARKETPLACE_TABS as tab, index}
          <button
            type="button"
            role="tab"
            class="mp-tab"
            class:active={activeTab === tab.id}
            aria-selected={activeTab === tab.id}
            tabindex={activeTab === tab.id ? 0 : -1}
            onclick={() => { activeTab = tab.id; }}
            onkeydown={(e) => onTabKey(e, index)}
          >{tab.id === 'plugins' ? `${tab.label} (${plugins.length})` : tab.label}</button>
        {/each}
      </div>
    </header>

    <div class="mp-body">
      {#if installError}
        <div class="mp-empty-t" role="alert">
          <span>{installError}</span>
          <button type="button" class="mp-btn-detail" onclick={() => void initializeMarketplace()}>{t('retry')}</button>
        </div>
      {/if}
      <aside class="mp-sidebar" id="bm-categories">
        <p class="mp-sidebar-lbl">{t('markup_kategoriler_5df5fd5', "Kategoriler")}</p>
        {#each CATEGORIES as cat}
          <button
            type="button"
            class="mp-cat"
            class:active={activeCategory === cat.id}
            aria-pressed={activeCategory === cat.id}
            onclick={() => { activeCategory = cat.id; }}
          >
            {cat.icon} {t(cat.labelKey)}
            <span class="cc">{cat.id === '' ? catalogItems.length : catalogItems.filter(b => b.category === cat.id).length}</span>
          </button>
        {/each}
      </aside>

      <div class="mp-grid-wrap" id="mp-grid-wrap">
        {#if !ready}
          <p class="mp-empty-t">{t('sso_loading', 'Yükleniyor…')}</p>
        {:else if activeTab === 'plugins'}
          <div class="mp-grid">
            {#if plugins.length === 0}
              <p class="mp-empty-t">{t('markup_yuklu_plugin_yok_034cc98', "Yüklü plugin yok")}</p>
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
              <p class="mp-empty-t" id="bm-results-info">{t('bmp_no_results', 'Sonuç bulunamadı')}</p>
            {:else}
              {#each filtered as bot (bot.id)}
                <article class="mp-card" data-bot-id={bot.id}>
                  <div class="mp-card-top">
                    <span class="mp-card-av">{bot.avatar}</span>
                    <div>
                      <h3 class="mp-card-name">{bot.name}</h3>
                      <p class="mp-card-meta">{t('market_by_author', undefined, { author: bot.author ?? '' })}</p>
                    </div>
                  </div>
                  <p class="mp-card-desc">{bot.description}</p>
                  <div class="mp-card-tags">
                    {#each bot.tags.slice(0, 2) as tag}
                      <span class="mp-tag" style:--tag-color={tagColor(tag)}>{tag}</span>
                    {/each}
                  </div>
                  <p class="mp-rating">{stars(bot.rating)} {bot.rating}</p>
                  <div class="mp-card-foot">
                    <button type="button" class="mp-btn-detail" onclick={() => { detailBot = bot; }}>{t('markup_detaylar_2638108', "Detaylar")}</button>
                    {#if bot.installable && canManage}
                      {#if needsReconsent(bot)}
                        <button type="button" class="mp-btn-inst" disabled={installBusyId === bot.id} onclick={() => void mutateInstall(bot, true)}>{installBusyId === bot.id ? t("surface_isleniyor_33889c") : t('bot_review_new_permissions', 'Yeni izinleri incele')}</button>
                      {:else}
                        <button type="button" class="mp-btn-inst" disabled={installBusyId === bot.id} onclick={() => void mutateInstall(bot, !installedIds.has(bot.id))}>{installBusyId === bot.id ? t("surface_isleniyor_33889c") : installedIds.has(bot.id) ? t("ui_kaldir") : t('market_install', 'Kur')}</button>
                      {/if}
                    {:else}
                      <button type="button" class="mp-btn-inst" disabled title={bot.installable ? t("surface_sunucuyu_yonetme_yetkisi_gerekli_3d2b95") : t("surface_bu_katalog_kayd_henuz_cal_st_r_labilir_bir_b_8d7d9b")}>{t("market_install_unavailable")}</button>
                    {/if}
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
  <div id="mp-detail-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) detailBot = null; }}>
    <div class="mp-det-panel" role="dialog" aria-modal="true" aria-label={detailBot.name} tabindex="-1" use:focusTrap={{ initialFocus: '.mp-det-cls' }}>
      <div class="mp-det-hero">
        <span class="mp-det-av">{detailBot.avatar}</span>
        <h2 class="mp-det-name">{detailBot.name}</h2>
      </div>
      <div class="mp-det-body">
        <p class="mp-det-desc">{detailBot.longDescription}</p>
        <div class="mp-cmds">
          {#each detailBot.commands as cmd}<span class="mp-cmd">{cmd}</span>{/each}
        </div>
        <section class="mp-perms">
          <h3 class="mp-perms-h">{t('bot_perms_heading', 'Bu bot şunları yapabilir')}</h3>
          <ul class="mp-perms-list">
            {#each requestedScopesOf(detailBot) as scope (scope)}<li>{describeBotPermission(scope, t)}</li>{/each}
            {#each detailBot.unsupportedPermissions ?? [] as permission (permission)}<li class="mp-perm-unsupported">{describeBotPermission(permission, t)}</li>{/each}
          </ul>
        </section>
        <p class="mp-trust" class:verified={detailBot.authorVerified === true}>{t('market_by_author', undefined, { author: detailBot.author ?? '' })} · {trustLabel(detailBot)}</p>
      </div>
      <footer class="mp-det-foot">
        <button type="button" class="mp-det-cls" onclick={() => { detailBot = null; }}>{t('close')}</button>
        {#if detailBot.installable && canManage}
          {@const selectedBot = detailBot}
          {#if needsReconsent(selectedBot)}
            <button type="button" class="mp-inst-big" disabled={installBusyId === selectedBot.id} onclick={() => void mutateInstall(selectedBot, true)}>{installBusyId === selectedBot.id ? t("surface_isleniyor_33889c") : t('bot_review_new_permissions', 'Yeni izinleri incele')}</button>
          {:else}
            <button type="button" class="mp-inst-big" disabled={installBusyId === selectedBot.id} onclick={() => void mutateInstall(selectedBot, !installedIds.has(selectedBot.id))}>{installBusyId === selectedBot.id ? t("surface_isleniyor_33889c") : installedIds.has(selectedBot.id) ? t("surface_sunucudan_kald_r_1220d3") : t("market_install_to_server")}</button>
          {/if}
        {:else}
          <button type="button" class="mp-inst-big" disabled>{t("market_install_unavailable")}</button>
        {/if}
      </footer>
    </div>
  </div>
{/if}

<style>
  /* Final21 Phase 14. This component shipped with NO layout styles: bot-styles.ts
     injectStyles() is an empty function and the rules it once injected were never moved
     here, so the marketplace rendered as unstyled browser buttons stacked at the bottom
     of the page in a real browser.
     Tokens follow ServerEventsPanel.svelte. */
  #bot-marketplace-modal {
    position: fixed; inset: 0; z-index: var(--layer-modal);
    display: grid; place-items: center; padding: 24px;
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(8px);
  }
  .mp-panel {
    display: flex; flex-direction: column;
    width: min(1040px, 100%);
    height: min(760px, calc(var(--bridge-visual-viewport-height, 100dvh) - 48px));
    overflow: hidden;
    border: 1px solid var(--border-strong); border-radius: var(--radius-modal);
    background: var(--bg-2); box-shadow: var(--shadow-xl); color: var(--text-primary);
  }
  .mp-panel:focus { outline: none; }
  .mp-panel button, .mp-panel input, .mp-panel select, .mp-det-panel button { font: inherit; }

  .mp-header { display: grid; gap: 12px; padding: 16px 18px 0; border-bottom: 1px solid var(--border); }
  .mp-header-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .mp-title { font-size: var(--type-title, 16px); font-weight: 700; }
  .mp-subtitle { display: flex; align-items: center; gap: 8px; margin: 2px 0 0; color: var(--text-muted); font-size: var(--text-sm); }
  .mp-badge { padding: 1px 8px; border-radius: var(--radius-pill); background: var(--brand-muted); color: var(--text-primary); font-size: var(--text-xs); font-weight: 600; }
  .mp-close {
    flex: none; width: 32px; height: 32px; border: 1px solid var(--border); border-radius: var(--radius-control);
    background: var(--bg-3); color: var(--text-secondary); cursor: pointer;
  }
  .mp-close:hover { color: var(--text-primary); }
  .mp-controls { display: flex; gap: 8px; }
  .mp-search, .mp-sort {
    box-sizing: border-box; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: var(--radius-control);
    background: var(--bg-input); color: var(--text-primary);
  }
  .mp-search { flex: 1; min-width: 0; }
  .mp-sort { flex: none; }
  .mp-tabs { display: flex; gap: 2px; overflow-x: auto; }
  .mp-tab {
    padding: 8px 12px; border: 0; border-bottom: 2px solid transparent;
    background: none; color: var(--text-secondary); cursor: pointer; white-space: nowrap;
  }
  .mp-tab.active { border-bottom-color: var(--brand); color: var(--text-primary); font-weight: 600; }

  .mp-body {
    display: grid; grid-template-columns: 196px minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr);
    flex: 1; min-height: 0;
  }
  .mp-body > [role="alert"] {
    grid-column: 1 / -1; display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin: 12px 18px 0; padding: 9px 11px; border-radius: var(--radius-control);
    background: var(--danger-bg); color: var(--danger);
  }
  .mp-sidebar {
    grid-row: 2; display: flex; flex-direction: column; gap: 2px;
    padding: 14px 10px; overflow-y: auto; border-right: 1px solid var(--border);
  }
  .mp-sidebar-lbl { margin: 0 8px 6px; color: var(--text-muted); font-size: var(--text-xs); font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
  .mp-cat {
    display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 8px;
    border: 0; border-radius: var(--radius-control); background: none;
    color: var(--text-secondary); text-align: left; cursor: pointer;
  }
  .mp-cat:hover { background: var(--bg-3); color: var(--text-primary); }
  .mp-cat.active { background: var(--brand-muted); color: var(--text-primary); font-weight: 600; }
  .mp-cat .cc { margin-left: auto; color: var(--text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }

  .mp-grid-wrap { grid-row: 2; min-width: 0; padding: 16px 18px max(20px, env(safe-area-inset-bottom)); overflow-y: auto; }
  .mp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(232px, 1fr)); gap: 10px; }
  .mp-empty-t { grid-column: 1 / -1; margin: 0; padding: 28px; color: var(--text-muted); text-align: center; }

  .mp-feat-banner { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .mp-feat-card {
    display: grid; gap: 4px; padding: 14px; text-align: left; cursor: pointer;
    border: 1px solid var(--brand-border, var(--border)); border-radius: var(--radius-surface);
    background: var(--brand-bg-low, var(--bg-1)); color: var(--text-primary);
  }
  .mp-feat-name { font-weight: 700; }
  .mp-feat-desc { color: var(--text-secondary); font-size: var(--text-sm); }

  .mp-card {
    display: flex; flex-direction: column; gap: 8px; padding: 13px;
    border: 1px solid var(--border); border-radius: var(--radius-surface); background: var(--bg-1);
  }
  .mp-card-top { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .mp-card-av {
    display: grid; flex: none; place-items: center; width: 40px; height: 40px;
    border-radius: var(--radius-surface); background: var(--bg-3); font-size: 22px;
  }
  .mp-card-top > div { min-width: 0; }
  .mp-card-name { margin: 0; overflow: hidden; font-size: var(--text-base); text-overflow: ellipsis; white-space: nowrap; }
  .mp-card-meta { margin: 1px 0 0; overflow: hidden; color: var(--text-muted); font-size: var(--text-xs); text-overflow: ellipsis; white-space: nowrap; }
  .mp-card-desc {
    display: -webkit-box; margin: 0; overflow: hidden; color: var(--text-secondary); font-size: var(--text-sm);
    -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2;
  }
  .mp-card-tags { display: flex; flex-wrap: wrap; gap: 4px; }
  .mp-tag {
    --tag-color: var(--brand);
    padding: 1px 7px; border-radius: var(--radius-chip); font-size: var(--text-xs);
    background: color-mix(in srgb, var(--tag-color) 13%, transparent);
    color: var(--tag-color);
    border: 1px solid color-mix(in srgb, var(--tag-color) 27%, transparent);
  }
  .mp-rating { margin: 0; color: var(--text-muted); font-size: var(--text-xs); }
  .mp-card-foot { display: flex; gap: 6px; margin-top: auto; }
  .mp-btn-detail, .mp-det-cls {
    padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-control);
    background: var(--bg-3); color: var(--text-secondary); cursor: pointer;
  }
  .mp-btn-inst, .mp-inst-big {
    flex: 1; padding: 7px 10px; border: 0; border-radius: var(--radius-control);
    background: var(--brand); color: var(--text-on-solid); font-weight: 600; cursor: pointer;
  }

  #mp-detail-overlay {
    position: fixed; inset: 0; z-index: var(--layer-modal);
    display: grid; place-items: center; padding: 24px;
    background: color-mix(in srgb, var(--bg-0) 60%, transparent);
  }
  .mp-det-panel {
    display: flex; flex-direction: column; width: min(520px, 100%);
    max-height: min(680px, calc(var(--bridge-visual-viewport-height, 100dvh) - 48px));
    overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-modal);
    background: var(--bg-2); box-shadow: var(--shadow-xl); color: var(--text-primary);
  }
  .mp-det-panel:focus { outline: none; }
  .mp-det-hero { display: flex; align-items: center; gap: 12px; padding: 18px; border-bottom: 1px solid var(--border); }
  .mp-det-av { display: grid; place-items: center; width: 52px; height: 52px; border-radius: var(--radius-surface); background: var(--bg-3); font-size: 28px; }
  .mp-det-name { margin: 0; font-size: var(--type-title, 16px); }
  .mp-det-body { flex: 1; min-height: 0; padding: 16px 18px; overflow-y: auto; }
  .mp-det-desc { margin: 0; color: var(--text-secondary); line-height: 1.5; white-space: pre-line; }
  .mp-cmds { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
  .mp-cmd { padding: 2px 8px; border-radius: var(--radius-chip); background: var(--bg-3); font-family: var(--font-mono); font-size: var(--text-xs); }
  .mp-perms { margin-top: 16px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-surface); background: var(--bg-1); }
  .mp-perms-h { margin: 0 0 6px; font-size: var(--text-sm-p, 13px); font-weight: 600; }
  .mp-perms-list { margin: 0; padding-left: 18px; color: var(--text-secondary); font-size: var(--text-sm-p, 13px); line-height: 1.55; }
  .mp-perm-unsupported { color: var(--danger); }
  .mp-trust { margin: 10px 0 0; color: var(--text-muted); font-size: var(--text-sm); }
  .mp-trust.verified { color: var(--green); }
  .mp-det-foot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px max(12px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border); }
  .mp-inst-big { flex: none; }

  .mp-panel button:disabled, .mp-det-panel button:disabled { opacity: .55; cursor: not-allowed; }
  .mp-panel :is(button, input, select):focus-visible, .mp-det-panel button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  @media (max-width: 640px) {
    #bot-marketplace-modal, #mp-detail-overlay { padding: 0; }
    .mp-panel, .mp-det-panel { width: 100%; height: var(--bridge-visual-viewport-height, 100dvh); max-height: none; border-radius: 0; }
    .mp-header { padding-top: max(16px, env(safe-area-inset-top)); }
    .mp-body { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto minmax(0, 1fr); }
    .mp-sidebar { grid-row: 2; flex-direction: row; gap: 6px; padding: 10px 12px; overflow-x: auto; overflow-y: hidden; border-right: 0; border-bottom: 1px solid var(--border); }
    .mp-sidebar-lbl { display: none; }
    .mp-cat { flex: none; width: auto; border: 1px solid var(--border); white-space: nowrap; }
    .mp-grid-wrap { grid-row: 3; padding: 12px; }
    .mp-grid { grid-template-columns: minmax(0, 1fr); }
  }
</style>
