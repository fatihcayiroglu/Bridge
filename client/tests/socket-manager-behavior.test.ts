import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const mocks = vi.hoisted(() => {
  const registry = new Map<string, unknown>();
  return {
    registry,
    registryCall: vi.fn((name: string, ...args: unknown[]) => {
      if (name === 'getMe') return { _id: 'user-1' };
      const fn = registry.get(name);
      return typeof fn === 'function' ? Reflect.apply(fn as (...xs: unknown[]) => unknown, undefined, args) : undefined;
    }),
    registryRegister: vi.fn((name: string, value: unknown) => { registry.set(name, value); }),
    registryUnregister: vi.fn((name: string) => { registry.delete(name); }),
    registryGet: vi.fn((name: string) => registry.get(name) ?? null),
    readToken: vi.fn<() => string | null>(),
    logout: vi.fn(),
    refreshAccessToken: vi.fn<() => Promise<boolean>>(),
    wasLastRefreshFailureTransient: vi.fn<() => boolean>(() => false),
    logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
  };
});

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    call: mocks.registryCall,
    register: mocks.registryRegister,
    unregister: mocks.registryUnregister,
    get: mocks.registryGet,
  },
}));
vi.mock('../js/core/auth-compat.js', () => ({ readToken: mocks.readToken, logout: mocks.logout }));
vi.mock('../js/core/api-fetch.js', () => ({
  refreshAccessToken: mocks.refreshAccessToken,
  wasLastRefreshFailureTransient: mocks.wasLastRefreshFailureTransient,
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'https://bridge.example.test' }));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError, debug: mocks.logDebug }),
}));

import SocketManager from '../js/core/SocketManager.svelte';

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connected = false;
  id: string;
  handlers = new Map<string, Handler[]>();
  onceHandlers = new Map<string, Handler[]>();
  on = vi.fn((event: string, handler: Handler) => {
    const list = this.handlers.get(event) ?? [];
    list.push(handler); this.handlers.set(event, list);
  });
  once = vi.fn((event: string, handler: Handler) => {
    const list = this.onceHandlers.get(event) ?? [];
    list.push(handler); this.onceHandlers.set(event, list);
  });
  emit = vi.fn();
  disconnect = vi.fn(() => { this.connected = false; });
  constructor(id: string) { this.id = id; }
  fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
    const once = this.onceHandlers.get(event) ?? [];
    this.onceHandlers.delete(event);
    for (const fn of once) fn(...args);
  }
}

let target: HTMLDivElement;
let instance: unknown | null = null;
let token: string | null;
let sockets: FakeSocket[];
let ioFactory: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  target = document.createElement('div'); document.body.appendChild(target);
  mocks.registry.clear();
  for (const fn of [mocks.registryCall, mocks.registryRegister, mocks.registryUnregister, mocks.registryGet,
    mocks.readToken, mocks.logout, mocks.refreshAccessToken, mocks.logInfo, mocks.logWarn, mocks.logError, mocks.logDebug]) fn.mockClear();
  token = 'token-1';
  mocks.readToken.mockImplementation(() => token);
  mocks.refreshAccessToken.mockImplementation(async () => { token = 'token-2'; return true; });
  sockets = [];
  ioFactory = vi.fn(() => {
    const socket = new FakeSocket(`sock-${sockets.length + 1}`);
    sockets.push(socket);
    return socket;
  });
  vi.stubGlobal('io', ioFactory);
});

afterEach(async () => {
  if (instance) { await unmount(instance as never); instance = null; }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('SocketManager canonical realtime/auth lifecycle', () => {
  it('owns ready/reconnect, auth recovery, token rotation and server revocation without duplicate sockets', async () => {
    const ready = vi.fn(); const reconnected = vi.fn(); const disconnected = vi.fn();
    document.addEventListener('bridge:socket-ready', ready);
    document.addEventListener('bridge:socket-reconnected', reconnected);
    document.addEventListener('bridge:socket-disconnected', disconnected);

    instance = mount(SocketManager, { target });
    expect(ioFactory).toHaveBeenCalledTimes(1);
    expect(ioFactory).toHaveBeenCalledWith('https://bridge.example.test', {
      auth: { token: 'token-1' }, transports: ['websocket', 'polling'],
    });
    expect(mocks.registryGet('connectSocket')).toEqual(expect.any(Function));
    expect(mocks.registryGet('disconnectSocket')).toEqual(expect.any(Function));

    const first = sockets[0];
    first.connected = true; first.fire('connect');
    expect(first.emit).toHaveBeenCalledWith('user:join-room', 'user-1');
    expect(mocks.registry.get('socket')).toBe(first);
    expect(ready).not.toHaveBeenCalled();
    first.fire('userAuthenticated');
    expect(ready).toHaveBeenCalledTimes(1);

    first.fire('disconnect', 'transport close');
    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(mocks.registryCall).toHaveBeenCalledWith('setSocketConnected', false);

    first.connected = true; first.fire('connect');
    first.fire('userAuthenticated');
    expect(reconnected).toHaveBeenCalledTimes(1);
    // ready is intentionally application-lifetime idempotent until teardown.
    expect(ready).toHaveBeenCalledTimes(1);

    first.fire('connect_error', { message: 'temporary network failure' });
    await tick();
    expect(target.textContent).toContain('Gerçek zamanlı bağlantı kurulamadı');
    expect(target.textContent).not.toContain('temporary network failure');
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();

    first.fire('connect_error', { message: 'jwt expired' });
    first.fire('connect_error', { message: 'jwt expired' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(first.disconnect).toHaveBeenCalled();
    expect(ioFactory).toHaveBeenCalledTimes(2);
    expect(ioFactory).toHaveBeenLastCalledWith('https://bridge.example.test', {
      auth: { token: 'token-2' }, transports: ['websocket', 'polling'],
    });

    const second = sockets[1];
    second.connected = true; second.fire('connect'); second.fire('userAuthenticated');
    expect(mocks.registry.get('socket')).toBe(second);
    second.fire('auth:revoked', { reason: 'token_revoked' });
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.registry.has('socket')).toBe(false);
    expect(mocks.logout).toHaveBeenCalledTimes(1);

    document.removeEventListener('bridge:socket-ready', ready);
    document.removeEventListener('bridge:socket-reconnected', reconnected);
    document.removeEventListener('bridge:socket-disconnected', disconnected);
  });

  it('refreshes and reconnects when the server closes a socket only because the access token expired', async () => {
    instance = mount(SocketManager, { target });
    const first = sockets[0]!;
    first.connected = true;
    first.fire('connect');
    first.fire('userAuthenticated');

    first.fire('auth:revoked', { reason: 'token_expired' });
    expect(first.disconnect).toHaveBeenCalled();
    expect(mocks.logout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.refreshAccessToken).toHaveBeenCalledOnce();
    expect(sockets.length).toBeGreaterThan(1);
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('does not connect without a token or Socket.IO factory and reconnects on auth-success once prerequisites appear', async () => {
    token = null;
    vi.stubGlobal('io', undefined);
    instance = mount(SocketManager, { target });
    expect(ioFactory).not.toHaveBeenCalled();

    token = 'late-token';
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await tick();
    expect(target.textContent).toContain('Gerçek zamanlı özellikler yüklenemedi');
    expect(target.textContent).not.toContain('socket.io istemcisi yüklenmedi');

    vi.stubGlobal('io', ioFactory);
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    expect(ioFactory).toHaveBeenCalledTimes(1);

    // Same token and existing socket is idempotent even before connect completes.
    const connectOwner = mocks.registry.get('connectSocket') as (() => void);
    connectOwner();
    expect(ioFactory).toHaveBeenCalledTimes(1);
  });

  it('uses the ready fallback when the authenticated-server signal is lost', async () => {
    const ready = vi.fn(); document.addEventListener('bridge:socket-ready', ready);
    instance = mount(SocketManager, { target });
    sockets[0].fire('connect');
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining('userAuthenticated gelmedi'));
    document.removeEventListener('bridge:socket-ready', ready);
  });
});
