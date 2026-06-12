// client/js/core/boost-ui-svelte.ts
// Sprint 116 — BoostUIPanel mount shim (ADR-0008 Faz 3)
// Boost arayüz bileşeni
import { mount } from 'svelte';
import BoostUIPanel from './BoostUIPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('BoostUIPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountBoostUIPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('boost-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'boost-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(BoostUIPanel, { target: el, props: {} });
  log.info('BoostUIPanel mounted via shim');
}

export function unmountBoostUIPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountBoostUIPanel(), { once: true });
} else {
  mountBoostUIPanel();
}
document.addEventListener('bridge:socket-ready', () => mountBoostUIPanel(), { once: true });
