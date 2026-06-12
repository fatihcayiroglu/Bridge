// client/js/core/skeleton-loading-svelte.ts
// Sprint 116 — SkeletonLoader mount shim (ADR-0008 Faz 3)
// Yükleme iskelet ekranı bileşeni
import { mount } from 'svelte';
import SkeletonLoader from './SkeletonLoader.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('SkeletonLoaderShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountSkeletonLoader(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('skeleton-loading-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'skeleton-loading-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(SkeletonLoader, { target: el, props: {} });
  log.info('SkeletonLoader mounted via shim');
}

export function unmountSkeletonLoader(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountSkeletonLoader(), { once: true });
} else {
  mountSkeletonLoader();
}
document.addEventListener('bridge:socket-ready', () => mountSkeletonLoader(), { once: true });
