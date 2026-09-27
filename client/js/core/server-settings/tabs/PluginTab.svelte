<!-- client/js/core/server-settings/tabs/PluginTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openPluginManager → Svelte 5 Runes   -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';

  interface Plugin {
    _id?:        string;
    id?:         string;
    name?:       string;
    version?:    string;
    author?:     string;
    description?: string;
  }

  const API = getAPI();

  let plugins = $state<Plugin[]>([]);
  let loading = $state(true);
  let error   = $state(false);

  $effect(() => {
    apiFetch(`${API}/api/plugins`)
      .then(async r => {
        if (!r.ok) throw new Error(t('plugin_list_failed_status', 'Plugin listesi alınamadı ({status})', { status: r.status }));
        const data: unknown = await r.json();
        if (!Array.isArray(data)) throw new Error(t("ui_gecersiz_plugin_listesi", "Geçersiz plugin listesi"));
        return data as Plugin[];
      })
      .then((data: Plugin[]) => { plugins = data; })
      .catch(() => { error = true; })
      .finally(() => { loading = false; });
  });
</script>

<div class="plugin-tab">
  <p class="plugin-hint">{t('plg_active', 'Bridge örneğinde yüklü aktif plugin\'ler')}</p>

  {#if loading}
    <div class="plugin-status">{t('sso_loading', 'Yükleniyor…')}</div>
  {:else if error}
    <div class="plugin-status plugin-status--error">{t('plg_failed', 'Plugin listesi alınamadı')}</div>
  {:else if !plugins.length}
    <div class="plugin-status">{t('plg_none', 'Yüklü plugin bulunamadı')}</div>
  {:else}
    <div class="plugin-list">
      {#each plugins as p (p._id ?? p.id)}
        <div class="plugin-item">
          <div class="plugin-icon">🧩</div>
          <div class="plugin-info">
            <div class="plugin-name">{p.name ?? p.id}</div>
            <div class="plugin-meta">
              v{p.version ?? '?'} · {p.author ?? t('ui_unknown')}
            </div>
            {#if p.description}
              <div class="plugin-desc">{p.description}</div>
            {/if}
          </div>
          <span class="plugin-badge">{t('plg_active_badge', 'AKTİF')}</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="plugin-dev-note">
    {t('markup_plugin_eklemek_icin_dab7599', "💡 Plugin eklemek için")} <code>plugins/</code> {t('markup_klasorune_yeni_bir_dizin_ekleyin_ve_sunucuyu_yen_a43906a', "klasörüne yeni bir dizin ekleyin ve sunucuyu yeniden başlatın.")}
    <a
      href="https://github.com/bridge/bridge/blob/main/plugins/README.md"
      target="_blank"
      rel="noopener"
      class="plugin-dev-link"
    >{t('plg_guide', '📖 Plugin Geliştirme Kılavuzu →')}</a>
  </div>
</div>

<style>
  .plugin-hint  { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
  .plugin-status {
    text-align: center; padding: 20px; color: var(--text-muted); font-size: 13px;
  }
  .plugin-status--error { color: var(--red, #e05260); }
  .plugin-list  { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .plugin-item  {
    background: var(--bg-1);
    border-radius: 10px;
    padding: 14px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .plugin-icon  { font-size: 28px; flex-shrink: 0; }
  .plugin-info  { flex: 1; min-width: 0; }
  .plugin-name  { font-weight: 700; font-size: 14px; }
  .plugin-meta  { font-size: 11px; color: var(--brand, #2d9cdb); margin-bottom: 4px; }
  .plugin-desc  { font-size: 12px; color: var(--text-muted); }
  .plugin-badge {
    background: var(--green, #3ba55c);
    color: var(--text-on-solid);
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 10px;
    flex-shrink: 0;
  }
  .plugin-dev-note {
    background: var(--bg-1);
    border-radius: 8px;
    padding: 12px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .plugin-dev-note code {
    background: var(--bg-3);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .plugin-dev-link {
    color: var(--brand, #2d9cdb);
    display: block;
    margin-top: 4px;
  }
</style>
