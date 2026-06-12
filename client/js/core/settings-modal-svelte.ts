// client/js/core/settings-modal-svelte.ts
// Sprint 116 — SettingsModalBridge mount shim (ADR-0008 Faz 3)
// Ayarlar modal köprüsü
import { mount } from 'svelte';
import SettingsModalBridge from './SettingsModalBridge.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SettingsModalBridgeShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSettingsModalBridge(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('settings-modal-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'settings-modal-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SettingsModalBridge, { target: el, props: {} });
  log.info('SettingsModalBridge mounted via shim');
}

export function unmountSettingsModalBridge(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSettingsModalBridge(), { once: true });
} else {
  mountSettingsModalBridge();
}
document.addEventListener('bridge:socket-ready', () => mountSettingsModalBridge(), { once: true });
