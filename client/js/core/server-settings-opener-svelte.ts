// client/js/core/server-settings-opener-svelte.ts
// FAZ C1.3 — Sunucu Ayarları açıcısının mount köprüsü.
//
// Açıcıyı kanal başlığındaki mevcut araç çubuğuna (#channel-header içindeki
// .channel-header-actions) yerleştirir — Bridge'in halihazırda kullandığı
// başlık aksiyon yüzeyi budur; ikinci bir ayar sistemi KURULMAZ.
//
// `openServerSettings` registry kaydı, mevcut gerçek modal shim'ini çağırır
// (server-settings/server-settings-svelte.ts). Shim zaten tek örnek garantisi
// verir: yeniden mount edilirse öncekini unmount eder.

import { mount, unmount } from 'svelte';
import ServerSettingsOpener from './ServerSettingsOpener.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';

const log = createLogger('ServerSettingsOpenerShim');

let _instance: ReturnType<typeof mount> | null = null;

function mountOpener(): void {
  if (_instance) return;   // tek sahip

  const host = document.querySelector<HTMLElement>('#channel-header .channel-header-actions');
  if (!host) return;       // kabuk henüz hazır değil

  _instance = mount(ServerSettingsOpener, { target: host });
  log.info('Sunucu Ayarları açıcısı mount edildi');
}

// Modalın TEK açılış sözleşmesi. Ayrı bir modal çerçevesi yaratılmaz;
// mevcut shim yeniden kullanılır.
BridgeRegistry.register('openServerSettings', async (initialTab?: unknown) => {
  const { mountServerSettingsModal } = await import('./server-settings/server-settings-svelte.ts');
  const tab = typeof initialTab === 'string' ? initialTab : 'general';
  await mountServerSettingsModal(tab as never);
});

BridgeRegistry.register('closeServerSettings', async () => {
  const { unmountServerSettingsModal } = await import('./server-settings/server-settings-svelte.ts');
  unmountServerSettingsModal();
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountOpener, { once: true });
} else {
  mountOpener();
}
document.addEventListener('bridge:socket-ready', mountOpener, { once: true });

export function unmountServerSettingsOpener(): void {
  if (!_instance) return;
  void unmount(_instance);
  _instance = null;
}

export { mountOpener };
