// client/js/core/misc-svelte.ts
// Sprint 116 — MiscUI mount shim (ADR-0008 Faz 3)
// Çeşitli UI yardımcı bileşeni
import { mount } from 'svelte';
import MiscUI from './MiscUI.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MiscUIShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMiscUI(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('misc-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'misc-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MiscUI, { target: el, props: {} });
  log.info('MiscUI mounted via shim');
}

export function unmountMiscUI(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMiscUI(), { once: true });
} else {
  mountMiscUI();
}
document.addEventListener('bridge:socket-ready', () => mountMiscUI(), { once: true });
