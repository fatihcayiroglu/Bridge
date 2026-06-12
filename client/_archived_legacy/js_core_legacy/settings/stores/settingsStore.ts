// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SettingsStorePanel.svelte
//              client/js/core/settingsStore-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/settings/stores/settingsStore.ts
// Svelte 5 rune tabanlı settings state.
// Mevcut core/state.ts'ten türer — doğrudan import eder, kopyalamaz.

import { getCurrentUser } from '../../state';

// ── Tipler ───────────────────────────────────────────────────────────────────

export type SettingsTab =
  | 'profile'
  | 'appearance'
  | 'notifications'
  | 'privacy'
  | 'devices';

export interface SettingsState {
  activeTab: SettingsTab;
  saving:    boolean;
  error:     string | null;
}

// ── Svelte 5 $state rune ─────────────────────────────────────────────────────
// Bu dosya yalnızca .svelte bileşenlerinden veya diğer .svelte.ts
// dosyalarından import edilebilir — vanilla JS bağlamında kullanmak için
// BridgeRegistry köprüsünü kullan (bkz. settings-modal.ts).

export function createSettingsStore(initialTab: SettingsTab = 'profile') {
  let activeTab = $state<SettingsTab>(initialTab);
  let saving    = $state(false);
  let error     = $state<string | null>(null);

  return {
    get activeTab() { return activeTab; },
    get saving()    { return saving; },
    get error()     { return error; },

    setTab(tab: SettingsTab) { activeTab = tab; error = null; },

    async save(updates: Record<string, unknown>): Promise<boolean> {
      saving = true;
      error  = null;
      try {
        const res = await fetch('/api/users/me', {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(updates),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          error = (data as { error?: string }).error ?? 'Kaydetme başarısız';
          return false;
        }
        return true;
      } catch (e) {
        error = e instanceof Error ? e.message : 'Ağ hatası';
        return false;
      } finally {
        saving = false;
      }
    },

    clearError() { error = null; },
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
