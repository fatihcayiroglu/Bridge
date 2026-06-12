// client/js/core/mobile-svelte.ts
// Sprint 116 — MobileAdapter mount shim (ADR-0008 Faz 3)
// Mobil platform uyarlama katmanı
import { mount } from 'svelte';
import MobileAdapter from './MobileAdapter.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('MobileAdapterShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountMobileAdapter(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('mobile-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'mobile-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(MobileAdapter, { target: el, props: {} });
  log.info('MobileAdapter mounted via shim');
}

export function unmountMobileAdapter(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMobileAdapter(), { once: true });
} else {
  mountMobileAdapter();
}
document.addEventListener('bridge:socket-ready', () => mountMobileAdapter(), { once: true });
