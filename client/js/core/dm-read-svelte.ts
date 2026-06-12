// client/js/core/dm-read-svelte.ts
// Sprint 116 — DmReadTracker mount shim (ADR-0008 Faz 3)
// DM okundu/okunmadı takibi
import { mount } from 'svelte';
import DmReadTracker from './DmReadTracker.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('DmReadTrackerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountDmReadTracker(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('dm-read-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'dm-read-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(DmReadTracker, { target: el, props: {} });
  log.info('DmReadTracker mounted via shim');
}

export function unmountDmReadTracker(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountDmReadTracker(), { once: true });
} else {
  mountDmReadTracker();
}
document.addEventListener('bridge:socket-ready', () => mountDmReadTracker(), { once: true });
