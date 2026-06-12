// client/js/core/server-ui-svelte.ts
// Sprint 116 — ServerPanel mount shim (ADR-0008 Faz 3)
// Sunucu ana panel ve sidebar
import { mount } from 'svelte';
import ServerPanel from './ServerPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ServerPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountServerPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('server-ui-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'server-ui-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ServerPanel, { target: el, props: {} });
  log.info('ServerPanel mounted via shim');
}

export function unmountServerPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountServerPanel(), { once: true });
} else {
  mountServerPanel();
}
document.addEventListener('bridge:socket-ready', () => mountServerPanel(), { once: true });
