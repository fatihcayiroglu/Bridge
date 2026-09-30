// client/tests/p4-native-deeplink.test.ts
//
// P4-07 / P4-08 — deep links and notification taps in the native app navigate, and only through
// the server's permission-checked lookups.
//
// MEASURED (Android 14 emulator): `bridge://channel/<id>` opened the app and did nothing, warm and
// cold; a notification tap called globals that do not exist. Nothing consumed `bridge:deeplink`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: vi.fn() }));
vi.mock('../js/core/auth-compat.ts', () => ({ readToken: () => localStorage.getItem('token') }));

import {
  parseNativeDeepLink, routeNativeDeepLink, initNativeDeepLinks, _resetNativeDeepLinksForTest,
  PENDING_LINK_TTL_MS, type NativeDeepLinkDeps,
} from '../js/core/native-deeplink.ts';

function json(body: unknown, ok = true) { return { ok, json: async () => body }; }

function makeDeps(overrides: Partial<NativeDeepLinkDeps> = {}) {
  const servers = [{ _id: 'srv-a' }, { _id: 'srv-b' }];
  const channelsOf: Record<string, Array<{ _id: string }>> = { 'srv-a': [{ _id: 'ch-a1' }], 'srv-b': [{ _id: 'ch-b1' }] };
  const deps: NativeDeepLinkDeps & { calls: string[] } = {
    calls: [],
    ready: () => true,
    servers: () => servers,
    selectServer: vi.fn(),
    loadServers: vi.fn(),
    navigateToChannel: vi.fn(async () => true),
    post: vi.fn(async (url: string) => { deps.calls.push(`POST ${url}`); return json({ _id: 'srv-new' }); }),
    get: vi.fn(async (url: string) => {
      deps.calls.push(`GET ${url}`);
      const id = /\/api\/servers\/([^/]+)\/channels/.exec(url)?.[1] ?? '';
      return json(channelsOf[decodeURIComponent(id)] ?? []);
    }),
    toast: vi.fn(),
    signedIn: () => true,
    openDm: vi.fn(async () => true),
    openGroupDm: vi.fn(async (groupId: string) => groupId === 'g-mine'),
    ...overrides,
  };
  return deps;
}

beforeEach(() => { localStorage.clear(); _resetNativeDeepLinksForTest(); });
afterEach(() => { _resetNativeDeepLinksForTest(); delete (window as { __bridgePendingDeepLinks?: unknown }).__bridgePendingDeepLinks; });

describe('parseNativeDeepLink — untrusted input', () => {
  it('accepts the bridge navigation payloads with well-formed ids', () => {
    expect(parseNativeDeepLink({ type: 'navigate:channel', channelId: 'ch-1', serverId: 'srv-1' })).toEqual({ kind: 'channel', channelId: 'ch-1', serverId: 'srv-1' });
    expect(parseNativeDeepLink({ type: 'navigate:server', serverId: 'srv-1' })).toEqual({ kind: 'server', serverId: 'srv-1' });
    expect(parseNativeDeepLink({ type: 'navigate:invite', code: 'abcDEF12' })).toEqual({ kind: 'invite', code: 'abcDEF12' });
    expect(parseNativeDeepLink({ type: 'navigate:dm', userId: 'u-1' })).toEqual({ kind: 'dm', userId: 'u-1' });
    expect(parseNativeDeepLink({ type: 'navigate:gdm', groupId: 'g-1' })).toEqual({ kind: 'gdm', groupId: 'g-1' });
  });

  it('rejects tokens, unknown types and malformed ids', () => {
    expect(parseNativeDeepLink({ type: 'auth:callback', token: 'stolen' })).toBeNull();
    expect(parseNativeDeepLink({ type: 'navigate:settings', tab: 'account' })).toBeNull();
    expect(parseNativeDeepLink({ type: 'navigate:channel', channelId: '../../api/admin' })).toBeNull();
    expect(parseNativeDeepLink({ type: 'navigate:channel', channelId: 'x'.repeat(65) })).toBeNull();
    expect(parseNativeDeepLink({ type: 'navigate:invite', code: 'a b' })).toBeNull();
    expect(parseNativeDeepLink('bridge://channel/x')).toBeNull();
    expect(parseNativeDeepLink(null)).toBeNull();
  });
});

describe('routeNativeDeepLink — only permission-checked destinations', () => {
  it('a channel link finds the owning server through the channel API and navigates there', async () => {
    const deps = makeDeps();
    await expect(routeNativeDeepLink({ kind: 'channel', channelId: 'ch-b1' }, deps, 1_000)).resolves.toBe(true);
    expect(deps.navigateToChannel).toHaveBeenCalledWith('ch-b1', undefined, { _id: 'srv-b' });
    expect(deps.toast).not.toHaveBeenCalled();
  });

  it('the notification\'s server hint is checked first', async () => {
    const deps = makeDeps();
    await routeNativeDeepLink({ kind: 'channel', channelId: 'ch-b1', serverId: 'srv-b' }, deps, 1_000);
    expect(deps.calls[0]).toBe('GET /api/servers/srv-b/channels');
  });

  it('a channel the user cannot see (not listed by any of their servers) is NOT opened', async () => {
    const deps = makeDeps();
    await expect(routeNativeDeepLink({ kind: 'channel', channelId: 'ch-private' }, deps, 1_000)).resolves.toBe(false);
    expect(deps.navigateToChannel).not.toHaveBeenCalled();
    expect(deps.toast).toHaveBeenCalledTimes(1);
  });

  it('a server link only selects a server already in the user\'s list', async () => {
    const deps = makeDeps();
    await expect(routeNativeDeepLink({ kind: 'server', serverId: 'srv-a' }, deps, 1_000)).resolves.toBe(true);
    expect(deps.selectServer).toHaveBeenCalledWith({ _id: 'srv-a' });
    await expect(routeNativeDeepLink({ kind: 'server', serverId: 'srv-foreign' }, deps, 1_000)).resolves.toBe(false);
    expect(deps.selectServer).toHaveBeenCalledTimes(1);
  });

  it('an invite link goes through the server\'s invite validation', async () => {
    const deps = makeDeps();
    await routeNativeDeepLink({ kind: 'invite', code: 'code123' }, deps, 1_000);
    expect(deps.calls).toContain('POST /api/servers/invites/code123/use');
  });

  it('a DM link uses the DM panel\'s own open flow', async () => {
    const deps = makeDeps();
    await expect(routeNativeDeepLink({ kind: 'dm', userId: 'u-9' }, deps, 1_000)).resolves.toBe(true);
    expect(deps.openDm).toHaveBeenCalledWith('u-9');
  });

  it('a group DM link opens only a group in the user\'s own list', async () => {
    const deps = makeDeps();
    await expect(routeNativeDeepLink({ kind: 'gdm', groupId: 'g-mine' }, deps, 1_000)).resolves.toBe(true);
    await expect(routeNativeDeepLink({ kind: 'gdm', groupId: 'g-other' }, deps, 1_000)).resolves.toBe(false);
    expect(deps.toast).toHaveBeenCalledTimes(1);
  });

  it('an empty server list is loaded before the lookup (cold start)', async () => {
    const list: Array<{ _id: string }> = [];
    const deps = makeDeps({ servers: () => list, loadServers: vi.fn(() => { list.push({ _id: 'srv-a' }); }) });
    await expect(routeNativeDeepLink({ kind: 'channel', channelId: 'ch-a1' }, deps, 1_000)).resolves.toBe(true);
    expect(deps.loadServers).toHaveBeenCalledTimes(1);
  });
});

describe('initNativeDeepLinks — cold start, sign-in and sign-out', () => {
  it('drains links parked by the bridge before the app loaded', async () => {
    (window as { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks = [{ type: 'navigate:channel', channelId: 'ch-a1' }];
    const deps = makeDeps();
    initNativeDeepLinks(deps);
    await vi.waitFor(() => expect(deps.navigateToChannel).toHaveBeenCalledWith('ch-a1', undefined, { _id: 'srv-a' }));
    expect((window as { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks).toEqual([]);
  });

  it('a link that arrives signed-out waits for sign-in; a signed-out app never navigates', async () => {
    let signed = false;
    const deps = makeDeps({ signedIn: () => signed });
    initNativeDeepLinks(deps);
    (window as { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks = [{ type: 'navigate:channel', channelId: 'ch-a1' }];
    window.dispatchEvent(new CustomEvent('bridge:deeplink'));
    await Promise.resolve();
    expect(deps.navigateToChannel).not.toHaveBeenCalled();

    signed = true;
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await vi.waitFor(() => expect(deps.navigateToChannel).toHaveBeenCalledTimes(1));
  });

  it('signing out forgets links waiting for the previous session', async () => {
    let signed = false;
    const deps = makeDeps({ signedIn: () => signed });
    initNativeDeepLinks(deps);
    (window as { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks = [{ type: 'navigate:dm', userId: 'u-1' }];
    window.dispatchEvent(new CustomEvent('bridge:deeplink'));
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    signed = true;
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.openDm).not.toHaveBeenCalled();
  });

  it('a stale waiting link (older than the TTL) is dropped at sign-in', async () => {
    vi.useFakeTimers();
    try {
      let signed = false;
      const deps = makeDeps({ signedIn: () => signed });
      initNativeDeepLinks(deps);
      (window as { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks = [{ type: 'navigate:dm', userId: 'u-1' }];
      window.dispatchEvent(new CustomEvent('bridge:deeplink'));
      vi.advanceTimersByTime(PENDING_LINK_TTL_MS + 1);
      signed = true;
      document.dispatchEvent(new CustomEvent('bridge:auth-success'));
      await vi.runAllTimersAsync();
      expect(deps.openDm).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
