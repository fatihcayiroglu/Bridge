// client/js/core/ui-svelte.ts
// Sprint 116 — UIManager mount shim (ADR-0008 Faz 3)
// Genel UI yönetim ve yardımcı bileşeni
import { mount } from 'svelte';
import UIManager from './UIManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('UIManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountUIManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(UIManager, { target: el, props: {} });
  log.info('UIManager mounted via shim');
}

export function unmountUIManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountUIManager(), { once: true });
} else {
  mountUIManager();
}
document.addEventListener('bridge:socket-ready', () => mountUIManager(), { once: true });
