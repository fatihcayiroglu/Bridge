<!-- client/js/core/server-settings/tabs/MediaTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts banner/icon upload → Svelte 5 Runes  -->
<script lang="ts">
  import type { ServerSettingsStore } from '../stores/serverSettingsStore';
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { toast } from '../../utils.js';

  interface Props {
    store: ServerSettingsStore;
  }

  let { store }: Props = $props();

  const API = getAPI();

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
      const r = await apiFetch(`${API}/api/servers/${store.server._id}/banner`, { method: 'POST', body: fd });
      if (!r.ok) { const d = await r.json(); toast(d.error ?? 'Hata', 'error'); return; }
      const data = await r.json() as { bannerUrl: string };
      store.setBannerUrl(data.bannerUrl);
      toast('Banner güncellendi ✅', 'success');
    } finally {
      bannerUploading = false;
      input.value = '';
    }
  }

  async function removeBanner(): Promise<void> {
    const r = await apiFetch(`${API}/api/servers/${store.server._id}/banner`, { method: 'DELETE' });
    if (!r.ok) return;
    store.setBannerUrl(null);
    toast('Banner kaldırıldı', 'success');
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
      const r = await apiFetch(`${API}/api/servers/${store.server._id}/icon-image`, { method: 'POST', body: fd });
      if (!r.ok) { const d = await r.json(); toast(d.error ?? 'Hata', 'error'); return; }
      const data = await r.json() as { iconUrl: string };
      store.setIconUrl(data.iconUrl);
      toast('Sunucu ikonu güncellendi ✅', 'success');
    } finally {
      iconUploading = false;
      input.value = '';
    }
  }
</script>

<div class="media-tab">
  <!-- Banner -->
  <div class="form-group">
    <div class="form-label">Sunucu Banner'ı</div>
    <div
      class="media-banner-preview"
      style={store.bannerUrl
        ? `background-image: url('${API}${store.bannerUrl}');`
        : 'background: linear-gradient(135deg,#2d9cdb,#3ba55c);'}
    ></div>
    <div class="media-btn-row">
      <label class="btn" class:disabled={bannerUploading}>
        {bannerUploading ? 'Yükleniyor…' : '🖼 Banner Yükle'}
        <input id="server-banner-upload" type="file" accept="image/*" style="display:none" onchange={uploadBanner} />
      </label>
      {#if store.bannerUrl}
        <button type="button" class="btn btn-sm" onclick={removeBanner}>
          🗑 Kaldır
        </button>
      {/if}
    </div>
    <p class="media-hint">Max 8MB • 16:9 oran önerilir</p>
  </div>

  <!-- Icon image -->
  <div class="form-group">
    <div class="form-label">Sunucu İkonu (görsel)</div>
    <div class="media-icon-wrap">
      {#if store.iconUrl}
        <div
          class="media-icon-preview"
          style="background-image: url('{API}{store.iconUrl}');"
        ></div>
      {:else}
        <div class="media-icon-preview media-icon-preview--letter">
          {store.server.name?.[0] ?? '?'}
        </div>
      {/if}
      <label class="btn" class:disabled={iconUploading}>
        {iconUploading ? 'Yükleniyor…' : '📷 İkon Yükle'}
        <input id="server-icon-upload" type="file" accept="image/*" style="display:none" onchange={uploadIcon} />
      </label>
    </div>
    <p class="media-hint">Max 8MB • Kare, PNG/WebP önerilir</p>
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
    background: var(--brand, #5865f2);
    color: #fff;
  }

  label.btn.disabled { opacity: .5; pointer-events: none; }
</style>
