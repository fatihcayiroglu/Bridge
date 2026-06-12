// client/js/core/bridge-ui-misc-svelte.ts
// Sprint 116 — BridgeMisc mount shim (ADR-0008 Faz 3)
// Bridge UI yardımcı bileşenleri
import { mount } from 'svelte';
import BridgeMisc from './BridgeMisc.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('BridgeMiscShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountBridgeMisc(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('bridge-ui-misc-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'bridge-ui-misc-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(BridgeMisc, { target: el, props: {} });
  log.info('BridgeMisc mounted via shim');
}

export function unmountBridgeMisc(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountBridgeMisc(), { once: true });
} else {
  mountBridgeMisc();
}
document.addEventListener('bridge:socket-ready', () => mountBridgeMisc(), { once: true });
