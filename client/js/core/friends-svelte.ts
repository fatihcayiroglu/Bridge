// client/js/core/friends-svelte.ts
// Sprint 116 — FriendsPanel mount shim (ADR-0008 Faz 3)
// Arkadaş listesi ve istek yönetimi
import { mount } from 'svelte';
import FriendsPanel from './FriendsPanel.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('FriendsPanelShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountFriendsPanel(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('friends-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'friends-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(FriendsPanel, { target: el, props: {} });
  log.info('FriendsPanel mounted via shim');
}

export function unmountFriendsPanel(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountFriendsPanel(), { once: true });
} else {
  mountFriendsPanel();
}
document.addEventListener('bridge:socket-ready', () => mountFriendsPanel(), { once: true });
