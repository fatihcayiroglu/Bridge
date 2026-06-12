// client/js/core/clyde-svelte.ts
// Sprint 116 — ClydeAssistant mount shim (ADR-0008 Faz 3)
// Bridge AI asistan bileşeni
import { mount } from 'svelte';
import ClydeAssistant from './ClydeAssistant.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ClydeAssistantShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountClydeAssistant(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('clyde-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'clyde-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ClydeAssistant, { target: el, props: {} });
  log.info('ClydeAssistant mounted via shim');
}

export function unmountClydeAssistant(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountClydeAssistant(), { once: true });
} else {
  mountClydeAssistant();
}
document.addEventListener('bridge:socket-ready', () => mountClydeAssistant(), { once: true });
