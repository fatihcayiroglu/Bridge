import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  createNavigationHistory,
  navigationHistory,
  navigationLocationKey,
  normalizeNavigationLocation,
  type NavigationLocation,
} from '../js/core/navigation-history.ts';

const channel = (channelId: string, messageId?: string): NavigationLocation => ({
  type: 'channel', channelId, server: { _id: 'server-1', name: 'Bridge' },
  ...(messageId ? { messageId } : {}),
});

beforeEach(() => navigationHistory.reset());

afterEach(() => {
  navigationHistory.reset();
  for (const key of ['navigateToChannel', 'openDm', 'groupDmPanel:openGroupDm', 'toast']) {
    BridgeRegistry.unregister(key);
  }
  vi.restoreAllMocks();
});

describe('navigation history controller', () => {
  it('normalizes to destination metadata and drops content/secrets', () => {
    const normalized = normalizeNavigationLocation({
      type: 'dm',
      user: { _id: 'user-1', displayName: 'Ada', avatarColor: '#123456', token: 'SECRET', email: 'private@example.test' },
      messageId: 'message-1',
      content: 'private message body',
      accessToken: 'SECRET',
    });

    expect(normalized).toEqual({
      type: 'dm', user: { _id: 'user-1', displayName: 'Ada', avatarColor: '#123456' }, messageId: 'message-1',
    });
    expect(JSON.stringify(normalized)).not.toMatch(/SECRET|private message body|private@example/);
  });

  it('collapses repeats and A → B → A → B loop pollution', () => {
    const history = createNavigationHistory(() => true);
    history.record(channel('A'));
    history.record(channel('A'));
    history.record(channel('B'));
    history.record(channel('A'));
    history.record(channel('B'));

    expect(history.snapshot()).toMatchObject({ length: 2, index: 1, canBack: true, canForward: false });
    expect(history.snapshot().locations.map(item => item.key)).toEqual([
      'channel:server-1:A:', 'channel:server-1:B:',
    ]);
  });

  it('Back/Forward replays without appending duplicate entries', async () => {
    let history!: ReturnType<typeof createNavigationHistory>;
    const replay = vi.fn(async (location: NavigationLocation) => {
      history.record(location); // what the canonical owner does after success
      return true;
    });
    history = createNavigationHistory(replay);
    history.record(channel('A'));
    history.record(channel('B'));
    history.record({ type: 'dm', user: { _id: 'user-1', displayName: 'Ada' } });

    expect(await history.back()).toBe(true);
    expect(await history.forward()).toBe(true);

    expect(history.snapshot()).toMatchObject({ length: 3, index: 2 });
    expect(replay.mock.calls.map(call => call[0])).toEqual([channel('B'), {
      type: 'dm', user: { _id: 'user-1', displayName: 'Ada' },
    }]);
  });

  it('skips and removes an inaccessible target instead of restoring it', async () => {
    const replay = vi.fn(async (location: NavigationLocation) => (
      location.type === 'channel' && location.channelId !== 'B'
    ));
    const history = createNavigationHistory(replay);
    history.record(channel('A'));
    history.record(channel('B'));
    history.record(channel('C'));

    expect(await history.back()).toBe(true);
    expect(replay.mock.calls.map(call => (call[0] as NavigationLocation & { channelId: string }).channelId)).toEqual(['B', 'A']);
    expect(history.snapshot().locations.map(item => item.key)).toEqual([
      'channel:server-1:A:', 'channel:server-1:C:',
    ]);
    expect(history.snapshot()).toMatchObject({ index: 0, canForward: true });
  });

  it('degrades gracefully when every prior target is stale', async () => {
    const unavailable = vi.fn();
    const history = createNavigationHistory(() => false, unavailable);
    history.record(channel('A'));
    history.record(channel('B'));

    expect(await history.back()).toBe(false);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(history.snapshot()).toMatchObject({ length: 1, index: 0, canBack: false });
  });

  it('a fresh destination after Back truncates the old forward branch', async () => {
    let history!: ReturnType<typeof createNavigationHistory>;
    history = createNavigationHistory(location => { history.record(location); return true; });
    history.record(channel('A'));
    history.record(channel('B'));
    history.record(channel('C'));
    await history.back();
    history.record(channel('D'));

    expect(history.snapshot().locations.map(item => item.key)).toEqual([
      'channel:server-1:A:', 'channel:server-1:B:', 'channel:server-1:D:',
    ]);
    expect(history.snapshot().canForward).toBe(false);
  });

  it('caps memory growth at 100 identifier-only destinations', () => {
    const history = createNavigationHistory(() => true);
    for (let i = 0; i < 130; i += 1) history.record(channel(`channel-${i}`));

    expect(history.snapshot()).toMatchObject({ length: 100, index: 99 });
    expect(history.snapshot().locations[0]?.key).toContain('channel-30');
  });

  it('rejects malformed destination shapes and normalizes every identifier-only variant', () => {
    for (const value of [null, '', [], {}, { type: 'channel', channelId: ' ' }, { type: 'dm', user: null }, { type: 'gdm', group: {} }]) {
      expect(normalizeNavigationLocation(value)).toBeNull();
    }
    expect(normalizeNavigationLocation({
      type: 'channel', channelId: ' channel-1 ', messageId: ' message-1 ',
      server: { _id: ' server-1 ', name: ' Bridge ', secret: 'drop' },
    })).toEqual({
      type: 'channel', channelId: 'channel-1', messageId: 'message-1',
      server: { _id: 'server-1', name: 'Bridge' },
    });
    expect(normalizeNavigationLocation({ type: 'gdm', group: { _id: ' group-1 ', name: ' Team ', members: ['secret'] } }))
      .toEqual({ type: 'gdm', group: { _id: 'group-1', name: 'Team' } });
    expect(navigationLocationKey({ type: 'dm', user: { _id: 'user-1' } })).toBe('dm:user-1:');
    expect(navigationLocationKey({ type: 'gdm', group: { _id: 'group-1' }, messageId: 'm1' })).toBe('gdm:group-1:m1');
  });

  it('serializes Back operations so a held shortcut cannot start duplicate replays', async () => {
    let release!: (value: boolean) => void;
    const replay = vi.fn(() => new Promise<boolean>(resolve => { release = resolve; }));
    const history = createNavigationHistory(replay);
    history.record(channel('A')); history.record(channel('B'));

    const first = history.back();
    await Promise.resolve();
    await expect(history.back()).resolves.toBe(false);
    expect(replay).toHaveBeenCalledOnce();
    release(true);
    await expect(first).resolves.toBe(true);
    expect(history.snapshot().index).toBe(0);
  });

  it('cancels a stale asynchronous replay when a newer user navigation wins', async () => {
    let release!: (value: boolean) => void;
    const history = createNavigationHistory(() => new Promise<boolean>(resolve => { release = resolve; }));
    history.record(channel('A')); history.record(channel('B'));
    const back = history.back();
    await Promise.resolve();

    expect(history.record(channel('C'))).toBe(true);
    release(true);
    await expect(back).resolves.toBe(false);
    expect(history.snapshot().locations.map(item => item.key)).toEqual([
      'channel:server-1:A:', 'channel:server-1:B:', 'channel:server-1:C:',
    ]);
    expect(history.snapshot().index).toBe(2);
  });

  it('removes destinations whose owner throws and reports unavailability only after exhausting history', async () => {
    const unavailable = vi.fn();
    const history = createNavigationHistory(async () => { throw new Error('permission revoked'); }, unavailable);
    history.record(channel('A')); history.record(channel('B'));

    await expect(history.back()).resolves.toBe(false);
    expect(unavailable).toHaveBeenCalledOnce();
    expect(history.snapshot()).toMatchObject({ length: 1, index: 0 });
  });

  it('optional metadata yokken channel/DM/GDM sekillerini ve anahtarlarini daraltir', () => {
    expect(normalizeNavigationLocation({ type: 'channel', channelId: 'c1' }))
      .toEqual({ type: 'channel', channelId: 'c1' });
    expect(normalizeNavigationLocation({ type: 'channel', channelId: 'c1', server: { _id: 's1' } }))
      .toEqual({ type: 'channel', channelId: 'c1', server: { _id: 's1' } });
    expect(normalizeNavigationLocation({ type: 'dm', user: { _id: 'u1' } }))
      .toEqual({ type: 'dm', user: { _id: 'u1' } });
    expect(normalizeNavigationLocation({ type: 'gdm', group: { _id: 'g1' } }))
      .toEqual({ type: 'gdm', group: { _id: 'g1' } });
    expect(normalizeNavigationLocation({ type: 'gdm', group: 'g1' })).toBeNull();
    expect(navigationLocationKey({ type: 'channel', channelId: 'c1' })).toBe('channel::c1:');
  });

  it('sinirda Back cagrisi hedef atlamadan false doner', async () => {
    const unavailable = vi.fn();
    const history = createNavigationHistory(() => true, unavailable);
    history.record(channel('A'));
    await expect(history.back()).resolves.toBe(false);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('erisilemeyen ileri hedefi kaldirir ve pozitif yonde sinira kadar yurur', async () => {
    let reachable = true;
    const unavailable = vi.fn();
    const history = createNavigationHistory(() => reachable, unavailable);
    history.record(channel('A')); history.record(channel('B')); history.record(channel('C'));
    await expect(history.back()).resolves.toBe(true);
    reachable = false;

    await expect(history.forward()).resolves.toBe(false);
    expect(history.snapshot().locations.map(item => item.key)).toEqual([
      'channel:server-1:A:', 'channel:server-1:B:',
    ]);
    expect(history.snapshot().index).toBe(1);
    expect(unavailable).toHaveBeenCalledOnce();
  });
});

describe('production keyboard/registry integration', () => {
  it('Alt+Left / Alt+Right use canonical owners and prevent browser navigation', async () => {
    const navigate = vi.fn(async (channelId: string, messageId?: string, server?: { _id: string; name?: string }) => {
      BridgeRegistry.call('recordNavigationLocation', { type: 'channel', channelId, messageId, server });
      return true;
    });
    BridgeRegistry.register('navigateToChannel', navigate);
    BridgeRegistry.call('recordNavigationLocation', channel('A'));
    BridgeRegistry.call('recordNavigationLocation', channel('B', 'message-2'));

    const back = new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(back);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('A', undefined, { _id: 'server-1', name: 'Bridge' }));
    await vi.waitFor(() => expect(navigationHistory.snapshot().index).toBe(0));
    expect(back.defaultPrevented).toBe(true);

    const forward = new KeyboardEvent('keydown', { key: 'ArrowRight', altKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(forward);
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('B', 'message-2', { _id: 'server-1', name: 'Bridge' }));
    await vi.waitFor(() => expect(navigationHistory.snapshot().index).toBe(1));
    expect(forward.defaultPrevented).toBe(true);
    expect(navigationHistory.snapshot()).toMatchObject({ length: 2, index: 1 });
  });

  it('logout removes the previous user\'s complete history', () => {
    BridgeRegistry.call('recordNavigationLocation', channel('private-channel'));
    expect(navigationHistory.snapshot().length).toBe(1);

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));

    expect(navigationHistory.snapshot()).toMatchObject({ length: 0, index: -1, canBack: false, canForward: false });
  });

  it('temporary overlays are not history destinations', () => {
    const accepted = ['channel', 'dm', 'gdm'];
    for (const type of ['inbox', 'saved', 'search', 'settings', 'command-palette']) {
      expect(accepted).not.toContain(type);
      expect(navigationHistory.record({ type, id: 'overlay' })).toBe(false);
    }
    expect(navigationHistory.snapshot().length).toBe(0);
  });

  it('replays DM and group-DM locations only through registered canonical owners', async () => {
    const openDm = vi.fn(async () => true);
    const openGroup = vi.fn(async () => true);
    BridgeRegistry.register('openDm', openDm);
    BridgeRegistry.register('groupDmPanel:openGroupDm', openGroup);
    BridgeRegistry.call('recordNavigationLocation', { type: 'dm', user: { _id: 'u1', displayName: 'Ada', avatarColor: '#123' }, messageId: 'dm-m' });
    BridgeRegistry.call('recordNavigationLocation', { type: 'gdm', group: { _id: 'g1', name: 'Team' }, messageId: 'gdm-m' });

    expect(await BridgeRegistry.call<Promise<boolean>>('navigateBack')).toBe(true);
    expect(openDm).toHaveBeenCalledWith('u1', 'Ada', '#123', 'dm-m');
    expect(await BridgeRegistry.call<Promise<boolean>>('navigateForward')).toBe(true);
    expect(openGroup).toHaveBeenCalledWith({ _id: 'g1', name: 'Team' }, 'gdm-m');
  });

  it('does not hijack modified/unavailable browser history shortcuts', () => {
    BridgeRegistry.call('recordNavigationLocation', channel('A'));
    const cases = [
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: false, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, ctrlKey: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, cancelable: true }),
    ];
    for (const event of cases) {
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it('kayipsa channel sahibini fail-closed reddeder ve production toastini gosterir', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    BridgeRegistry.call('recordNavigationLocation', channel('A'));
    BridgeRegistry.call('recordNavigationLocation', channel('B'));

    await expect(BridgeRegistry.call<Promise<boolean>>('navigateBack')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Geçmişteki konum artık kullanılamıyor.', 'warning');
  });

  it('kayip DM ve GDM sahipleri izin varmis gibi davranmaz', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);

    BridgeRegistry.call('recordNavigationLocation', { type: 'dm', user: { _id: 'u1' } });
    BridgeRegistry.call('recordNavigationLocation', { type: 'gdm', group: { _id: 'g1' } });
    await expect(BridgeRegistry.call<Promise<boolean>>('navigateBack')).resolves.toBe(false);

    BridgeRegistry.call('resetNavigationHistory');
    BridgeRegistry.register('navigateToChannel', vi.fn(() => true));
    BridgeRegistry.call('recordNavigationLocation', channel('A'));
    BridgeRegistry.call('recordNavigationLocation', { type: 'gdm', group: { _id: 'g1' } });
    await expect(BridgeRegistry.call<Promise<boolean>>('navigateBack')).resolves.toBe(true);
    await expect(BridgeRegistry.call<Promise<boolean>>('navigateForward')).resolves.toBe(false);
    expect(toast).toHaveBeenCalled();
  });

  it('registry state/reset sahipleri kanonik controlleri yansitir', () => {
    BridgeRegistry.call('recordNavigationLocation', channel('A'));
    expect(BridgeRegistry.call<{ length: number }>('getNavigationHistoryState')?.length).toBe(1);
    BridgeRegistry.call('resetNavigationHistory');
    expect(BridgeRegistry.call<{ length: number }>('getNavigationHistoryState')?.length).toBe(0);
  });
});
