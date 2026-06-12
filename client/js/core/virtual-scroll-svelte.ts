// client/js/core/virtual-scroll-svelte.ts
// Sprint 116 — VirtualScrollList mount shim (ADR-0008 Faz 3)
// Büyük liste sanal scroll bileşeni
import { mount } from 'svelte';
import VirtualScrollList from './VirtualScrollList.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('VirtualScrollListShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountVirtualScrollList(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('virtual-scroll-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'virtual-scroll-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(VirtualScrollList, { target: el, props: {} });
  log.info('VirtualScrollList mounted via shim');
}

export function unmountVirtualScrollList(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountVirtualScrollList(), { once: true });
} else {
  mountVirtualScrollList();
}
document.addEventListener('bridge:socket-ready', () => mountVirtualScrollList(), { once: true });
