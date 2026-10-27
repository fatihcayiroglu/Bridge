import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import MessageLoader from '../js/core/MessageLoader.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import {
  readLocalFirstHistory,
  clearLocalFirstHistoryChannel,
  replaceLocalFirstHistory,
  resetLocalFirstHistoryRuntimeForTests,
} from '../js/core/local-first/history-runtime.ts';

type Handler = (...args: unknown[]) => void;

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: 'https://bridge.invalid/messages',
    headers: new Headers(),
    typed: async () => body,
  } as never;
}

function socketHarness() {
  const handlers = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event: string, handler: Handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter(fn => fn !== handler));
    },
    emit: vi.fn(),
    fire(event: string, ...args: unknown[]) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(...args);
    },
  };
}

const owned = [
  'socket', 'getCurrentChannel', 'getMe',
  'setMessagesLoading', 'setMessagesError', 'setMessagesOffline', 'setMessages',
  'setFirstUnreadAnchor', 'setMessageCursor', 'setMessagesHasMore',
  'getMessageCursor', 'prependMessages', 'appendMessage', 'replaceMessage',
  'resolvePendingSend', 'failPendingSend', 'rejectPendingSend', 'noteSpamWarning',
  'resolveEditMutation', 'failEditMutation', 'resolveDeleteMutation',
  'updateMessage', 'removeMessage', 'getMessages',
  'setTypingUser', 'clearTypingUser', 'clearTypingUsers', 'getTypingUsers',
  'loadMessages', 'loadOlderMessages', 'getActiveChannelId',
] as const;

let socket: ReturnType<typeof socketHarness>;
let currentChannel: { _id: string } | null;
let messages: Array<Record<string, unknown>>;
let errorText: string;
let offline: boolean;
let loading: boolean;

function registerState(userId: string): void {
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  BridgeRegistry.register('getCurrentChannel', () => currentChannel);
  BridgeRegistry.register('getMe', () => ({ _id: userId }));

  BridgeRegistry.register('setMessagesLoading', (value: boolean) => { loading = value; });
  BridgeRegistry.register('setMessagesError', (value: string) => { errorText = String(value ?? ''); });
  BridgeRegistry.register('setMessagesOffline', (value: boolean) => { offline = value === true; });
  BridgeRegistry.register('setMessages', (value: Array<Record<string, unknown>>) => {
    const serverIds = new Set((value ?? []).map(row => row._id));
    const localOnly = messages.filter(row => (row.pending || row.failed) && !serverIds.has(row._id));
    messages = [...(value ?? []), ...localOnly];
  });
  BridgeRegistry.register('setFirstUnreadAnchor', () => undefined);
  BridgeRegistry.register('setMessageCursor', () => undefined);
  BridgeRegistry.register('setMessagesHasMore', () => undefined);
  BridgeRegistry.register('getMessageCursor', () => null);
  BridgeRegistry.register('prependMessages', () => 0);
  BridgeRegistry.register('appendMessage', (value: Record<string, unknown>) => {
    if (messages.some(row => row._id === value._id)) return false;
    messages.push(value);
    return true;
  });
  BridgeRegistry.register('replaceMessage', () => false);
  BridgeRegistry.register('resolvePendingSend', () => undefined);
  BridgeRegistry.register('failPendingSend', () => undefined);
  BridgeRegistry.register('rejectPendingSend', () => undefined);
  BridgeRegistry.register('noteSpamWarning', () => undefined);
  BridgeRegistry.register('resolveEditMutation', () => undefined);
  BridgeRegistry.register('failEditMutation', () => undefined);
  BridgeRegistry.register('resolveDeleteMutation', () => undefined);
  BridgeRegistry.register('updateMessage', (patch: Record<string, unknown>) => {
    const index = messages.findIndex(row => row._id === patch._id);
    if (index < 0) return false;
    messages[index] = { ...messages[index], ...patch };
    return true;
  });
  BridgeRegistry.register('removeMessage', (id: string) => {
    const before = messages.length;
    messages = messages.filter(row => row._id !== id);
    return messages.length !== before;
  });
  BridgeRegistry.register('getMessages', () => messages);
  BridgeRegistry.register('setTypingUser', () => undefined);
  BridgeRegistry.register('clearTypingUser', () => undefined);
  BridgeRegistry.register('clearTypingUsers', () => undefined);
  BridgeRegistry.register('getTypingUsers', () => new Map());
}

function select(channelId: string): void {
  currentChannel = { _id: channelId };
  document.dispatchEvent(new CustomEvent('bridge:channel-selected', {
    detail: { channelId },
  }));
}

beforeEach(() => {
  apiFetchMock.mockReset();
  resetLocalFirstHistoryRuntimeForTests();
  socket = socketHarness();
  currentChannel = null;
  messages = [];
  errorText = '';
  offline = false;
  loading = false;
});

afterEach(() => {
  cleanup();
  resetLocalFirstHistoryRuntimeForTests();
  for (const key of owned) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
});

describe('P7 MessageLoader encrypted offline history', () => {
  it('an explicit cleared selection rejects a delayed response after the expired cache was purged', async () => {
    const userId = 'expired-response-user';
    registerState(userId);
    let resolveResponse!: (value: ReturnType<typeof response>) => void;
    apiFetchMock.mockImplementation(() => new Promise(resolve => { resolveResponse = resolve; }));
    render(MessageLoader);
    select('expired');
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledOnce());
    currentChannel = null;
    messages = []; // AppState clears the selected channel and visible messages.
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: null } }));
    await clearLocalFirstHistoryChannel(userId, 'expired');
    let bodyRead = false;
    resolveResponse({ ok: true, status: 200, headers: new Headers(), typed: async () => {
      bodyRead = true;
      return { messages: [{ _id: 'stale', channelId: 'expired', content: 'must stay erased', createdAt: 1 }] };
    } } as never);
    await waitFor(() => expect(bodyRead).toBe(true));
    await waitFor(() => expect(loading).toBe(false));
    expect(messages).toEqual([]);
    await expect(readLocalFirstHistory(userId, 'expired')).resolves.toBeNull();
    expect(BridgeRegistry.call('getActiveChannelId')).toBeNull();
    expect(socket.emit).toHaveBeenCalledWith('channel:leave', 'expired');
  });

  it('keeps bare selection notifications compatible and loads a permanent channel after a clear', async () => {
    registerState('permanent-control-user');
    apiFetchMock.mockImplementation(async (url: string) => response({ messages: [{
      _id: url.includes('permanent') ? 'permanent-message' : 'old-message',
      channelId: url.includes('permanent') ? 'permanent' : 'old', content: 'authorized', createdAt: 1,
    }] }));
    render(MessageLoader); select('old');
    await waitFor(() => expect(loading).toBe(false));
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    expect(BridgeRegistry.call('getActiveChannelId')).toBe('old');
    currentChannel = null; messages = [];
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: null } }));
    select('permanent');
    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['permanent-message']));
    expect(BridgeRegistry.call('getActiveChannelId')).toBe('permanent');
    await expect(readLocalFirstHistory('permanent-control-user', 'permanent')).resolves.toMatchObject({ messages: [{ _id: 'permanent-message' }] });
  });

  it('does not admit a delayed socket message or rejoin after selection is cleared', async () => {
    registerState('expired-socket-user');
    apiFetchMock.mockResolvedValue(response({ messages: [] }));
    render(MessageLoader); select('expired');
    await waitFor(() => expect(loading).toBe(false));
    currentChannel = null;
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: null } }));
    socket.emit.mockClear();
    socket.fire('message:new', { _id: 'late-socket', channelId: 'expired', content: 'stale', createdAt: 1 });
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(messages).toEqual([]);
    expect(socket.emit).not.toHaveBeenCalled();
    await expect(readLocalFirstHistory('expired-socket-user', 'expired')).resolves.toMatchObject({ messages: [] });
  });

  it('renders encrypted cached history on a network failure and labels it stale/offline', async () => {
    const userId = 'offline-user';
    const channelId = 'offline-channel';
    registerState(userId);
    await replaceLocalFirstHistory(userId, channelId, [{
      _id: 'cached-1',
      channelId,
      content: 'cached secret',
      createdAt: 1,
    }]);
    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(MessageLoader);
    select(channelId);

    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['cached-1']));
    await waitFor(() => expect(loading).toBe(false));
    expect(offline).toBe(true);
    expect(errorText).toBe('');
  });

  it("uses the cached history when the service worker answers a failed fetch (its offline 503)", async () => {
    // Under a service worker the page never sees the rejected fetch: it gets a
    // synthetic 503 marked X-Bridge-Offline (client/sw.ts). Before the marker
    // was read, this showed "server error" and discarded the cached window.
    const userId = 'sw-offline-user';
    const channelId = 'sw-offline-channel';
    registerState(userId);
    await replaceLocalFirstHistory(userId, channelId, [{ _id: 'cached-1', channelId, content: 'cached', createdAt: 1 }]);
    apiFetchMock.mockResolvedValue({
      ...(response({ error: 'offline' }, 503) as object),
      headers: new Headers({ 'X-Bridge-Offline': '1' }),
    });

    render(MessageLoader);
    select(channelId);

    await waitFor(() => expect(loading).toBe(false));
    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['cached-1']));
    expect(offline).toBe(true);
    expect(errorText).toBe('');
  });

  it('after an offline open, the server-validated session reads the same channel from the server again', async () => {
    const userId = 'reload-user';
    const channelId = 'reload-channel';
    registerState(userId);
    await replaceLocalFirstHistory(userId, channelId, [{ _id: 'cached-1', channelId, content: 'cached', createdAt: 1 }]);
    apiFetchMock.mockResolvedValue({ ...(response({ error: 'offline' }, 503) as object), headers: new Headers({ 'X-Bridge-Offline': '1' }) });

    render(MessageLoader);
    select(channelId);
    await waitFor(() => expect(offline).toBe(true));

    apiFetchMock.mockResolvedValue(response({ messages: [
      { _id: 'cached-1', channelId, content: 'cached', createdAt: 1 },
      { _id: 'written-meanwhile', channelId, content: 'new', createdAt: 2 },
    ] }));
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['cached-1', 'written-meanwhile']));
    expect(offline).toBe(false);

    // Logout (including a refusal after reconnect) empties the view.
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    expect(messages).toEqual([]);
  });

  it('server-authoritative 403 clears cached history instead of using past authorization', async () => {
    const userId = 'revoked-user';
    const channelId = 'revoked-channel';
    registerState(userId);
    await replaceLocalFirstHistory(userId, channelId, [{
      _id: 'must-disappear',
      channelId,
      content: 'past authorization only',
      createdAt: 1,
    }]);
    apiFetchMock.mockResolvedValue(response({}, 403));

    render(MessageLoader);
    select(channelId);

    await waitFor(() => expect(loading).toBe(false));
    await waitFor(() => expect(messages).toEqual([]));
    expect(offline).toBe(false);
    expect(errorText).not.toBe('');
    await expect(readLocalFirstHistory(userId, channelId)).resolves.toBeNull();
  });

  it('a live delete writes a tombstone so stale server data cannot resurrect the message', async () => {
    const userId = 'delete-user';
    const channelId = 'delete-channel';
    registerState(userId);
    apiFetchMock.mockResolvedValue(response({
      messages: [{ _id: 'm1', channelId, content: 'delete me', createdAt: 1 }],
      hasMore: false,
    }));

    render(MessageLoader);
    select(channelId);
    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['m1']));
    await waitFor(async () => {
      const cached = await readLocalFirstHistory(userId, channelId);
      expect(cached?.messages.map(row => row._id)).toEqual(['m1']);
    });

    socket.fire('message:deleted', { id: 'm1' });
    await waitFor(() => expect(messages).toEqual([]));

    const afterDelete = await readLocalFirstHistory(userId, channelId);
    expect(afterDelete?.messages).toEqual([]);
    expect(afterDelete?.tombstones.map(row => row.id)).toContain('m1');

    // Simulate a stale page/snapshot arriving later: the tombstone still wins.
    await replaceLocalFirstHistory(userId, channelId, [{
      _id: 'm1', channelId, content: 'stale copy', createdAt: 1,
    }]);
    const final = await readLocalFirstHistory(userId, channelId);
    expect(final?.messages).toEqual([]);
  });
});

describe('P7 MessageLoader offline history — honest failure states', () => {
  it('a network failure with nothing cached shows the error, not an empty "offline" channel', async () => {
    registerState('empty-cache-user');
    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(MessageLoader);
    select('never-cached');

    await waitFor(() => expect(loading).toBe(false));
    expect(messages).toEqual([]);
    expect(offline).toBe(false);
    expect(errorText).not.toBe('');
  });

  it('a server error after the cached window is shown keeps that window labelled stale', async () => {
    const userId = 'server-error-user';
    const channelId = 'server-error-channel';
    registerState(userId);
    await replaceLocalFirstHistory(userId, channelId, [{ _id: 'cached-1', channelId, content: 'cached', createdAt: 1 }]);
    let fail!: () => void;
    apiFetchMock.mockImplementation(() => new Promise((resolve) => { fail = () => resolve(response({}, 500)); }));

    render(MessageLoader);
    select(channelId);
    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['cached-1']));
    expect(offline).toBe(true);

    fail();
    await waitFor(() => expect(loading).toBe(false));
    expect(errorText).not.toBe('');
    // Content still on screen must never be presented as current server truth.
    expect(messages.map(row => row._id)).toEqual(['cached-1']);
    expect(offline).toBe(true);
  });

  it('older pages loaded from the server are merged into the encrypted cache', async () => {
    const userId = 'older-user';
    const channelId = 'older-channel';
    registerState(userId);
    BridgeRegistry.register('getMessageCursor', () => 'cursor-1');
    apiFetchMock
      .mockResolvedValueOnce(response({ messages: [{ _id: 'new', channelId, content: 'new', createdAt: 10 }], hasMore: true, prevCursor: 'cursor-1' }))
      .mockResolvedValueOnce(response({ messages: [{ _id: 'old', channelId, content: 'old', createdAt: 1 }], hasMore: false }));

    render(MessageLoader);
    select(channelId);
    await waitFor(() => expect(messages.map(row => row._id)).toEqual(['new']));
    await BridgeRegistry.call<Promise<void>>('loadOlderMessages');

    await waitFor(async () => {
      const cached = await readLocalFirstHistory(userId, channelId);
      expect(cached?.messages.map(row => row._id)).toEqual(['old', 'new']);
    });
  });
});
