// client/js/core/channel-list-svelte.ts
// Sprint 116 — ChannelListManager mount shim (ADR-0008 Faz 3)
// Kanal listesi ve kategori ağacı
import { mount, unmount } from 'svelte';
import ChannelListManager from './ChannelListManager.svelte';
import { createLogger } from './logger.ts';
const log = createLogger('ChannelListManagerShim');

let _instance: ReturnType<typeof mount> | null = null;

/**
 * Mount noktası: index.html:155 içindeki #channel-list korunur.
 * Controller kendi host div'ini bu kabuğun içine kurar; hazır view
 * (channel-list/ChannelList.svelte) o host'a mount edilir.
 */
function resolveChannelListMountPoint(): HTMLElement {
  const existing = document.getElementById('channel-list-root');
  if (existing) return existing;

  const holder = document.createElement('div');
  holder.id = 'channel-list-root';

  const list = document.getElementById('channel-list');
  if (list) {
    holder.style.display = 'contents';
    list.appendChild(holder);
  } else {
    // Kabuk yoksa (test/parçalı sayfa) eski davranışa düş.
    document.body.appendChild(holder);
  }
  return holder;
}

export function mountChannelListManager(target?: HTMLElement): void {
  if (_instance) return;
  const el = target ?? resolveChannelListMountPoint();
  _instance = mount(ChannelListManager, { target: el, props: {} });
  log.info('ChannelListManager mounted via shim');
}

export function unmountChannelListManager(): void {
  if (!_instance) return;
  const mounted = _instance;
  _instance = null;
  void unmount(mounted);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountChannelListManager(), { once: true });
} else {
  mountChannelListManager();
}
document.addEventListener('bridge:socket-ready', () => mountChannelListManager(), { once: true });
