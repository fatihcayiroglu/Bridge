// client/js/core/slow-mode-svelte.ts
// Sprint 116 — SlowModeIndicator mount shim (ADR-0008 Faz 3)
// Kanal yavaş mod göstergesi
import { mount } from 'svelte';
import SlowModeIndicator from './SlowModeIndicator.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SlowModeIndicatorShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSlowModeIndicator(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('slow-mode-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'slow-mode-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SlowModeIndicator, { target: el, props: {} });
  log.info('SlowModeIndicator mounted via shim');
}

export function unmountSlowModeIndicator(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSlowModeIndicator(), { once: true });
} else {
  mountSlowModeIndicator();
}
document.addEventListener('bridge:socket-ready', () => mountSlowModeIndicator(), { once: true });
