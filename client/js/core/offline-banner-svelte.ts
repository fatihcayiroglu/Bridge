// client/js/core/offline-banner-svelte.ts
// Sprint 116 — OfflineBanner mount shim (ADR-0008 Faz 3)
// Çevrimdışı uyarı banner bileşeni
import { mount } from 'svelte';
import OfflineBanner from './OfflineBanner.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('OfflineBannerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountOfflineBanner(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('offline-banner-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'offline-banner-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(OfflineBanner, { target: el, props: {} });
  log.info('OfflineBanner mounted via shim');
}

export function unmountOfflineBanner(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOfflineBanner(), { once: true });
} else {
  mountOfflineBanner();
}
document.addEventListener('bridge:socket-ready', () => mountOfflineBanner(), { once: true });
