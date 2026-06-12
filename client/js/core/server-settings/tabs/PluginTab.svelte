<!-- client/js/core/server-settings/tabs/PluginTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openPluginManager → Svelte 5 Runes   -->
<script lang="ts">
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
      .then(r => (r.ok ? r.json() : []))
      .then((data: Plugin[]) => { plugins = data; })
      .catch(() => { error = true; })
      .finally(() => { loading = false; });
  });
</script>

<div class="plugin-tab">
  <p class="plugin-hint">Sunucuda yüklü aktif plugin'ler</p>

  {#if loading}
    <div class="plugin-status">Yükleniyor…</div>
  {:else if error}
    <div class="plugin-status plugin-status--error">Plugin listesi alınamadı</div>
  {:else if !plugins.length}
    <div class="plugin-status">Yüklü plugin bulunamadı</div>
  {:else}
    <div class="plugin-list">
      {#each plugins as p (p._id ?? p.id)}
        <div class="plugin-item">
          <div class="plugin-icon">🧩</div>
          <div class="plugin-info">
            <div class="plugin-name">{p.name ?? p.id}</div>
            <div class="plugin-meta">
              v{p.version ?? '?'} · {p.author ?? 'Bilinmeyen'}
            </div>
            {#if p.description}
              <div class="plugin-desc">{p.description}</div>
            {/if}
          </div>
          <span class="plugin-badge">AKTİF</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="plugin-dev-note">
    💡 Plugin eklemek için <code>plugins/</code> klasörüne yeni bir dizin ekleyin
    ve sunucuyu yeniden başlatın.
    <a
      href="https://github.com/bridge/bridge/blob/main/plugins/README.md"
      target="_blank"
      rel="noopener"
      class="plugin-dev-link"
    >📖 Plugin Geliştirme Kılavuzu →</a>
  </div>
</div>

<style>
  .plugin-hint  { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
  .plugin-status {
    text-align: center; padding: 20px; color: var(--text-muted); font-size: 13px;
  }
  .plugin-status--error { color: var(--red, #ed4245); }
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
  .plugin-meta  { font-size: 11px; color: var(--brand, #5865f2); margin-bottom: 4px; }
  .plugin-desc  { font-size: 12px; color: var(--text-muted); }
  .plugin-badge {
    background: var(--green, #3ba55c);
    color: #fff;
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
    color: var(--brand, #5865f2);
    display: block;
    margin-top: 4px;
  }
</style>
