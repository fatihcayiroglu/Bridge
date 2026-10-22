// client/tests/channel-list-live-sync.test.ts
//
// P7 D2 lifecycle (Android journey D2L01): a channel created, renamed or deleted by another
// member or device must reach an already-loaded channel list. The server never emitted anything
// on channel mutations and the client had no listener, so the list stayed stale until a manual
// reload. The server now emits `channels:changed { serverId }` (no channel metadata); the real
// ChannelListManager refetches the permission-filtered list once per burst.
//
// Only outer boundaries are mocked (network, token, sub-view mount, logger); the registry and
// the component are real. Removing 'channels:changed' from ACCESS_EVENTS fails these tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, unmount, flushSync } from 'svelte';

const { mockApiFetch, mockMountList } = vi.hoisted(() => ({
  mockApiFetch: vi.fn(),
  mockMountList: vi.fn(async () => true),
}));

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: mockApiFetch }));
vi.mock('../js/core/auth-compat.js', () => ({ readToken: () => 'test-token' }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://localhost:3001' }));
vi.mock('../js/core/channel-list/channel-list-svelte.js', () => ({
  mountOrUpdateChannelList: mockMountList,
  unmountChannelList: vi.fn(),
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import ChannelListManager from '../js/core/ChannelListManager.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { CHANNELS_CHANGED_COALESCE_MS, CHANNELS_CHANGED_JITTER_MS } from '../js/core/channel-list/access-revocation.ts';

const WINDOW = CHANNELS_CHANGED_COALESCE_MS + CHANNELS_CHANGED_JITTER_MS + 10;

type Channel = { _id: string; name: string; type?: string };
type Handler = (payload: unknown) => void;

const ok = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

/** Server truth per path; every request reads the CURRENT value (like a real API). */
let serverChannels: Record<string, Channel[]> = {};
let listed: Channel[] = [];
let instance: ReturnType<typeof mount> | null = null;
let host: HTMLDivElement;
const handlers = new Map<string, Set<Handler>>();
const socket = {
  on: (event: string, handler: Handler) => { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event)!.add(handler); },
  off: (event: string, handler: Handler) => { handlers.get(event)?.delete(handler); },
};
const emit = (event: string, payload: unknown) => { for (const h of handlers.get(event) ?? []) h(payload); };

const channelRequests = (serverId: string) => mockApiFetch.mock.calls
  .filter(([raw]) => new URL(String(raw)).pathname === `/api/servers/${serverId}/channels`).length;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
}

async function openServer(serverId: string): Promise<void> {
  document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId } }));
  await vi.waitFor(() => expect(channelRequests(serverId)).toBe(1));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  handlers.clear();
  mockApiFetch.mockReset();
  mockApiFetch.mockImplementation(async (raw: string) => {
    const path = new URL(String(raw)).pathname;
    const match = /^\/api\/servers\/([^/]+)\/channels$/.exec(path);
    if (match) return ok(serverChannels[decodeURIComponent(match[1]!)] ?? []);
    return ok([]);  // categories
  });
  serverChannels = { s1: [{ _id: 'general', name: 'general', type: 'text' }], s2: [{ _id: 'other', name: 'other', type: 'text' }] };
  listed = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  BridgeRegistry.register('setCurrentServerChannels', ((c: Channel[]) => { listed = c ?? []; }) as AnyFn);
  BridgeRegistry.register('getCurrentServer', (() => null) as AnyFn);
  BridgeRegistry.register('setCurrentChannel', ((): void => {}) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
  instance = mount(ChannelListManager, { target: host });
  flushSync();
});

afterEach(() => {
  if (instance) unmount(instance);
  instance = null;
  host.remove();
  for (const k of ['setCurrentServerChannels', 'getCurrentServer', 'setCurrentChannel', 'socket']) BridgeRegistry.unregister(k);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('channels:changed — live channel list sync', () => {
  it('shows a channel another member created while this list was already loaded', async () => {
    await openServer('s1');
    expect(listed.map(c => c._id)).toEqual(['general']);

    serverChannels.s1 = [...serverChannels.s1!, { _id: 'fresh', name: 'fresh', type: 'text' }];
    emit('channels:changed', { serverId: 's1' });
    await vi.advanceTimersByTimeAsync(WINDOW);
    await settle();

    expect(channelRequests('s1')).toBe(2);
    expect(listed.map(c => c._id)).toEqual(['general', 'fresh']);
  });

  it('folds a burst of changes into one refetch', async () => {
    await openServer('s1');
    for (let i = 0; i < 5; i++) emit('channels:changed', { serverId: 's1' });
    await vi.advanceTimersByTimeAsync(WINDOW);
    await settle();
    expect(channelRequests('s1')).toBe(2);
  });

  it('ignores changes to a server the user is not looking at, and malformed payloads', async () => {
    await openServer('s1');
    emit('channels:changed', { serverId: 's2' });
    emit('channels:changed', { serverId: 7 });
    emit('channels:changed', null);
    await vi.advanceTimersByTimeAsync(WINDOW);
    await settle();
    expect(channelRequests('s1')).toBe(1);
    expect(channelRequests('s2')).toBe(0);
  });

  it('drops a pending refresh when the user switches server inside the window', async () => {
    await openServer('s1');
    emit('channels:changed', { serverId: 's1' });
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 's2' } }));
    await vi.advanceTimersByTimeAsync(WINDOW);
    await settle();
    expect(channelRequests('s1')).toBe(1);
    expect(listed.map(c => c._id)).toEqual(['other']);
  });

  it('a channel deleted elsewhere disappears, and the list never shows what the server withheld', async () => {
    await openServer('s1');
    serverChannels.s1 = [];  // deleted, or hidden from this member by permissions
    emit('channels:changed', { serverId: 's1' });
    await vi.advanceTimersByTimeAsync(WINDOW);
    await settle();
    expect(listed).toEqual([]);
  });

  it('stops listening after unmount', async () => {
    await openServer('s1');
    unmount(instance!);
    instance = null;
    emit('channels:changed', { serverId: 's1' });
    await vi.advanceTimersByTimeAsync(WINDOW);
    await settle();
    expect(channelRequests('s1')).toBe(1);
  });
});

describe('channel header expiry notice (P7 D2 #321)', () => {
  function header(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'channel-header';
    bar.innerHTML = '<span id="ch-h-icon"></span><span id="ch-h-name"></span><span class="ch-h-topic" id="ch-h-topic"></span>';
    document.body.appendChild(bar);
    return bar;
  }

  it('states an absolute deletion time as a note, warns within a day, and clears for a permanent channel', async () => {
    const bar = header();
    const at = Date.now() + 2 * 60 * 60 * 1000;
    serverChannels.s1 = [
      { _id: 'soon', name: 'soon', type: 'text', expiresAt: at } as Channel,
      { _id: 'general', name: 'general', type: 'text' },
    ];
    await openServer('s1');
    BridgeRegistry.call('selectChannel', serverChannels.s1![0]);
    flushSync();
    const note = bar.querySelector<HTMLElement>('#ch-h-expiry')!;
    expect(note.getAttribute('role')).toBe('note');
    expect(note.dataset.soon).toBe('true');
    expect(note.textContent).toContain(String(new Date(at).getFullYear()));
    expect(note.previousElementSibling?.id).toBe('ch-h-topic');

    BridgeRegistry.call('selectChannel', serverChannels.s1![1]);
    flushSync();
    expect(bar.querySelector('#ch-h-expiry')).toBeNull();
    bar.remove();
  });
});
