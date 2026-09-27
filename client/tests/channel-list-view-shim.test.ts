import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mount: vi.fn(), unmount: vi.fn(), logger: { error: vi.fn() },
}));
vi.mock('svelte', () => ({ mount: mocks.mount, unmount: mocks.unmount }));
vi.mock('../js/core/channel-list/ChannelList.svelte', () => ({ default: { component: 'ChannelList' } }));
vi.mock('../js/core/logger.ts', () => ({ createLogger: () => mocks.logger }));

import {
  mountOrUpdateChannelList, unmountChannelList, updateActiveChannel,
} from '../js/core/channel-list/channel-list-svelte.ts';

const props = (activeChannelId: string | null = null) => ({
  channels: [{ _id: 'c1', name: 'general' }], activeChannelId, onSelect: vi.fn(),
});

beforeEach(() => {
  unmountChannelList();
  document.body.innerHTML = '';
  mocks.mount.mockReset(); mocks.unmount.mockReset(); mocks.logger.error.mockReset();
  mocks.mount.mockImplementation((_component, options) => ({ options, id: Math.random() }));
});

describe('channel-list view mount owner', () => {
  it('mounts once, remounts on prop changes and updates active channel', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    expect(await mountOrUpdateChannelList(host, props())).toBe(true);
    expect(mocks.mount).toHaveBeenCalledTimes(1);

    expect(await mountOrUpdateChannelList(host, props('c1'))).toBe(true);
    expect(mocks.unmount).toHaveBeenCalledTimes(1);
    expect(mocks.mount).toHaveBeenCalledTimes(2);

    updateActiveChannel('c2');
    expect(mocks.unmount).toHaveBeenCalledTimes(2);
    expect(mocks.mount).toHaveBeenCalledTimes(3);
    expect(mocks.mount.mock.calls[2][1].props.activeChannelId).toBe('c2');

    updateActiveChannel('c2');
    expect(mocks.mount).toHaveBeenCalledTimes(3);
  });

  it('invalidates a pending mount when unmounted before dynamic imports settle', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const pending = mountOrUpdateChannelList(host, props());
    unmountChannelList();
    expect(await pending).toBe(false);
    expect(mocks.mount).not.toHaveBeenCalled();
    expect(host.querySelector('.channel-list-svelte-root')).toBeNull();
  });

  it('lets only the newest concurrent mount own the host', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    const first = mountOrUpdateChannelList(host, props('old'));
    const second = mountOrUpdateChannelList(host, props('new'));
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(mocks.mount).toHaveBeenCalledTimes(1);
    expect(mocks.mount.mock.calls[0][1].props.activeChannelId).toBe('new');
  });

  it('fails closed and removes the mount point when component mount throws', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    mocks.mount.mockImplementationOnce(() => { throw new Error('boom'); });
    expect(await mountOrUpdateChannelList(host, props())).toBe(false);
    expect(host.querySelector('.channel-list-svelte-root')).toBeNull();
    expect(mocks.logger.error).toHaveBeenCalled();
  });

  it('unmount is idempotent and releases the current instance', async () => {
    const host = document.createElement('div'); document.body.appendChild(host);
    await mountOrUpdateChannelList(host, props());
    unmountChannelList(); unmountChannelList();
    expect(mocks.unmount).toHaveBeenCalledTimes(1);
  });
});
