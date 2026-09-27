// client/js/core/channel-list/channel-list-svelte.ts
// ChannelList Svelte mount — renderChannels() compatibility bridge.

export interface ChannelData { id?: string; _id?: string; name?: string; type?: string; categoryId?: string | null; [key: string]: unknown }
export interface CategoryData { id?: string; _id?: string; name?: string; channels?: ChannelData[]; [key: string]: unknown }
import { createLogger } from '../logger.ts';

const log = createLogger('ChannelListSvelte');

interface ChannelListHandle {
  update: (props: ChannelListProps) => void;
  unmount: () => void;
}

export interface ChannelListProps {
  channels: ChannelData[];
  categories?: CategoryData[];
  collapsedCategoryKeys?: Set<string>;
  activeChannelId?: string | null;
  onSelect: (channel: ChannelData) => void;
  onOpenMenu?: (channelId: string, name: string, event: MouseEvent) => void;
  onCreateChannel?: () => void;
  onCreateInCategory?: (categoryId: string, event: MouseEvent) => void;
  onToggleCategory?: (categoryKey: string) => void;
}

let _handle: ChannelListHandle | null = null;
let _currentProps: ChannelListProps | null = null;
let _mountGeneration = 0;
let _pendingMountPoint: HTMLElement | null = null;

export async function mountOrUpdateChannelList(
  listEl: HTMLElement,
  props: ChannelListProps,
): Promise<boolean> {
  if (_handle) {
    _handle.update(props);
    return true;
  }

  const generation = ++_mountGeneration;
  _pendingMountPoint?.remove();
  const mountPoint = document.createElement('div');
  mountPoint.className = 'channel-list-svelte-root';
  _pendingMountPoint = mountPoint;
  listEl.replaceChildren(mountPoint);

  // Let same-turn replacement requests publish their generation first. This
  // makes ownership deterministic even when dynamic-import scheduling differs
  // across browsers/test runners.
  await Promise.resolve();
  if (generation !== _mountGeneration || _pendingMountPoint !== mountPoint || mountPoint.parentNode !== listEl) {
    mountPoint.remove();
    return false;
  }

  try {
    const { mount, unmount } = await import('svelte');
    const { default: ChannelListRaw } = await import('./ChannelList.svelte');
    if (generation !== _mountGeneration || _pendingMountPoint !== mountPoint || mountPoint.parentNode !== listEl) {
      mountPoint.remove();
      return false;
    }

    const ChannelList = ChannelListRaw as unknown as Parameters<typeof mount>[0];
    let instance = mount(ChannelList, { target: mountPoint, props });
    _currentProps = props;
    _pendingMountPoint = null;

    const handle: ChannelListHandle = {
      update: (next) => {
        if (_handle !== handle) return;
        _currentProps = next;
        void unmount(instance);
        mountPoint.replaceChildren();
        instance = mount(ChannelList, { target: mountPoint, props: next });
      },
      unmount: () => {
        if (_handle !== handle) return;
        _handle = null;
        _currentProps = null;
        void unmount(instance);
        mountPoint.remove();
      },
    };
    _handle = handle;
    return true;
  } catch (err) {
    if (generation === _mountGeneration && _pendingMountPoint === mountPoint) {
      _pendingMountPoint = null;
    }
    mountPoint.remove();
    log.error('[channel-list] Svelte shell yüklenemedi:', err);
    return false;
  }
}

export function unmountChannelList(): void {
  ++_mountGeneration; // invalidate any in-flight dynamic import/mount
  _pendingMountPoint?.remove();
  _pendingMountPoint = null;
  const handle = _handle;
  if (handle) handle.unmount();
  _handle = null;
  _currentProps = null;
}

export function updateActiveChannel(channelId: string | null): void {
  if (!_handle || !_currentProps) return;
  if ((_currentProps.activeChannelId ?? null) === channelId) return;
  _handle.update({ ..._currentProps, activeChannelId: channelId });
}
