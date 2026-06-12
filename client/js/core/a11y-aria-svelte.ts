// client/js/core/a11y-aria-svelte.ts
// Sprint 116 — AriaManager mount shim (ADR-0008 Faz 3)
// ARIA canlı bölge ve rol yöneticisi
import { mount } from 'svelte';
import AriaManager from './AriaManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('AriaManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountAriaManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('a11y-aria-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'a11y-aria-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(AriaManager, { target: el, props: {} });
  log.info('AriaManager mounted via shim');
}

export function unmountAriaManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountAriaManager(), { once: true });
} else {
  mountAriaManager();
}
document.addEventListener('bridge:socket-ready', () => mountAriaManager(), { once: true });
