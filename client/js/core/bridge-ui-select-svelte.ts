// client/js/core/bridge-ui-select-svelte.ts
// Sprint 116 — BridgeSelect mount shim (ADR-0008 Faz 3)
// Bridge tasarım sistemi seçici bileşeni
import { mount } from 'svelte';
import BridgeSelect from './BridgeSelect.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('BridgeSelectShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountBridgeSelect(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('bridge-ui-select-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'bridge-ui-select-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(BridgeSelect, { target: el, props: {} });
  log.info('BridgeSelect mounted via shim');
}

export function unmountBridgeSelect(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountBridgeSelect(), { once: true });
} else {
  mountBridgeSelect();
}
document.addEventListener('bridge:socket-ready', () => mountBridgeSelect(), { once: true });
