// client/js/core/servers-svelte.ts
// Sprint 116 — ServerSwitcher mount shim (ADR-0008 Faz 3)
// Sunucu değiştirici ve liste paneli
import { mount } from 'svelte';
import ServerSwitcher from './ServerSwitcher.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ServerSwitcherShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerSwitcher(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('servers-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'servers-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerSwitcher, { target: el, props: {} });
  log.info('ServerSwitcher mounted via shim');
}

export function unmountServerSwitcher(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerSwitcher(), { once: true });
} else {
  mountServerSwitcher();
}
document.addEventListener('bridge:socket-ready', () => mountServerSwitcher(), { once: true });
