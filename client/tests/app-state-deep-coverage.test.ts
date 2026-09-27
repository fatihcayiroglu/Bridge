import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const mocks = vi.hoisted(() => {
  const registry = new Map<string, unknown>();
  return {
    registry,
    register: vi.fn((name: string, value: unknown) => registry.set(name, value)),
    unregister: vi.fn((name: string) => registry.delete(name)),
    get: vi.fn((name: string) => registry.get(name) ?? null),
    info: vi.fn(),
  };
});

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: mocks.register,
    unregister: mocks.unregister,
    get: mocks.get,
  },
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: mocks.info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import AppState from '../js/core/AppState.svelte';

type Fn = (...args: any[]) => any;
let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null = null;

function action<T extends Fn = Fn>(name: string): T {
  const value = mocks.registry.get(name);
  if (typeof value !== 'function') throw new Error(`missing AppState registry action: ${name}`);
  return value as T;
}
function get<T>(name: string): T { return action<() => T>(name)(); }

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).currentUser;
  mocks.registry.clear();
  mocks.register.mockClear();
  mocks.unregister.mockClear();
  mocks.get.mockClear();
  mocks.info.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (instance) await unmount(instance);
  instance = null;
  host.remove();
  delete (globalThis as Record<string, unknown>).currentUser;
});

function boot(): void {
  instance = mount(AppState, { target: host });
}

describe('AppState deep canonical owner behavior', () => {
  it('owns auth/user/socket state, catches late auth success and ignores malformed auth details', async () => {
    (globalThis as Record<string, unknown>).currentUser = { _id: 'boot-user', username: 'boot' };
    boot();
    expect(get<{ _id: string } | null>('getMe')?._id).toBe('boot-user');
    expect(get('getSocketConnected')).toBe(false);

    action<(value: unknown) => void>('setMe')({ _id: 'manual-user' });
    expect(get<{ _id: string }>('me')._id).toBe('manual-user');
    action<(value: boolean) => void>('setSocketConnected')(1 as unknown as boolean);
    expect(get('getSocketConnected')).toBe(true);

    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: { _id: 'event-user' } }));
    await tick();
    expect(get<{ _id: string }>('getMe')._id).toBe('event-user');
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: null }));
    document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: 'bad' }));
    expect(get<{ _id: string }>('getMe')._id).toBe('event-user');
  });

  it('resets cross-server/channel state only when identity changes and normalizes scalar setters', () => {
    boot();
    const setServer = action<(server: any) => void>('setCurrentServer');
    const setChannel = action<(channel: any) => void>('setCurrentChannel');
    setServer({ _id: 's1', name: 'One' });
    setChannel({ _id: 'c1', name: 'general' });
    action<(channels: any) => void>('setCurrentServerChannels')([{ _id: 'c1' }]);
    action<(message: any) => boolean>('appendMessage')({ _id: 'm1', createdAt: 1 });
    action<(id: string, name: string) => void>('setTypingUser')('u1', 'Alice');
    action<(v: any) => void>('setMessagesError')('boom');
    action<(v: any) => void>('setMessageCursor')('cur');
    action<(v: any) => void>('setMessagesHasMore')(1);

    // Same identities update metadata but preserve channel/message context.
    setServer({ _id: 's1', name: 'One renamed' });
    setChannel({ _id: 'c1', name: 'general renamed' });
    expect(get<any>('getCurrentServer').name).toBe('One renamed');
    expect(get<any>('getCurrentChannel').name).toBe('general renamed');
    expect(get<any[]>('getMessages')).toHaveLength(1);

    // Real server transition must drop all stale tenant state.
    setServer({ _id: 's2', name: 'Two' });
    expect(get('getCurrentChannel')).toBeNull();
    expect(get<any[]>('getCurrentServerChannels')).toEqual([]);
    expect(get<any[]>('getMessages')).toEqual([]);
    expect(get<Map<string, string>>('getTypingUsers').size).toBe(0);
    expect(get('getMessagesError')).toBe('');
    expect(get('getMessageCursor')).toBeNull();
    expect(get('getMessagesHasMore')).toBe(false);

    action<(channels: any) => void>('setCurrentServerChannels')(null);
    expect(get<any[]>('getCurrentServerChannels')).toEqual([]);
    action<(v: any) => void>('setMessagesError')(null);
    action<(v: any) => void>('setMessageCursor')(undefined);
    action<(v: any) => void>('setMessagesHasMore')(0);
    expect(get('getMessagesError')).toBe('');
    expect(get('getMessageCursor')).toBeNull();
    expect(get('getMessagesHasMore')).toBe(false);
  });

  it('preserves only unresolved local messages during resync and exercises append/prepend/update/remove boundaries', () => {
    boot();
    const append = action<(m: any) => boolean>('appendMessage');
    expect(append(null)).toBe(false);
    expect(append({ _id: '', createdAt: 2 })).toBe(false);
    expect(append({ _id: 'pending:a', pending: true, createdAt: 300, content: 'p' })).toBe(true);
    expect(append({ _id: 'failed:b', failed: true, createdAt: '250', content: 'f' })).toBe(true);
    expect(append({ _id: 'server-old', createdAt: 100 })).toBe(true);
    expect(append({ _id: 'server-old', createdAt: 50 })).toBe(false);

    action<(list: any) => void>('setMessages')([
      { _id: 'server-new', createdAt: '200' },
      { _id: 'failed:b', createdAt: 260 },
    ]);
    expect(get<any[]>('messages').map(m => m._id)).toEqual(['server-new', 'failed:b', 'pending:a']);
    expect(get<any[]>('messages').some(m => m._id === 'server-old')).toBe(false);

    const prepend = action<(list: any[]) => number>('prependMessages');
    expect(prepend([{ _id: '' }, null as any, { _id: 'server-new', createdAt: 2 }, { _id: 'older', createdAt: 1 }])).toBe(1);
    expect(get<any[]>('getMessages')[0]._id).toBe('older');
    expect(prepend([])).toBe(0);

    const update = action<(m: any) => boolean>('updateMessage');
    expect(update(null)).toBe(false);
    expect(update({ _id: 'missing', content: 'x' })).toBe(false);
    expect(update({ _id: 'server-new', content: 'patched' })).toBe(true);
    expect(get<any[]>('getMessages').find(m => m._id === 'server-new')?.content).toBe('patched');

    const remove = action<(id: string) => boolean>('removeMessage');
    expect(remove('missing')).toBe(false);
    expect(remove('older')).toBe(true);
    expect(get<any[]>('getMessages').some(m => m._id === 'older')).toBe(false);
  });

  it('reconciles replacement ids both before and after broadcast while preserving the stable render key', () => {
    boot();
    const setMessages = action<(m: any[]) => void>('setMessages');
    const replace = action<(id: string, patch: any) => boolean>('replaceMessage');
    const append = action<(m: any) => boolean>('appendMessage');

    expect(replace('missing', { _id: 'x' })).toBe(false);
    setMessages([{ _id: 'pending:1', _key: 'stable:1', pending: true, content: 'one', createdAt: 20 }]);
    expect(replace('pending:1', { _id: 'real:1', pending: false, createdAt: 10 })).toBe(true);
    expect(get<any[]>('getMessages')[0]).toEqual(expect.objectContaining({ _id: 'real:1', _key: 'stable:1', content: 'one' }));

    setMessages([{ _id: 'pending:2', _key: 'stable:2', pending: true, createdAt: 10 }]);
    append({ _id: 'real:2', content: 'canonical', createdAt: 20 });
    expect(replace('pending:2', { _id: 'real:2', pending: false })).toBe(true);
    const rows = get<any[]>('getMessages');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({ _id: 'real:2', _key: 'stable:2', content: 'canonical' }));
  });

  it('owns typing maps without mutation leaks and unregisters only registry entries it still owns', async () => {
    boot();
    // Svelte 5 commits lifecycle hooks on the next flush.  This assertion is
    // specifically about onDestroy ownership cleanup, so let the mount commit
    // before tearing the component down again.
    await tick();
    const setTyping = action<(id: string, name: string) => void>('setTypingUser');
    const clearTyping = action<(id: string) => void>('clearTypingUser');
    setTyping('u1', 'Alice');
    setTyping('u2', 'Bob');
    const snapshot = get<Map<string, string>>('getTypingUsers');
    expect([...snapshot.entries()]).toEqual([['u1', 'Alice'], ['u2', 'Bob']]);
    clearTyping('missing');
    clearTyping('u1');
    expect([...get<Map<string, string>>('getTypingUsers').entries()]).toEqual([['u2', 'Bob']]);
    action<() => void>('clearTypingUsers')();
    expect(get<Map<string, string>>('getTypingUsers').size).toBe(0);

    const foreign = vi.fn();
    mocks.registry.set('getMe', foreign);
    await unmount(instance!);
    instance = null;
    expect(mocks.registry.get('getMe')).toBe(foreign);
    expect(mocks.unregister).not.toHaveBeenCalledWith('getMe');
    expect(mocks.unregister).toHaveBeenCalledWith('getCurrentServer');
  });
});
