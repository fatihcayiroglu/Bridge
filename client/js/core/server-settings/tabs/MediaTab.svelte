<!-- client/js/core/server-settings/tabs/MediaTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts banner/icon upload → Svelte 5 Runes  -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { isStillCurrentServer, type ServerSettingsStore } from '../stores/serverSettingsStore';
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { safeApiErrorMessage } from '../../api-error.ts';
  import { toast } from '../../utils.js';
  import { resolveLocalAssetUrl } from '../../local-asset-url.js';

  interface Props {
    store: ServerSettingsStore;
  }

  let { store }: Props = $props();

  const API = getAPI();

  function mediaAssetUrl(value: unknown): string {
    return resolveLocalAssetUrl(value, API, window.location.origin);
  }

  // C1.6 — BAYAT SUNUCU KAPISI. `store.server._id` mağaza kurulurken
  // yakalanır; kullanıcı modal açıkken sunucu değiştirirse yükleme/silme
  // ESKİ sunucuya giderdi. Ayrıca kimliksiz sunucu `/api/servers/undefined/...`
  // isteği üretemez.
  function mediaServerId(): string | null {
    const id = String(store.server?._id ?? '');
    if (!id || !isStillCurrentServer(id)) {
      store.setError(t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.'));
      return null;
    }
    return id;
  }


  let bannerUploading = $state(false);
  let iconUploading   = $state(false);

  // ── Banner ─────────────────────────────────────────────────────────────────
  async function uploadBanner(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file  = input.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Max 8MB!', 'error'); input.value = ''; return; }

    bannerUploading = true;
    try {
      const fd = new FormData();
      fd.append('banner', file);
      const sid = mediaServerId(); if (!sid) return;
      const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(sid)}/banner`, { method: 'POST', body: fd });
      if (!r.ok) { toast(safeApiErrorMessage(r, t("ui_banner_yuklenemedi", "Banner yüklenemedi."), { report: true }), 'error'); return; }
      const data = await r.json() as { bannerUrl: string };
      store.setBannerUrl(data.bannerUrl);
      toast(t('srv_banner_ok', 'Banner güncellendi ✅'), 'success');
    } catch {
      toast(t('srv_banner_failed', 'Banner yüklenemedi'), 'error');
    } finally {
      bannerUploading = false;
      input.value = '';
    }
  }

  async function removeBanner(): Promise<void> {
    const sid = mediaServerId(); if (!sid) return;
    try {
      const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(sid)}/banner`, { method: 'DELETE' });
      if (!r.ok) {
        toast(safeApiErrorMessage(r, t('srv_banner_delete_failed', 'Banner kaldırılamadı'), { report: true }), 'error');
        return;
      }
      // The store's canonical empty banner is '' (see the initial state), not
      // null; passing null quietly violated the declared `bannerUrl: string`.
      store.setBannerUrl('');
      toast(t('srv_banner_del', 'Banner kaldırıldı'), 'success');
    } catch {
      toast(t('srv_banner_delete_failed', 'Banner kaldırılamadı'), 'error');
    }
  }

  // ── Icon ───────────────────────────────────────────────────────────────────
  async function uploadIcon(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file  = input.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('Max 8MB!', 'error'); input.value = ''; return; }

    iconUploading = true;
    try {
      const fd = new FormData();
      fd.append('icon', file);
      const sid = mediaServerId(); if (!sid) return;
      const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(sid)}/icon-image`, { method: 'POST', body: fd });
      if (!r.ok) { toast(safeApiErrorMessage(r, t("ui_sunucu_ikonu_yuklenemedi", "Sunucu ikonu yüklenemedi."), { report: true }), 'error'); return; }
      const data = await r.json() as { iconUrl: string };
      store.setIconUrl(data.iconUrl);
      toast(t('srv_icon_ok', 'Sunucu ikonu güncellendi ✅'), 'success');
    } catch {
      toast(t('srv_icon_failed', 'Sunucu ikonu yüklenemedi'), 'error');
    } finally {
      iconUploading = false;
      input.value = '';
    }
  }
</script>

<div class="media-tab">
  <!-- Banner -->
  <div class="form-group">
    <div class="form-label">{t('med_banner', 'Sunucu Banner\'ı')}</div>
    <div
      class="media-banner-preview"
      style={mediaAssetUrl(store.bannerUrl)
        ? `background-image: url("${mediaAssetUrl(store.bannerUrl)}");`
        : 'background: linear-gradient(135deg,#2d9cdb,#3ba55c);'}
    ></div>
    <div class="media-btn-row">
      <label class="btn" class:disabled={bannerUploading}>
        {bannerUploading ? t("loading") : t("surface_banner_yukle_408299")}
        <input id="server-banner-upload" type="file" accept="image/*" style="display:none" onchange={uploadBanner} />
      </label>
      {#if store.bannerUrl}
        <button type="button" class="btn btn-sm" onclick={removeBanner}>
          {t('ui_kaldir')}
        </button>
      {/if}
    </div>
    <p class="media-hint">{t('med_banner_hint', 'Max 8MB • 16:9 oran önerilir')}</p>
  </div>

  <!-- Icon image -->
  <div class="form-group">
    <div class="form-label">{t('med_icon', 'Sunucu İkonu (görsel)')}</div>
    <div class="media-icon-wrap">
      {#if mediaAssetUrl(store.iconUrl)}
        <div
          class="media-icon-preview"
          style:background-image={`url("${mediaAssetUrl(store.iconUrl)}")`}
        ></div>
      {:else}
        <div class="media-icon-preview media-icon-preview--letter">
          {store.server?.name?.[0] ?? '?'}
        </div>
      {/if}
      <label class="btn" class:disabled={iconUploading}>
        {iconUploading ? t("loading") : t("surface_ikon_yukle_1e806f")}
        <input id="server-icon-upload" type="file" accept="image/*" style="display:none" onchange={uploadIcon} />
      </label>
    </div>
    <p class="media-hint">{t('med_icon_hint', 'Max 8MB • Kare, PNG/WebP önerilir')}</p>
  </div>
</div>

<style>
  .media-banner-preview {
    width: 100%; height: 80px;
    border-radius: 8px;
    background-size: cover;
    background-position: center;
    margin-bottom: 8px;
  }
  .media-btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .media-hint    { font-size: 11px; color: var(--text-muted); margin: 4px 0 0; }

  .media-icon-wrap { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
  .media-icon-preview {
    width: 48px; height: 48px;
    border-radius: 12px;
    background-size: cover;
    background-position: center;
    background-color: var(--bg-3);
    flex-shrink: 0;
  }
  .media-icon-preview--letter {
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; font-weight: 700;
    background: var(--brand, #2d9cdb);
    color: var(--text-on-solid);
  }

  label.btn.disabled { opacity: .5; pointer-events: none; }
</style>
