// client/js/core/settings-svelte.ts
// Sprint 116 — SettingsManager mount shim (ADR-0008 Faz 3)
// Kullanıcı ayarları yöneticisi
import { mount } from 'svelte';
import SettingsManager from './SettingsManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SettingsManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSettingsManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('settings-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'settings-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SettingsManager, { target: el, props: {} });
  log.info('SettingsManager mounted via shim');
}

export function unmountSettingsManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSettingsManager(), { once: true });
} else {
  mountSettingsManager();
}
document.addEventListener('bridge:socket-ready', () => mountSettingsManager(), { once: true });
