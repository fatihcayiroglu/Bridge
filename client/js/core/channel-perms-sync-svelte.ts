// client/js/core/channel-perms-sync-svelte.ts
// Sprint 116 — ChannelPermSync mount shim (ADR-0008 Faz 3)
// Kanal izni senkronizasyon yöneticisi
import { mount } from 'svelte';
import ChannelPermSync from './ChannelPermSync.svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import { createLogger } from './logger.ts';
const log = createLogger('ChannelPermSyncShim');

let _instance: ReturnType<typeof mount> | null = null;

export function mountChannelPermSync(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? document.getElementById('channel-perms-sync-root') ?? (() => {
    const div = document.createElement('div');
    div.id = 'channel-perms-sync-root';
    document.body.appendChild(div);
    return div;
  })();
  _instance = mount(ChannelPermSync, { target: el, props: {} });
  log.info('ChannelPermSync mounted via shim');
}

export function unmountChannelPermSync(): void {
  if (_instance) { _instance = null; }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountChannelPermSync(), { once: true });
} else {
  mountChannelPermSync();
}
document.addEventListener('bridge:socket-ready', () => mountChannelPermSync(), { once: true });
