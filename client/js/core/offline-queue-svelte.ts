// client/js/core/offline-queue-svelte.ts
// Sprint 116 — OfflineQueue mount shim (ADR-0008 Faz 3)
// Çevrimdışı mesaj kuyruğu
import { mount } from 'svelte';
import OfflineQueue from './OfflineQueue.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('OfflineQueueShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountOfflineQueue(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('offline-queue-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'offline-queue-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(OfflineQueue, { target: el, props: {} });
  log.info('OfflineQueue mounted via shim');
}

export function unmountOfflineQueue(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountOfflineQueue(), { once: true });
} else {
  mountOfflineQueue();
}
document.addEventListener('bridge:socket-ready', () => mountOfflineQueue(), { once: true });
