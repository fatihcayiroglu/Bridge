// client/js/core/user-connections-svelte.ts
// Sprint 116 — UserConnectionsPanel mount shim (ADR-0008 Faz 3)
// Kullanıcı harici platform bağlantıları
import { mount } from 'svelte';
import UserConnectionsPanel from './UserConnectionsPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('UserConnectionsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountUserConnectionsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('user-connections-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'user-connections-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(UserConnectionsPanel, { target: el, props: {} });
  log.info('UserConnectionsPanel mounted via shim');
}

export function unmountUserConnectionsPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountUserConnectionsPanel(), { once: true });
} else {
  mountUserConnectionsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountUserConnectionsPanel(), { once: true });
