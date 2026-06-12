// client/js/core/server-settings-svelte.ts
// Sprint 116 — ServerSettingsManager mount shim (ADR-0008 Faz 3)
// Sunucu ayarları genel paneli
import { mount } from 'svelte';
import ServerSettingsManager from './ServerSettingsManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ServerSettingsManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerSettingsManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('server-settings-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'server-settings-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerSettingsManager, { target: el, props: {} });
  log.info('ServerSettingsManager mounted via shim');
}

export function unmountServerSettingsManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerSettingsManager(), { once: true });
} else {
  mountServerSettingsManager();
}
document.addEventListener('bridge:socket-ready', () => mountServerSettingsManager(), { once: true });
