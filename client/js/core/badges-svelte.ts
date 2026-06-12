// client/js/core/badges-svelte.ts
// Sprint 116 — BadgeDisplay mount shim (ADR-0008 Faz 3)
// Kullanıcı rozet gösterimi
import { mount } from 'svelte';
import BadgeDisplay from './BadgeDisplay.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('BadgeDisplayShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountBadgeDisplay(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('badges-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'badges-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(BadgeDisplay, { target: el, props: {} });
  log.info('BadgeDisplay mounted via shim');
}

export function unmountBadgeDisplay(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountBadgeDisplay(), { once: true });
} else {
  mountBadgeDisplay();
}
document.addEventListener('bridge:socket-ready', () => mountBadgeDisplay(), { once: true });
