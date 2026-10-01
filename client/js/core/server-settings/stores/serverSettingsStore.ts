import { writable } from 'svelte/store';
import { BridgeRegistry } from '../../bridge-registry.js';
import { t } from '../../i18n/index';
import { safeApiErrorMessage } from '../../api-error.ts';

export type ServerSettingsTab = 'general' | 'roles' | 'channels' | 'media' | 'emoji' | 'webhooks' | 'audit' | 'plugins' | string;
export interface ServerSettingsServer {
  id?: string;
  _id?: string;
  name?: string;
  icon?: string | null;
  banner?: string | null;
  slug?: string | null;
  vanityUrl?: string | null;
  discoverable?: boolean | number;
  category?: string | null;
  /** P6: false = this server's content is never sent to an AI provider. */
  aiEnabled?: boolean;
  [key: string]: unknown;
}
export interface ServerSettingsStore {
  serverId: string;
  server: ServerSettingsServer;
  activeTab: ServerSettingsTab;
  error: string | null;
  name: string;
  icon: string;
  slug: string;
  slugPreview: string;
  slugSaving: boolean;
  discoverable: boolean;
  category: string;
  discoverySaving: boolean;
  aiEnabled: boolean;
  aiSaving: boolean;
  bannerUrl: string;
  iconUrl: string;
  saving: boolean;
  setTab(tab: ServerSettingsTab): void;
  setError(error: string | null): void;
  setName(value: string): void;
  setIcon(value: string): void;
  setSlug(value: string): void;
  setDiscoverable(value: boolean): void;
  setCategory(value: string): void;
  setAiEnabled(value: boolean): void;
  setBannerUrl(value: string): void;
  setIconUrl(value: string): void;
  saveGeneral(): Promise<boolean>;
  isDirty(): boolean;
  loadSlug(): Promise<void>;
  saveSlug(): Promise<boolean>;
  isSlugDirty(): boolean;
  saveDiscovery(): Promise<boolean>;
  isDiscoveryDirty(): boolean;
  saveAi(): Promise<boolean>;
  isAiDirty(): boolean;
  reload(): Promise<void>;
  subscribe: ReturnType<typeof writable<Record<string, unknown>>>['subscribe'];
  [key: string]: unknown;
}

/**
 * Sunucu Ayarları için TEK kanonik geçerli-sunucu çözümleyicisi.
 *
 * Eskiden sabit `null` döndüren bir taslaktı; sonuç olarak
 * `ServerSettingsModal` içindeki `store` HER ZAMAN null kalıyor ve modal
 * "Sunucu seçilmedi." ekranından öteye geçemiyordu — yani Sunucu Ayarları
 * hiçbir zaman gerçek bir ürün yüzeyi olamıyordu.
 *
 * `AppState.svelte:60` kaydı `getCurrentServer` adını bir GETTER FONKSİYONU
 * olarak tutar (`() => currentServer`). Bu yüzden `BridgeRegistry.get(...)`
 * fonksiyonun KENDİSİNİ döndürür; değeri almak için `call(...)` gerekir.
 * Sekmeler bu ayrımı kaçırdığı için `server._id` `undefined` oluyordu.
 *
 * İkinci bir sunucu-seçim durumu YARATILMAZ: kaynak yalnızca kanonik
 * uygulama durumudur.
 */
export function getCurrentServerFromRegistry(): ServerSettingsServer | null {
  const server = BridgeRegistry.call<ServerSettingsServer | null>('getCurrentServer');
  if (!server || typeof server !== 'object') return null;
  const id = String((server as { _id?: unknown; id?: unknown })._id
    ?? (server as { id?: unknown }).id ?? '');
  return id ? (server as ServerSettingsServer) : null;
}

/**
 * C1.6–C1.9 — PAYLAŞILAN BAYAT-SUNUCU KAPISI.
 *
 * Sunucu Ayarları sekmeleri geçerli sunucuyu AÇILIŞTA bir kez çözer. Kullanıcı
 * modal açıkken başka bir sunucuya geçerse, o yakalanmış kimlikle yapılan her
 * mutasyon YANLIŞ sunucuya gider. Arka uç yetkiyi doğrular; ancak her iki
 * sunucunun da sahibi olan bir kullanıcıda bu sessizce yanlış sunucuyu
 * değiştirebilirdi.
 *
 * `true` yalnızca verilen kimlik HÂLÂ geçerli sunucuysa döner (fail-closed:
 * sunucu çözülemiyorsa `false`).
 */
export function isStillCurrentServer(serverId: string): boolean {
  if (!serverId) return false;
  const current = getCurrentServerFromRegistry();
  return Boolean(current) && String(current!._id ?? current!.id ?? '') === serverId;
}

export function createServerSettingsStore(input: string | ServerSettingsServer = ''): ServerSettingsStore {
  const server = typeof input === 'string' ? { id: input, _id: input, name: '' } : input;
  const serverId = String(server._id ?? server.id ?? '');
  const canonicalCategory = (value: unknown): string => {
    const raw = String(value ?? '').trim().toLowerCase();
    if (raw === 'edu') return 'education';
    return ['gaming','music','art','tech','education','community','anime','science','social','other'].includes(raw)
      ? raw : 'other';
  };
  const initial = {
    serverId,
    server,
    activeTab: 'general',
    error: null,
    name: String(server.name ?? ''),
    icon: String(server.icon ?? ''),
    slug: String(server.slug ?? server.vanityUrl ?? ''),
    slugPreview: '',
    slugSaving: false,
    discoverable: server.discoverable === true || server.discoverable === 1,
    category: canonicalCategory(server.category),
    discoverySaving: false,
    // P6: absent (a pre-078 row) or true = allowed; only an explicit false is "off".
    aiEnabled: server.aiEnabled !== false,
    aiSaving: false,
    bannerUrl: String(server.banner ?? ''),
    iconUrl: String(server.icon ?? ''),
    saving: false,
  } satisfies Record<string, unknown>;
  const state = writable<Record<string, unknown>>(initial);
  const commit = (patch: Record<string, unknown>) => state.update((s: Record<string, unknown>) => ({ ...s, ...patch }));
  const store: ServerSettingsStore = {
    ...initial,
    activeTab: 'general',
    error: null,
    subscribe: state.subscribe,
    setTab(tab) { store.activeTab = tab; commit({ activeTab: tab }); },
    setError(error) { store.error = error; commit({ error }); },
    setName(value) { store.name = value; commit({ name: value }); },
    setIcon(value) { store.icon = value; commit({ icon: value, iconUrl: value }); },
    setSlug(value) { store.slug = value; store.slugPreview = value.trim().toLowerCase(); commit({ slug: value, slugPreview: store.slugPreview }); },
    setDiscoverable(value) { store.discoverable = value; commit({ discoverable: value }); },
    setCategory(value) { store.category = canonicalCategory(value); commit({ category: store.category }); },
    setAiEnabled(value) { store.aiEnabled = value; commit({ aiEnabled: value }); },
    setBannerUrl(value) { store.bannerUrl = value; commit({ bannerUrl: value }); },
    setIconUrl(value) { store.iconUrl = value; commit({ iconUrl: value }); },
    // ── C1.5 — GERÇEK KALICILIK ────────────────────────────────────────────
    //
    // Bu üç fonksiyon eskiden ağ isteği ATMADAN `true` döndürüyordu: kullanıcı
    // "Kaydedildi" görüyor, hiçbir şey kalıcı olmuyordu (sahte başarı).
    //
    // KANONİK SÖZLEŞME — `PATCH /api/servers/:sid` (routes/servers/core.ts:344)
    //   yetki : SAHİP-ONLY (403 aksi hâlde)
    //   alanlar: `name` (≤50, trim), `icon` (≤10, XSS doğrulamalı)
    //            (`mfaLevel` de kabul edilir ama Genel formunun konusu değildir)
    //   hata  : 400 (çok uzun / geçersiz / değişiklik yok), 403, 404
    //   yanıt : GÜNCELLENMİŞ sunucu nesnesi
    //
    // Slug ve keşif/gizlilik ayarları kendi API sözleşmelerine ve ayrı Kaydet
    // eylemlerine sahiptir; Genel Kaydet yalnız ad/ikon mutasyonunu taşır.
    async saveGeneral() {
      if (store.saving) return false;             // çift gönderim koruması

      // BAYAT SUNUCU KORUMASI: form açıldığından beri geçerli sunucu
      // değiştiyse, A'nın kirli değerleri B'ye ASLA yazılmaz.
      const current = getCurrentServerFromRegistry();
      if (!current || String(current._id ?? current.id ?? '') !== serverId) {
        store.setError(t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.'));
        return false;
      }
      if (!serverId) {                            // `/api/servers/undefined` engeli
        store.setError(t('srv_none', 'Sunucu seçilmedi.'));
        return false;
      }

      const name = String(store.name ?? '').trim();
      const icon = String(store.icon ?? '').trim();
      if (!name)             { store.setError(t('srv_name_req', 'Sunucu adı gerekli.')); return false; }
      if (name.length > 50)  { store.setError(t('srv_name_max', 'Sunucu adı en fazla 50 karakter olabilir.')); return false; }

      // Yalnız arka ucun DESTEKLEDİĞİ alanlar gönderilir.
      const payload: Record<string, unknown> = {};
      if (name !== String(server.name ?? '')) payload.name = name;
      if (icon !== String(server.icon ?? '')) payload.icon = icon;
      if (Object.keys(payload).length === 0) return true;   // değişiklik yok

      store.saving = true; commit({ saving: true, error: null });
      try {
        const { apiFetch } = await import('../../api-fetch.js');
        const { getAPI }   = await import('../../globals.js');
        const res = await apiFetch(`${getAPI()}/api/servers/${serverId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          // Sunucu gövdesi kullanıcıya taşınmaz: proxy/uygulama ayrıntısı ya da
          // beklenmedik teknik metin içerebilir. Durum kodu kanonik güvenli
          // ürün mesajına sınıflandırılır.
          store.setError(safeApiErrorMessage(res, t('srv_save_failed', 'Sunucu ayarları kaydedilemedi.'), { report: true }));
          return false;
        }

        const updated = await res.json().catch(() => null) as Record<string, unknown> | null;
        if (updated) {
          server.name = String(updated.name ?? name);
          server.icon = String(updated.icon ?? icon);
          store.name = String(server.name); store.icon = String(server.icon);
          commit({ name: store.name, icon: store.icon, iconUrl: store.icon });
        }
        return true;
      } catch (err) {
        store.setError(safeApiErrorMessage(err, t('srv_save_failed', 'Sunucu ayarları kaydedilemedi.'), { report: true }));
        return false;
      } finally {
        store.saving = false; commit({ saving: false });
      }
    },
    /** Kirli mi? Kaydet düğmesi bununla etkinleşir. */
    isDirty() {
      return String(store.name ?? '').trim() !== String(server.name ?? '')
          || String(store.icon ?? '').trim() !== String(server.icon ?? '');
    },
    async loadSlug() {
      if (!serverId) return;
      try {
        const { apiFetch } = await import('../../api-fetch.js');
        const { getAPI }   = await import('../../globals.js');
        const res = await apiFetch(`${getAPI()}/api/servers/${serverId}/slug`);
        if (!res.ok) return;
        const body = await res.json().catch(() => null) as { slug?: unknown } | null;
        const slug = typeof body?.slug === 'string' ? body.slug : '';
        server.slug = slug;
        server.vanityUrl = slug;
        store.slug = slug;
        store.slugPreview = slug;
        commit({ slug, slugPreview: slug });
      } catch { /* read-only enhancement: general settings still work */ }
    },
    async saveSlug() {
      if (store.slugSaving || !serverId) return false;
      if (!isStillCurrentServer(serverId)) {
        store.setError(t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.'));
        return false;
      }
      const slug = String(store.slug ?? '').trim().toLowerCase();
      if (!/^[a-z0-9-]{3,32}$/.test(slug)) {
        store.setError(t('srv_slug_invalid', 'Profil adresi 3–32 küçük harf, rakam veya tire içermeli.'));
        return false;
      }
      store.slugSaving = true; commit({ slugSaving: true, error: null });
      try {
        const { apiFetch } = await import('../../api-fetch.js');
        const { getAPI }   = await import('../../globals.js');
        const res = await apiFetch(`${getAPI()}/api/servers/${serverId}/slug`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug }),
        });
        if (!res.ok) {
          store.setError(safeApiErrorMessage(res, t('srv_slug_failed', 'Profil adresi kaydedilemedi.'), { report: true }));
          return false;
        }
        const body = await res.json().catch(() => null) as { slug?: unknown } | null;
        const saved = typeof body?.slug === 'string' ? body.slug : slug;
        server.slug = saved; server.vanityUrl = saved;
        store.slug = saved; store.slugPreview = saved;
        commit({ slug: saved, slugPreview: saved });
        return true;
      } catch (err) {
        store.setError(safeApiErrorMessage(err, t('srv_slug_failed', 'Profil adresi kaydedilemedi.'), { report: true }));
        return false;
      } finally {
        store.slugSaving = false; commit({ slugSaving: false });
      }
    },
    isSlugDirty() {
      return String(store.slug ?? '').trim().toLowerCase() !== String(server.slug ?? server.vanityUrl ?? '').trim().toLowerCase();
    },
    async saveDiscovery() {
      if (store.discoverySaving || !serverId) return false;
      if (!isStillCurrentServer(serverId)) {
        store.setError(t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.'));
        return false;
      }
      store.discoverySaving = true; commit({ discoverySaving: true, error: null });
      try {
        const { apiFetch } = await import('../../api-fetch.js');
        const { getAPI }   = await import('../../globals.js');
        const res = await apiFetch(`${getAPI()}/api/discover/settings`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverId, discoverable: store.discoverable, category: canonicalCategory(store.category) }),
        });
        if (!res.ok) {
          store.setError(safeApiErrorMessage(res, t('srv_discovery_failed', 'Keşif ayarları kaydedilemedi.'), { report: true }));
          return false;
        }
        server.discoverable = store.discoverable;
        server.category = canonicalCategory(store.category);
        store.category = String(server.category);
        commit({ category: store.category });
        return true;
      } catch (err) {
        store.setError(safeApiErrorMessage(err, t('srv_discovery_failed', 'Keşif ayarları kaydedilemedi.'), { report: true }));
        return false;
      } finally {
        store.discoverySaving = false; commit({ discoverySaving: false });
      }
    },
    isDiscoveryDirty() {
      const originalDiscoverable = server.discoverable === true || server.discoverable === 1;
      return store.discoverable !== originalDiscoverable || canonicalCategory(store.category) !== canonicalCategory(server.category);
    },
    // ── P6 — per-server AI opt-out ─────────────────────────────────────────
    // `PATCH /api/servers/:sid { aiEnabled }` — owner only (403 otherwise),
    // strict boolean. The server is the authority: the UI only asks; every AI
    // route re-reads the stored value on each request.
    async saveAi() {
      if (store.aiSaving || !serverId) return false;
      if (!isStillCurrentServer(serverId)) {
        store.setError(t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.'));
        return false;
      }
      store.aiSaving = true; commit({ aiSaving: true, error: null });
      try {
        const { apiFetch } = await import('../../api-fetch.js');
        const { getAPI }   = await import('../../globals.js');
        const res = await apiFetch(`${getAPI()}/api/servers/${serverId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ aiEnabled: store.aiEnabled === true }),
        });
        if (!res.ok) {
          store.setError(safeApiErrorMessage(res, t('srv_ai_failed', 'Yapay zekâ ayarı kaydedilemedi.'), { report: true }));
          return false;
        }
        const updated = await res.json().catch(() => null) as Record<string, unknown> | null;
        server.aiEnabled = updated && typeof updated.aiEnabled === 'boolean' ? updated.aiEnabled : store.aiEnabled;
        store.aiEnabled = server.aiEnabled !== false;
        commit({ aiEnabled: store.aiEnabled });
        return true;
      } catch (err) {
        store.setError(safeApiErrorMessage(err, t('srv_ai_failed', 'Yapay zekâ ayarı kaydedilemedi.'), { report: true }));
        return false;
      } finally {
        store.aiSaving = false; commit({ aiSaving: false });
      }
    },
    isAiDirty() {
      return store.aiEnabled !== (server.aiEnabled !== false);
    },
    async reload() {
      const current = getCurrentServerFromRegistry();
      if (!current) return;
      server.name = String(current.name ?? '');
      server.icon = String(current.icon ?? '');
      server.discoverable = current.discoverable;
      server.category = current.category;
      store.name  = String(server.name); store.icon = String(server.icon);
      store.discoverable = current.discoverable === true || current.discoverable === 1;
      store.category = canonicalCategory(current.category);
      server.aiEnabled = current.aiEnabled === false ? false : current.aiEnabled === true ? true : undefined;
      store.aiEnabled = server.aiEnabled !== false;
      commit({ name: store.name, icon: store.icon, discoverable: store.discoverable, category: store.category, aiEnabled: store.aiEnabled, error: null });
    },
  };
  return store;
}
