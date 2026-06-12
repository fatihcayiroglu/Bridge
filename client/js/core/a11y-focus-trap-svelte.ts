// client/js/core/a11y-focus-trap-svelte.ts
// Sprint 116 — FocusTrap mount shim (ADR-0008 Faz 3)
// Modal/overlay focus trap bileşeni
import { mount } from 'svelte';
import FocusTrap from './FocusTrap.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('FocusTrapShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountFocusTrap(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('a11y-focus-trap-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'a11y-focus-trap-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(FocusTrap, { target: el, props: {} });
  log.info('FocusTrap mounted via shim');
}

export function unmountFocusTrap(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountFocusTrap(), { once: true });
} else {
  mountFocusTrap();
}
document.addEventListener('bridge:socket-ready', () => mountFocusTrap(), { once: true });
