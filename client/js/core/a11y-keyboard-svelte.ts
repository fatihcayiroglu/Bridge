// client/js/core/a11y-keyboard-svelte.ts
// Sprint 116 — KeyboardNavManager mount shim (ADR-0008 Faz 3)
// Klavye navigasyon yöneticisi
import { mount } from 'svelte';
import KeyboardNavManager from './KeyboardNavManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('KeyboardNavManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountKeyboardNavManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('a11y-keyboard-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'a11y-keyboard-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(KeyboardNavManager, { target: el, props: {} });
  log.info('KeyboardNavManager mounted via shim');
}

export function unmountKeyboardNavManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountKeyboardNavManager(), { once: true });
} else {
  mountKeyboardNavManager();
}
document.addEventListener('bridge:socket-ready', () => mountKeyboardNavManager(), { once: true });
