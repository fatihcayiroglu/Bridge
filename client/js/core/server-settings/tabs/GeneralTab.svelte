<!-- client/js/core/server-settings/tabs/GeneralTab.svelte -->
<!-- Sunucu adı, ikon, slug — vanilla openServerSettings formunun Svelte karşılığı -->
<script lang="ts">
  import type { ServerSettingsStore } from '../stores/serverSettingsStore';
  import { toast } from '../../utils.js';

  interface Props {
    store: ServerSettingsStore;
    onSaved?: () => void;
  }

  let { store, onSaved }: Props = $props();

  async function handleSave() {
    const ok = await store.saveGeneral();
    if (ok) {
      toast('Sunucu ayarları kaydedildi', 'success');
      onSaved?.();
    }
  }

  async function handleSlugSave() {
    await store.saveSlug();
  }
</script>

<div class="form-group">
  <label for="srv-name-input">Sunucu Adı</label>
  <input
    id="srv-name-input"
    class="input-field"
    maxlength="50"
    value={store.name}
    oninput={(e) => store.setName((e.currentTarget as HTMLInputElement).value)}
  />
</div>

<div class="form-group">
  <label for="srv-icon-input">Sunucu İkonu (emoji)</label>
  <input
    id="srv-icon-input"
    class="input-field"
    maxlength="8"
    value={store.icon}
    oninput={(e) => store.setIcon((e.currentTarget as HTMLInputElement).value)}
  />
</div>

<div class="form-group">
  <label for="srv-slug-input">
    🌐 Herkese Açık Profil URL'si
    <span class="srv-slug-hint">(opsiyonel)</span>
  </label>
  <div class="srv-slug-row">
    <span class="srv-slug-prefix">/s/</span>
    <input
      id="srv-slug-input"
      class="input-field"
      placeholder="sunucu-adim"
      maxlength="40"
      value={store.slug}
      oninput={(e) => store.setSlug((e.currentTarget as HTMLInputElement).value)}
    />
    <button type="button" class="btn" onclick={handleSlugSave}>Kaydet</button>
  </div>
  {#if store.slugPreview}
    <div id="srv-slug-preview" class="srv-slug-preview">{store.slugPreview}</div>
  {/if}
</div>

{#if store.error}
  <p class="srv-settings-error" role="alert">{store.error}</p>
{/if}

<div class="modal-footer srv-general-footer">
  <button type="button" class="btn btn-primary" disabled={store.saving} onclick={handleSave}>
    {store.saving ? 'Kaydediliyor…' : 'Kaydet'}
  </button>
</div>

<style>
  .srv-slug-hint { font-size: 11px; color: var(--text-muted); font-weight: 400; }
  .srv-slug-row { display: flex; gap: 8px; align-items: center; }
  .srv-slug-prefix { color: var(--text-muted); font-size: 13px; white-space: nowrap; }
  .srv-slug-preview { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .srv-settings-error { color: var(--red, #ed4245); font-size: 13px; margin: 8px 0 0; }
  .srv-general-footer { margin-top: 16px; }
</style>
