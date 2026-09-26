import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const { controllerFactory, loadMock, stateOfMock } = vi.hoisted(() => {
  const load = vi.fn(async () => true);
  const stateOf = vi.fn(() => undefined);
  return {
    loadMock: load,
    stateOfMock: stateOf,
    controllerFactory: vi.fn(() => ({
      snapshot: {
        roles: [{ _id: 'runtime-role', name: 'Runtime role' }],
        selectedRoleId: undefined,
        loading: undefined,
        saving: undefined,
        dirty: undefined,
        error: undefined,
        explanationLoading: undefined,
        explanationError: undefined,
        explanation: undefined,
        rolePreviewLoading: undefined,
        rolePreviewError: undefined,
        rolePreview: undefined,
      },
      load,
      stateOf,
      selectRole: vi.fn(),
      setState: vi.fn(),
      reset: vi.fn(),
      loadExplanation: vi.fn(async () => true),
      loadRolePreview: vi.fn(async () => true),
      save: vi.fn(async () => true),
    })),
  };
});

vi.mock('../js/core/channel-perms/channelPermsStore.ts', () => ({
  CHANNEL_PERMISSIONS: [{ bit: 1, key: 'VIEW_CHANNELS', label: 'Kanalı görüntüle' }],
  createChannelPermsController: controllerFactory,
}));
vi.mock('../js/core/permissions/myPermissions.ts', () => ({
  canManageChannels: vi.fn(async () => true),
  clearPermsCache: vi.fn(),
}));

import ChannelActionMenu from '../js/core/channel-perms/ChannelActionMenu.svelte';

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  controllerFactory.mockClear();
  loadMock.mockClear();
  stateOfMock.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-runtime' }));
  instance = mount(ChannelActionMenu, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  BridgeRegistry.unregister('getCurrentServer');
  document.body.innerHTML = '';
});

describe('ChannelActionMenu runtime fallback contract', () => {
  it('normalizes missing snapshot fields and an unknown state without exposing undefined UI', async () => {
    await BridgeRegistry.call(
      'openChannelMenu', 'chan-runtime', 'runtime',
      new MouseEvent('click', { clientX: 7, clientY: 9 }),
    );
    flushSync();
    document.querySelector<HTMLButtonElement>('.cam-item')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.cp-card')).not.toBeNull();
      expect(loadMock).toHaveBeenCalledTimes(1);
    });
    expect(controllerFactory).toHaveBeenCalledWith('srv-runtime', 'chan-runtime');
    expect(document.querySelector('.cp-error')).toBeNull();
    expect(document.querySelector('.cp-hint')).toBeNull();
    expect(document.querySelectorAll('.cp-row')).toHaveLength(1);
    expect(document.querySelector('.cp-state[data-state="inherit"]')).toHaveAttribute('aria-checked', 'true');
    expect(stateOfMock).toHaveBeenCalledWith('', 1);
  });

  it('treats a transient null snapshot as an empty loading-safe editor state', async () => {
    controllerFactory.mockImplementationOnce(() => ({
      snapshot: null,
      load: loadMock,
      stateOf: stateOfMock,
      selectRole: vi.fn(), setState: vi.fn(), reset: vi.fn(),
      loadExplanation: vi.fn(async () => true),
      loadRolePreview: vi.fn(async () => true),
      save: vi.fn(async () => true),
    }) as never);

    await BridgeRegistry.call(
      'openChannelMenu', 'chan-runtime', 'runtime',
      new MouseEvent('click', { clientX: 7, clientY: 9 }),
    );
    flushSync();
    document.querySelector<HTMLButtonElement>('.cam-item')!.click();

    await vi.waitFor(() => {
      flushSync();
      expect(document.querySelector('.cp-card')).not.toBeNull();
      expect(loadMock).toHaveBeenCalledTimes(1);
    });
    expect(document.querySelectorAll('.cp-role')).toHaveLength(0);
    expect(document.querySelector('.cp-error')).toBeNull();
  });
});

// Final21 UX: Esc ile kapanan kanal işlemleri menüsü odağı açan düğmeye döndürmüyordu (yüzey
// taramasında tek istisna); klavye kullanıcısı kanal listesinde yerini kaybediyordu.
describe('ChannelActionMenu keyboard contract', () => {
  it('Escape closes the menu and returns focus to its trigger', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    await BridgeRegistry.call('openChannelMenu', 'chan-1', 'genel', new MouseEvent('click', { clientX: 5, clientY: 5 }));
    await vi.waitFor(() => { flushSync(); expect(document.querySelector('.cam-item')).not.toBeNull(); });
    expect(document.activeElement).toBe(document.querySelector('.cam-item'));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(document.querySelector('.cam-item')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
