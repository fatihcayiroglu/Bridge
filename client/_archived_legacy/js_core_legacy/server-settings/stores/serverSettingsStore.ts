// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ServerSettingsStorePanel.svelte
//              client/js/core/serverSettingsStore-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/server-settings/stores/serverSettingsStore.ts
// Sunucu ayarları modal state — Svelte 5 runes

import { getAPI } from '../../globals.js';
import { apiFetch } from '../../api-fetch.js';
import { BridgeRegistry } from '../../bridge-registry.js';

export interface ServerSummary {
  _id: string;
  name: string;
  icon?: string;
  iconUrl?: string;
  bannerUrl?: string;
}

export function getCurrentServerFromRegistry(): ServerSummary | null {
  return BridgeRegistry.get('getCurrentServer') as ServerSummary | null;
}

export function createServerSettingsStore(server: ServerSummary) {
  let name        = $state(server.name);
  let icon        = $state(server.icon ?? '🌐');
  let slug        = $state('');
  let slugPreview = $state('');
  let saving      = $state(false);
  let error       = $state<string | null>(null);
  // Sprint 114: media state (banner + icon image) — MediaTab kullanır
  let bannerUrl   = $state<string | null>(server.bannerUrl ?? null);
  let iconUrl     = $state<string | null>(server.iconUrl  ?? null);

  const API = getAPI();

  async function loadSlug(): Promise<void> {
    try {
      const r = await apiFetch(`${API}/api/servers/${server._id}/slug`);
      if (!r.ok) return;
      const data = await r.json() as { slug?: string };
      if (data.slug) {
        slug = data.slug;
        slugPreview = `Profil: ${window.location.origin}/s/${data.slug}`;
      }
    } catch { /* sessiz */ }
  }

  async function saveGeneral(): Promise<boolean> {
    saving = true;
    error = null;
    try {
      const trimmed = name.trim();
      if (!trimmed) {
        error = 'Sunucu adı boş olamaz';
        return false;
      }
      const r = await apiFetch(`${API}/api/servers/${server._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, icon: icon.trim() }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        error = (d as { error?: string }).error ?? 'Kaydetme başarısız';
        return false;
      }
      const updated = await r.json() as ServerSummary;
      document.getElementById('sidebar-server-name')!.textContent = updated.name;
      document.querySelector(`.server-icon[data-id="${updated._id}"]`)
        ?.setAttribute('data-tip', updated.name);
      return true;
    } finally {
      saving = false;
    }
  }

  async function saveSlug(): Promise<boolean> {
    saving = true;
    error = null;
    try {
      const r = await apiFetch(`${API}/api/servers/${server._id}/slug`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: slug.trim() }),
      });
      const data = await r.json() as { slug?: string; error?: string };
      if (!r.ok) {
        error = data.error ?? 'Slug kaydedilemedi';
        return false;
      }
      slug = data.slug ?? slug;
      slugPreview = `Profil: ${window.location.origin}/s/${slug}`;
      return true;
    } finally {
      saving = false;
    }
  }

  return {
    get name()        { return name; },
    get icon()        { return icon; },
    get slug()        { return slug; },
    get slugPreview() { return slugPreview; },
    get saving()      { return saving; },
    get error()       { return error; },
    get apiBase()     { return API; },
    get server()      { return server; },
    get bannerUrl()   { return bannerUrl; },
    get iconUrl()     { return iconUrl; },
    setName(v: string)             { name = v; },
    setIcon(v: string)             { icon = v; },
    setSlug(v: string)             { slug = v.toLowerCase().replace(/[^a-z0-9-]/g, ''); },
    setBannerUrl(v: string | null) { bannerUrl = v; },
    setIconUrl(v: string | null)   { iconUrl   = v; },
    loadSlug,
    saveGeneral,
    saveSlug,
  };
}

export type ServerSettingsStore = ReturnType<typeof createServerSettingsStore>;
