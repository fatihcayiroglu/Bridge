<!-- client/js/core/server-settings/tabs/GeneralTab.svelte -->
<!-- Sunucu adı, ikon, slug — vanilla openServerSettings formunun Svelte karşılığı -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
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
      toast(t('srv_saved', 'Sunucu ayarları kaydedildi'), 'success');
      onSaved?.();
    }
  }

  async function handleSlugSave() {
    if (await store.saveSlug()) toast(t('srv_slug_saved', 'Profil adresi kaydedildi'), 'success');
  }

  async function handleDiscoverySave() {
    if (await store.saveDiscovery()) toast(t('srv_discovery_saved', 'Keşif ayarları kaydedildi'), 'success');
  }

  const categories = $derived([
    ['gaming', '🎮', t('ui_discover_gaming', 'Oyun')],
    ['community', '👥', t('ui_discover_community', 'Topluluk')],
    ['tech', '💻', t('ui_discover_technology', 'Teknoloji')],
    ['education', '📚', t('ui_egitim', 'Eğitim')],
    ['art', '🎨', t('ui_discover_art', 'Sanat')],
    ['music', '🎵', t('ui_muzik', 'Müzik')],
    ['anime', '⛩️', t('ui_discover_anime', 'Anime')],
    ['science', '🔬', t('ui_discover_science', 'Bilim')],
    ['social', '💬', t('ui_discover_social', 'Sosyal')],
    ['other', '🌐', t('srv_category_other', 'Diğer')],
  ] as const);

</script>

<div class="form-group">
  <label for="srv-name-input">{t('gen_server_name', 'Sunucu Adı')}</label>
  <input
    id="srv-name-input"
    class="input-field"
    maxlength="50"
    value={store.name}
    oninput={(e) => store.setName((e.currentTarget as HTMLInputElement).value)}
  />
</div>

<div class="form-group">
  <label for="srv-icon-input">{t('gen_server_icon', 'Sunucu İkonu (emoji)')}</label>
  <input
    id="srv-icon-input"
    class="input-field"
    maxlength="8"
    value={store.icon}
    oninput={(e) => store.setIcon((e.currentTarget as HTMLInputElement).value)}
  />
</div>

<fieldset class="srv-section">
  <legend id="srv-slug-legend">{t('srv_public_profile_url', 'Herkese Açık Profil Adresi')}</legend>
  <div class="srv-inline-row">
    <!-- `legend` grubu adlandırır, içindeki alanı DEĞİL: ad açıkça bağlanır,
         yoksa ekran okuyucu etiketsiz bir metin alanı okur (axe `label`). -->
    <input
      id="srv-slug-input"
      class="input-field"
      maxlength="32"
      autocomplete="off"
      value={store.slug}
      aria-labelledby="srv-slug-legend"
      aria-describedby="srv-slug-hint"
      oninput={(e) => store.setSlug((e.currentTarget as HTMLInputElement).value)}
    />
    <button type="button" class="btn btn-secondary" disabled={store.slugSaving || !store.isSlugDirty()} onclick={handleSlugSave}>
      {store.slugSaving ? t('ui_saving') : t('save')}
    </button>
  </div>
  <p id="srv-slug-hint" class="srv-hint">{t('ui_slug_hint')}</p>
</fieldset>

<fieldset class="srv-section">
  <legend>{t('srv_discovery_title', 'Keşif ve Gizlilik')}</legend>
  <label class="srv-toggle-row" for="srv-discoverable-input">
    <input
      id="srv-discoverable-input"
      type="checkbox"
      checked={store.discoverable}
      onchange={(e) => store.setDiscoverable((e.currentTarget as HTMLInputElement).checked)}
    />
    <span>
      <strong>{t('srv_discoverable_label', 'Toplulukları Keşfet’te listele')}</strong>
      <small>{t('srv_discoverable_hint', 'Kapalıysa sunucu yalnız geçerli davet bağlantılarıyla bulunabilir ve katılınabilir.')}</small>
    </span>
  </label>

  <label for="srv-category-input">{t('srv_category_label', 'Kategori')}</label>
  <select
    id="srv-category-input"
    class="input-field"
    value={store.category}
    onchange={(e) => store.setCategory((e.currentTarget as HTMLSelectElement).value)}
  >
    {#each categories as [id, icon, label]}
      <option value={id}>{icon} {label}</option>
    {/each}
  </select>

  <div class="srv-section-actions">
    <button type="button" class="btn btn-secondary" disabled={store.discoverySaving || !store.isDiscoveryDirty()} onclick={handleDiscoverySave}>
      {store.discoverySaving ? t('ui_saving') : t('save')}
    </button>
  </div>
</fieldset>

{#if store.error}
  <p class="srv-settings-error" role="alert">{store.error}</p>
{/if}

<div class="modal-footer srv-general-footer">
  <button type="button" class="btn btn-primary" disabled={store.saving || !store.isDirty()} onclick={handleSave}>
    {store.saving ? t('ui_saving') : t('save')}
  </button>
</div>

<style>
  .srv-settings-error { color: var(--danger); font-size: 13px; margin: 8px 0 0; }
  .srv-general-footer { margin-top: 16px; }
  .srv-section { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-top: 16px; }
  .srv-section legend { padding: 0 6px; font-weight: 650; color: var(--text-1); }
  .srv-inline-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; }
  .srv-hint { margin: 6px 0 0; color: var(--text-3); font-size: 12px; }
  .srv-toggle-row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; cursor: pointer; }
  .srv-toggle-row input { margin-top: 3px; }
  .srv-toggle-row span { display: grid; gap: 3px; }
  .srv-toggle-row small { color: var(--text-3); line-height: 1.35; }
  .srv-section-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
</style>
