import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mountMock, unmountMock, infoMock } = vi.hoisted(() => ({
  mountMock: vi.fn(() => ({ shim: true })),
  unmountMock: vi.fn(async () => undefined),
  infoMock: vi.fn(),
}));

vi.mock('svelte', () => ({ mount: mountMock, unmount: unmountMock }));
vi.mock('../js/core/channel-perms/ChannelActionMenu.svelte', () => ({ default: function FakeMenu() {} }));
vi.mock('../js/core/logger.ts', () => ({ createLogger: () => ({ info: infoMock }) }));

function readyState(value: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { configurable: true, value });
}

beforeEach(() => {
  vi.resetModules();
  mountMock.mockClear();
  unmountMock.mockClear();
  infoMock.mockClear();
  document.body.innerHTML = '';
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).readyState;
  document.body.innerHTML = '';
});

describe('channel action menu mount adapter', () => {
  it('defers boot until DOMContentLoaded and mounts only one body-level owner', async () => {
    readyState('loading');
    const mod = await import('../js/core/channel-perms/channel-action-menu-svelte.ts');
    expect(mountMock).not.toHaveBeenCalled();

    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(mountMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#channel-action-menu-root')).toHaveLength(1);
    expect(mountMock.mock.calls[0]![1]).toMatchObject({
      target: document.querySelector('#channel-action-menu-root'),
    });
    expect(infoMock).toHaveBeenCalledTimes(1);

    mod.mountChannelActionMenu();
    expect(mountMock).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#channel-action-menu-root')).toHaveLength(1);

    mod.unmountChannelActionMenu();
    expect(unmountMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#channel-action-menu-root')).toBeNull();

    mod.unmountChannelActionMenu();
    expect(unmountMock).toHaveBeenCalledTimes(1);
  });

  it('boots immediately after the document is ready and can mount again after cleanup', async () => {
    readyState('complete');
    const mod = await import('../js/core/channel-perms/channel-action-menu-svelte.ts');
    expect(mountMock).toHaveBeenCalledTimes(1);

    mod.unmountChannelActionMenu();
    mod.mountChannelActionMenu();
    expect(mountMock).toHaveBeenCalledTimes(2);
    expect(document.querySelectorAll('#channel-action-menu-root')).toHaveLength(1);

    mod.unmountChannelActionMenu();
  });
});
