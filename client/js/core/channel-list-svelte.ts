// client/js/core/channel-list-svelte.ts
// Sprint 116 — ChannelListManager mount shim (ADR-0008 Faz 3)
// Kanal listesi ve kategori ağacı
import { mount } from 'svelte';
import ChannelListManager from './ChannelListManager.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ChannelListManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountChannelListManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('channel-list-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'channel-list-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ChannelListManager, { target: el, props: {} });
  log.info('ChannelListManager mounted via shim');
}

export function unmountChannelListManager(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountChannelListManager(), { once: true });
} else {
  mountChannelListManager();
}
document.addEventListener('bridge:socket-ready', () => mountChannelListManager(), { once: true });
