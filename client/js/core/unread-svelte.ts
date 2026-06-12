// client/js/core/unread-svelte.ts
// Sprint 116 — UnreadBadge mount shim (ADR-0008 Faz 3)
// Okunmamış mesaj sayacı badge
import { mount } from 'svelte';
import UnreadBadge from './UnreadBadge.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('UnreadBadgeShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountUnreadBadge(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('unread-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'unread-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(UnreadBadge, { target: el, props: {} });
  log.info('UnreadBadge mounted via shim');
}

export function unmountUnreadBadge(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountUnreadBadge(), { once: true });
} else {
  mountUnreadBadge();
}
document.addEventListener('bridge:socket-ready', () => mountUnreadBadge(), { once: true });
