// client/js/core/dm-svelte.ts
// Sprint 116 — DmPanel mount shim (ADR-0008 Faz 3)
// Direkt mesaj paneli
import { mount } from 'svelte';
import DmPanel from './DmPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DmPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDmPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('dm-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'dm-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DmPanel, { target: el, props: {} });
  log.info('DmPanel mounted via shim');
}

export function unmountDmPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDmPanel(), { once: true });
} else {
  mountDmPanel();
}
document.addEventListener('bridge:socket-ready', () => mountDmPanel(), { once: true });
