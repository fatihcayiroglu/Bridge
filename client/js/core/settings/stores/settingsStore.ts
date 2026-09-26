import { writable } from 'svelte/store';
import { BridgeRegistry } from '../../bridge-registry.js';
import { t } from '../../i18n/index';
import { safeApiErrorMessage } from '../../api-error.ts';

/**
 * `PATCH /api/me` ucunun KABUL ETTİĞİ alanlar (server/routes/auth.ts:425).
 * Burada olmayan bir alanı göndermek sunucuda sessizce yok sayılır; bu yüzden
 * gönderilmez ve kullanıcıya kalıcı olduğu söylenmez.
 *
 * NOT: `statusText` / `statusEmoji` bilerek YOKTUR — sunucuda karşılıkları
 * bulunmuyor (`status` yalnız çevrimiçi durumu enum'udur, serbest metin değil).
 */
const SERVER_PROFILE_FIELDS = [
  'displayName', 'status', 'bio', 'website', 'location', 'pronouns', 'bannerColor',
  'dmPrivacy', 'presenceVisibility',
] as const;
export type SettingsTab = 'profile' | 'appearance' | 'notifications' | 'privacy' | 'devices' | 'security' | string;
export type BridgeLayoutMode = 'cozy' | 'compact' | 'comfortable' | 'classic' | 'focus' | string;
export interface SettingsStore {
  activeTab: SettingsTab;
  error: string | null;
  saving: boolean;
  profile?: Record<string, unknown>;
  appearance?: Record<string, unknown>;
  privacy?: Record<string, unknown>;
  devices?: Record<string, unknown>;
  layoutMode?: BridgeLayoutMode;
  setTab(tab: SettingsTab): void;
  setError(error: string | null): void;
  save(payload?: Record<string, unknown>): Promise<boolean>;
  reload(): Promise<void>;
  setLayoutMode(mode: BridgeLayoutMode): void;
  setDevicePreference(key: string, value: unknown): void;
  setPrivacyOption(key: string, value: unknown): void;
  subscribe: ReturnType<typeof writable<Record<string, unknown>>>['subscribe'];
  [key: string]: unknown;
}
export function createSettingsStore(initialTab: SettingsTab = 'profile'): SettingsStore {
  const state = writable<Record<string, unknown>>({ activeTab: initialTab, error: null, saving: false, layoutMode: 'cozy' });
  const commit = (patch: Record<string, unknown>) => state.update((s: Record<string, unknown>) => ({ ...s, ...patch }));
  const store: SettingsStore = {
    activeTab: initialTab,
    error: null,
    saving: false,
    layoutMode: 'cozy',
    subscribe: state.subscribe,
    setTab(tab) { store.activeTab = tab; commit({ activeTab: tab }); },
    setError(error) { store.error = error; commit({ error }); },
    // Faz 11 §32 — GERÇEK KALICILIK.
    //
    // Bu metot eskiden yalnız `saving` bayrağını çevirip KOŞULSUZ `true`
    // dönüyordu: hiçbir ağ çağrısı yoktu. ProfileTab bunu çağırıp kullanıcıya
    // "kaydedildi" gösteriyor, ama sunucuda hiçbir şey değişmiyor ve yeniden
    // yüklemede eski değer geri geliyordu.
    //
    // Kanonik uç: `PATCH /api/me` (server/routes/auth.ts:425). Yalnız o ucun
    // KABUL ETTİĞİ alanlar gönderilir; tanımadığı alanları göndermek sessiz
    // veri kaybı olurdu. Başarı artık sunucunun yanıtına dayanır.
    async save(payload = {}) {
      const sendable: Record<string, unknown> = {};
      for (const key of SERVER_PROFILE_FIELDS) {
        if (payload[key] !== undefined) sendable[key] = payload[key];
      }

      store.saving = true;
      commit({ saving: true, ...payload });

      // Desteklenen alan yoksa ağ çağrısı yapma ve BAŞARI DÖNME.
      if (Object.keys(sendable).length === 0) {
        store.saving = false;
        commit({ saving: false });
        store.setError(t('set_no_changes', 'Kaydedilebilecek bir değişiklik yok.'));
        return false;
      }

      try {
        const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
        if (!apiFetch) throw new Error('settings apiFetch owner unavailable');

        const res = await apiFetch('/api/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sendable),
        });
        if (!res.ok) {
          store.setError(safeApiErrorMessage(res, t('set_save_failed', 'Ayarlar kaydedilemedi.'), { report: true }));
          return false;
        }

        store.setError(null);
        return true;
      } catch (err) {
        // Sessiz sahte başarı YOK.
        store.setError(safeApiErrorMessage(err, t('set_save_failed', 'Ayarlar kaydedilemedi.'), { report: true }));
        return false;
      } finally {
        store.saving = false;
        commit({ saving: false });
      }
    },
    async reload() {},
    setLayoutMode(mode) { store.layoutMode = mode; commit({ layoutMode: mode }); },
    setDevicePreference(key, value) { const devices = { ...(store.devices ?? {}), [key]: value }; store.devices = devices; commit({ devices }); },
    setPrivacyOption(key, value) { const privacy = { ...(store.privacy ?? {}), [key]: value }; store.privacy = privacy; commit({ privacy }); },
  };
  return store;
}
