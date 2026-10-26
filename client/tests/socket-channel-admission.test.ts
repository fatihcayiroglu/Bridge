// Mount both owners: an HTTP list read before server room admission may miss a
// channels:changed notification. Admission must reconcile through the authorized
// API, including when the legacy readiness fallback already fired. This proves
// a deterministic client race; it does not diagnose the historical iOS run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), mountList: vi.fn(async () => true) }));
vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: mocks.apiFetch, refreshAccessToken: vi.fn(async () => true),
  wasLastRefreshFailureTransient: () => false,
}));
vi.mock('../js/core/auth-compat.js', () => ({ readToken: () => 'test-token', logout: vi.fn() }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'https://bridge.example.test' }));
vi.mock('../js/core/channel-list/channel-list-svelte.js', () => ({
  mountOrUpdateChannelList: mocks.mountList, unmountChannelList: vi.fn(),
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import SocketManager from '../js/core/SocketManager.svelte';
import ChannelListManager from '../js/core/ChannelListManager.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.js';
import { CHANNELS_CHANGED_COALESCE_MS, CHANNELS_CHANGED_JITTER_MS } from '../js/core/channel-list/access-revocation.js';

type Handler = (...args: unknown[]) => void;
class Transport {
  connected = false;
  handlers = new Map<string, Set<Handler>>();
  onceHandlers = new Map<string, Set<Handler>>();
  on(event: string, handler: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }
  once(event: string, handler: Handler): void {
    if (!this.onceHandlers.has(event)) this.onceHandlers.set(event, new Set());
    this.onceHandlers.get(event)!.add(handler);
  }
  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler); this.onceHandlers.get(event)?.delete(handler);
  }
  removeAllListeners(): void { this.handlers.clear(); this.onceHandlers.clear(); }
  emit(): void { /* outbound joins are not the read boundary under test */ }
  disconnect(): void { this.connected = false; }
  fire(event: string): void {
    for (const handler of [...this.handlers.get(event) ?? []]) handler();
    const once = [...this.onceHandlers.get(event) ?? []];
    this.onceHandlers.delete(event);
    for (const handler of once) handler();
  }
}
type Channel = { _id: string; name: string; type: string };
const channel = (_id: string): Channel => ({ _id, name: _id, type: 'text' });
const WINDOW = CHANNELS_CHANGED_COALESCE_MS + CHANNELS_CHANGED_JITTER_MS + 20;
let truth: Channel[];
let listed: Channel[];
let socket: Transport;
let host: HTMLDivElement;
let listOwner: ReturnType<typeof mount>;
let socketOwner: ReturnType<typeof mount>;
const requests = (): number => mocks.apiFetch.mock.calls.filter(([url]) =>
  new URL(String(url)).pathname === '/api/servers/server-1/channels').length;
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  flushSync();
}
async function openServer(): Promise<void> {
  document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: 'server-1' } }));
  await settle();
  expect(requests()).toBe(1);
  expect(listed.map(c => c._id)).toEqual(['permanent', 'soon-expired']);
}
beforeEach(() => {
  vi.useFakeTimers();
  truth = [channel('permanent'), channel('soon-expired')]; listed = [];
  mocks.apiFetch.mockReset();
  mocks.apiFetch.mockImplementation(async (raw: string) => ({
    ok: true, status: 200,
    json: async () => new URL(raw).pathname.endsWith('/channels') ? [...truth] : [],
  }));
  host = document.createElement('div'); document.body.appendChild(host);
  BridgeRegistry.register('getCurrentServer', (() => null) as AnyFn);
  BridgeRegistry.register('getMe', (() => ({ _id: 'user-1' })) as AnyFn);
  BridgeRegistry.register('setCurrentServerChannels', ((channels: Channel[]) => { listed = channels; }) as AnyFn);
  BridgeRegistry.register('setCurrentChannel', (() => {}) as AnyFn);
  socket = new Transport(); vi.stubGlobal('io', () => socket);
  // The list can render before the socket connects or joins its server rooms.
  listOwner = mount(ChannelListManager, { target: host }); flushSync();
  socketOwner = mount(SocketManager, { target: host }); flushSync();
});
afterEach(async () => {
  await unmount(socketOwner); await unmount(listOwner);
  for (const name of ['getCurrentServer', 'getMe', 'setCurrentServerChannels', 'setCurrentChannel']) BridgeRegistry.unregister(name);
  host.remove(); vi.unstubAllGlobals(); vi.useRealTimers();
});

describe('server room admission reconciles the authorized channel list', () => {
  it('recovers a channel addition and expiry missed before initial admission', async () => {
    await openServer();
    socket.connected = true; socket.fire('connect');
    // Another device commits while this connection is not yet in server rooms.
    // The broadcast is not delivered to this transport; server truth changes.
    truth = [channel('permanent'), channel('new-channel')];
    socket.fire('userAuthenticated');
    await vi.advanceTimersByTimeAsync(WINDOW); await settle();
    expect(requests()).toBe(2);
    expect(listed.map(c => c._id)).toEqual(['permanent', 'new-channel']);
  });

  it('reconciles late authoritative admission after the readiness fallback', async () => {
    await openServer();
    socket.connected = true; socket.fire('connect');
    await vi.advanceTimersByTimeAsync(3000 + WINDOW); await settle();
    const beforeAdmission = requests();
    truth = [channel('permanent'), channel('new-channel')];
    socket.fire('userAuthenticated');
    await vi.advanceTimersByTimeAsync(WINDOW); await settle();
    expect(requests()).toBe(beforeAdmission + 1);
    expect(listed.map(c => c._id)).toEqual(['permanent', 'new-channel']);
    socket.fire('userAuthenticated');
    await vi.advanceTimersByTimeAsync(WINDOW); await settle();
    expect(requests()).toBe(beforeAdmission + 1);
  });

  it('reconciles admission even when resume just read an older list', async () => {
    await openServer();
    socket.connected = true; socket.fire('connect'); socket.fire('userAuthenticated');
    await vi.advanceTimersByTimeAsync(WINDOW); await settle();
    socket.connected = false; socket.fire('disconnect');
    socket.connected = true; socket.fire('connect');
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await settle();
    const beforeAdmission = requests();
    truth = [channel('permanent')];
    // Same instant as the resume read: the resume throttle would suppress this.
    socket.fire('userAuthenticated');
    await vi.advanceTimersByTimeAsync(WINDOW); await settle();
    expect(requests()).toBe(beforeAdmission + 1);
    expect(listed.map(c => c._id)).toEqual(['permanent']);
  });
});
