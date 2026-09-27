// client/tests/unread-channel-activity.test.ts
//
// Final21 Phase 15 — channels with unread messages look unread.
//
// Measured before the change (two real browsers, tools/p15-capability-probe.mjs): a plain
// message in a channel the viewer was not looking at left no trace at all. These tests pin
// the client half: server snapshot → bold channel + server dot, live `channel:activity`,
// mute, own messages, the open channel, marking live-seen messages read, and the watch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registryMap: Record<string, unknown> = {};
const registryMock = {
  BridgeRegistry: {
    has: (k: string) => k in registryMap,
    get: (k: string) => registryMap[k],
    call: (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
    register: (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
  },
};
vi.mock('../js/core/bridge-registry.ts', () => registryMock);
vi.mock('../js/core/bridge-registry.js', () => registryMock);
const loggerMock = { createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) };
vi.mock('../js/core/logger.ts', () => loggerMock);
vi.mock('../js/core/logger.js', () => loggerMock);

type Handler = (payload: unknown) => void;

function fakeSocket() {
  const handlers: Record<string, Handler[]> = {};
  return {
    emitted: [] as Array<[string, unknown]>,
    on(e: string, fn: Handler) { (handlers[e] ??= []).push(fn); },
    off(e: string, fn: Handler) { handlers[e] = (handlers[e] ?? []).filter((h) => h !== fn); },
    emit(e: string, payload: unknown) { this.emitted.push([e, payload]); },
    receive(e: string, payload: unknown) { for (const h of handlers[e] ?? []) h(payload); },
  };
}

function channelItem(id: string) {
  const item = document.createElement('div');
  item.className = 'ch-item';
  item.dataset.id = id;
  const open = document.createElement('button');
  open.className = 'ch-open';
  item.appendChild(open);
  document.body.appendChild(item);
  return item;
}
function serverIcon(id: string) {
  const icon = document.createElement('button');
  icon.className = 'server-icon';
  icon.dataset.id = id;
  document.body.appendChild(icon);
  return icon;
}

let visibility: DocumentVisibilityState = 'visible';
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };

async function boot(snapshot: { channels?: unknown; muted?: unknown } = {}) {
  const socket = fakeSocket();
  let activeChannel = { _id: 'c-open', serverId: 's1' };
  registryMap.socket = socket;
  registryMap.getMe = () => ({ _id: 'u-me' });
  registryMap.getCurrentChannel = () => activeChannel;
  registryMap.getCurrentServerChannels = () => [{ _id: 'c-open', serverId: 's1' }, { _id: 'c1', serverId: 's1' }, { _id: 'c2', serverId: 's1' }];
  registryMap.getAvailableServers = () => [{ _id: 's1' }, { _id: 's2' }];
  const apiFetch = vi.fn(async (url: string) => ({
    ok: true, status: 200,
    json: async () => (url.includes('unread-channels') ? { channels: [], muted: { channels: [], servers: [] }, ...snapshot } : { channels: [] }),
  }) as unknown as Response);
  registryMap.apiFetch = apiFetch;
  vi.resetModules();
  const mod = await import('../js/core/unread-svelte.ts');
  mod.mountUnread();
  await flush();
  return { mod, socket, apiFetch, setActive: (id: string, serverId = 's1') => { activeChannel = { _id: id, serverId }; } };
}

const readCalls = (apiFetch: ReturnType<typeof vi.fn>) =>
  apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/read')).map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))]);

describe('unread channel activity', { timeout: 20_000 }, () => {
  beforeEach(() => {
    for (const k of Object.keys(registryMap)) delete registryMap[k];
    document.body.innerHTML = '';
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  });
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('the server snapshot makes channels bold and marks their server, never the open channel', async () => {
    const c1 = channelItem('c1'); const open = channelItem('c-open'); const s1 = serverIcon('s1'); const s2 = serverIcon('s2');
    const { mod } = await boot({ channels: [{ channelId: 'c1', serverId: 's1' }, { channelId: 'c-open', serverId: 's1' }, { channelId: 'x9', serverId: 's2' }] });
    try {
      expect(c1.getAttribute('data-unread')).toBe('true');
      expect(c1.querySelector('.ch-open')?.getAttribute('aria-description')).toBeTruthy();
      expect(open.hasAttribute('data-unread')).toBe(false);
      expect(s1.getAttribute('data-has-unread')).toBe('true');
      expect(s2.getAttribute('data-has-unread')).toBe('true');
    } finally { mod.unmountUnread(); }
  });

  it('live activity from someone else marks the channel; own, muted and muted-server activity do not', async () => {
    const c1 = channelItem('c1'); const c2 = channelItem('c2'); const c3 = channelItem('c3');
    const { mod, socket } = await boot({ muted: { channels: ['c2'], servers: ['s-muted'] } });
    try {
      socket.receive('channel:activity', { channelId: 'c1', serverId: 's1', messageId: 'm1', userId: 'u-me' });
      expect(c1.hasAttribute('data-unread')).toBe(false);
      socket.receive('channel:activity', { channelId: 'c2', serverId: 's1', messageId: 'm2', userId: 'u-other' });
      socket.receive('channel:activity', { channelId: 'c3', serverId: 's-muted', messageId: 'm3', userId: 'u-other' });
      expect(c2.hasAttribute('data-unread')).toBe(false);
      expect(c3.hasAttribute('data-unread')).toBe(false);
      socket.receive('channel:activity', { channelId: 'c1', serverId: 's1', messageId: 'm4', userId: 'u-other' });
      expect(c1.getAttribute('data-unread')).toBe('true');
    } finally { mod.unmountUnread(); }
  });

  it('opening a channel clears its unread state', async () => {
    const c1 = channelItem('c1');
    const { mod, socket, setActive } = await boot();
    try {
      socket.receive('channel:activity', { channelId: 'c1', serverId: 's1', messageId: 'm1', userId: 'u-other' });
      expect(c1.getAttribute('data-unread')).toBe('true');
      setActive('c1');
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await flush();
      expect(c1.hasAttribute('data-unread')).toBe(false);
    } finally { mod.unmountUnread(); }
  });

  it('the open channel is never painted unread, even if it became open without a selection event', async () => {
    const c1 = channelItem('c1');
    const { mod, socket, setActive } = await boot();
    try {
      socket.receive('channel:activity', { channelId: 'c1', serverId: 's1', messageId: 'm1', userId: 'u-other' });
      expect(c1.getAttribute('data-unread')).toBe('true');
      setActive('c1');
      socket.receive('channel:activity', { channelId: 'c2', serverId: 's1', messageId: 'm2', userId: 'u-other' });
      expect(c1.hasAttribute('data-unread')).toBe(false);
    } finally { mod.unmountUnread(); }
  });

  it('a message seen live in the open channel moves the read cursor (debounced, latest message)', async () => {
    const { mod, socket, apiFetch } = await boot();
    vi.useFakeTimers();
    try {
      socket.receive('channel:activity', { channelId: 'c-open', serverId: 's1', messageId: 'm1', userId: 'u-other' });
      socket.receive('channel:activity', { channelId: 'c-open', serverId: 's1', messageId: 'm2', userId: 'u-other' });
      expect(readCalls(apiFetch)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_300);
      expect(readCalls(apiFetch)).toEqual([['/api/channels/c-open/read', { messageId: 'm2' }]]);
    } finally { mod.unmountUnread(); }
  });

  it('a message arriving while the tab is hidden is not marked read until the tab is visible', async () => {
    const { mod, socket, apiFetch } = await boot();
    vi.useFakeTimers();
    try {
      visibility = 'hidden';
      socket.receive('channel:activity', { channelId: 'c-open', serverId: 's1', messageId: 'm1', userId: 'u-other' });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(readCalls(apiFetch)).toEqual([]);
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1_300);
      expect(readCalls(apiFetch)).toEqual([['/api/channels/c-open/read', { messageId: 'm1' }]]);
    } finally { mod.unmountUnread(); }
  });

  it('switching channels marks the previous channel read immediately', async () => {
    const { mod, socket, apiFetch, setActive } = await boot();
    try {
      socket.receive('channel:activity', { channelId: 'c-open', serverId: 's1', messageId: 'm7', userId: 'u-other' });
      setActive('c1');
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await flush();
      expect(readCalls(apiFetch)).toEqual([['/api/channels/c-open/read', { messageId: 'm7' }]]);
    } finally { mod.unmountUnread(); }
  });

  it('watches the current server once, again after reconnect, and for a new server', async () => {
    const { mod, socket, setActive } = await boot();
    try {
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await flush();
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await flush();
      const watches = () => socket.emitted.filter(([event]) => event === 'channels:watch').map(([, payload]) => payload);
      expect(watches()).toEqual([{ serverId: 's1' }]);
      document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
      await flush();
      expect(watches()).toEqual([{ serverId: 's1' }, { serverId: 's1' }]);
      setActive('d1', 's2');
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      await flush();
      expect(watches()).toEqual([{ serverId: 's1' }, { serverId: 's1' }, { serverId: 's2' }]);
    } finally { mod.unmountUnread(); }
  });

  it('visibility refreshes the snapshot; unmount removes every listener', async () => {
    const c1 = channelItem('c1');
    const { mod, socket, apiFetch } = await boot();
    const snapshots = () => apiFetch.mock.calls.filter(([url]) => String(url).includes('unread-channels')).length;
    const before = snapshots();
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(snapshots()).toBe(before + 1);
    mod.unmountUnread();
    socket.receive('channel:activity', { channelId: 'c1', serverId: 's1', messageId: 'm1', userId: 'u-other' });
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(c1.hasAttribute('data-unread')).toBe(false);
    expect(snapshots()).toBe(before + 1);
  });
});
