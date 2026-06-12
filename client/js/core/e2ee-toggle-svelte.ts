// client/js/core/e2ee-toggle-svelte.ts
// Sprint 116 — E2EEToggle mount shim (ADR-0008 Faz 3)
// Kanal E2EE etkinleştirme toggle bileşeni
import { mount } from 'svelte';
import E2EEToggle from './E2EEToggle.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('E2EEToggleShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountE2EEToggle(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('e2ee-toggle-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'e2ee-toggle-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(E2EEToggle, { target: el, props: { channelId: '', initialEnabled: false } });
  log.info('E2EEToggle mounted via shim');
}

export function unmountE2EEToggle(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountE2EEToggle(), { once: true });
} else {
  mountE2EEToggle();
}
document.addEventListener('bridge:socket-ready', () => mountE2EEToggle(), { once: true });
