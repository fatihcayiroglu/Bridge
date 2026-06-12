// client/js/core/channel-list/channel-list-svelte.ts
// ChannelList Svelte mount — renderChannels() köprüsü

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
  onOpenMenu: (channelId: string, name: string, event: MouseEvent) => void;
  onCreateChannel?: () => void;
  onCreateInCategory?: (categoryId: string, event: MouseEvent) => void;
  onToggleCategory?: (categoryKey: string) => void;
}

let _handle: ChannelListHandle | null = null;

export async function mountOrUpdateChannelList(
  listEl: HTMLElement,
  props: ChannelListProps,
): Promise<boolean> {
  if (_handle) {
    _handle.update(props);
    return true;
  }

  const mountPoint = document.createElement('div');
  mountPoint.className = 'channel-list-svelte-root';
  listEl.innerHTML = '';
  listEl.appendChild(mountPoint);

  try {
    const { mount, unmount } = await import('svelte');
    const { default: ChannelListRaw } = await import('./ChannelList.svelte');
    const ChannelList = ChannelListRaw as unknown as Parameters<typeof mount>[0];

    let currentProps = props;
    const instance = mount(ChannelList, { target: mountPoint, props: currentProps });

    _handle = {
      update: (next) => {
        currentProps = next;
        (instance as unknown as { $set?: (props: ChannelListProps) => void }).$set?.(next);
      },
      unmount: () => {
        unmount(instance);
        mountPoint.remove();
        _handle = null;
      },
    };
    return true;
  } catch (err) {
    log.error('[channel-list] Svelte shell yüklenemedi:', err);
    mountPoint.remove();
    return false;
  }
}

export function unmountChannelList(): void {
  _handle?.unmount();
  _handle = null;
}

export function updateActiveChannel(channelId: string | null): void {
  if (!_handle) return;
  // Re-mount update handled by caller via mountOrUpdateChannelList
}
