import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

import MessageLoader from '../js/core/MessageLoader.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import {
  readLocalFirstHistory,
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
