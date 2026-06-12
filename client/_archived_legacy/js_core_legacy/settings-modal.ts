// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SettingsModalPanel.svelte
//              client/js/core/settings-modal-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/settings-modal.ts
// Ayarlar modali — Svelte tabanlı (Sprint 57: Vanilla JS modal kaldırıldı)
// Sprint 33: JS → TS migration — strict types, no implicit any
// Sprint 55: Svelte SettingsModal eklendi (ADR-0002 Faz 1)
// Sprint 56: BRIDGE_SVELTE_SETTINGS flag kaldırıldı, Svelte production default
// Sprint 57: Vanilla JS openSettings() ve tüm bağımlı fonksiyonlar kaldırıldı

import { BridgeRegistry } from './bridge-registry';

import { createLogger } from './logger.js';
const log = createLogger('Settings');


// ── Svelte SettingsModal ───────────────────────────────────────────────────
let _svelteSettingsUnmount: (() => void) | null = null;

async function _openSettingsSvelte(initialTab?: string): Promise<void> {
  if (_svelteSettingsUnmount) {
    _svelteSettingsUnmount();
    _svelteSettingsUnmount = null;
  }

  let target = document.getElementById('settings-svelte-mount');
  if (!target) {
    target = document.createElement('div');
    target.id = 'settings-svelte-mount';
    document.body.appendChild(target);
  }

  try {
    const { mount, unmount } = await import('svelte');
    const { default: SettingsModal } = await import('./settings/SettingsModal.svelte');

    const instance = mount(SettingsModal, {
      target,
      props: {
        initialTab: (initialTab as import('./settings/stores/settingsStore').SettingsTab) ?? 'profile',
        onClose: () => {
          if (_svelteSettingsUnmount) {
            _svelteSettingsUnmount();
            _svelteSettingsUnmount = null;
          }
        },
      },
    });

    _svelteSettingsUnmount = () => unmount(instance);
  } catch (err) {
    // Svelte yüklenemezse hata logla — Vanilla JS fallback Sprint 57'de kaldırıldı
    log.error('[settings] Svelte modal yüklenemedi:', err);
  }
}

BridgeRegistry.register('openSettingsModal', (tab?: string) => _openSettingsSvelte(tab));
