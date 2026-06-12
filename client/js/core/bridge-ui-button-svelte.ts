// client/js/core/bridge-ui-button-svelte.ts
// Sprint 116 — BridgeButton mount shim (ADR-0008 Faz 3)
// Bridge tasarım sistemi buton bileşeni
import { mount } from 'svelte';
import BridgeButton from './BridgeButton.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('BridgeButtonShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountBridgeButton(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('bridge-ui-button-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'bridge-ui-button-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(BridgeButton, { target: el, props: {} });
  log.info('BridgeButton mounted via shim');
}

export function unmountBridgeButton(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountBridgeButton(), { once: true });
} else {
  mountBridgeButton();
}
document.addEventListener('bridge:socket-ready', () => mountBridgeButton(), { once: true });
