// Exercise the default registry adapter and real HTTP context fence: a stored
// JWT is available before authoritative session restoration establishes getMe.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ token: 'stored-session' as string | null, logout: vi.fn() }));
vi.mock('../js/core/auth-compat.ts', () => ({
  readToken: () => auth.token, saveToken: vi.fn(), logout: auth.logout,
}));
vi.mock('../js/core/globals.ts', () => ({
  getAPI: () => 'https://bridge.test', toServerUrl: (url: string) => new URL(url, 'https://bridge.test').href,
}));
vi.mock('../js/core/refresh-coordinator.ts', () => ({
  storageAvailable: () => false, tryAcquireLease: () => true, releaseLease: vi.fn(),
  publishResult: vi.fn(), waitForOtherTab: vi.fn(),
}));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { initNativeDeepLinks, _resetNativeDeepLinksForTest } from '../js/core/native-deeplink.ts';
import { resetCsrfState, resetRefreshState } from '../js/core/api-fetch.ts';
import { setSessionAuthority } from '../js/core/session-authority.ts';

let me: { _id: string } | null;
let navigate: ReturnType<typeof vi.fn>;
let toast: ReturnType<typeof vi.fn>;
const keys = ['getMe', 'getAvailableServers', 'selectServer', 'navigateToChannel', 'loadServers', 'toast'];
const queued = (): void => {
  (window as Window & { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks = [
    { type: 'navigate:channel', channelId: 'linked-channel' },
  ];
};
const response = (channels: string[]): Response => new Response(JSON.stringify(channels.map(_id => ({ _id }))), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
beforeEach(() => {
  _resetNativeDeepLinksForTest(); resetRefreshState(); resetCsrfState();
  auth.token = 'stored-session'; me = null;
  setSessionAuthority('server');
  navigate = vi.fn(async () => true); toast = vi.fn();
  BridgeRegistry.register('getMe', (() => me) as AnyFn);
  BridgeRegistry.register('getAvailableServers', (() => [{ _id: 'server-1' }]) as AnyFn);
  BridgeRegistry.register('selectServer', vi.fn());
  BridgeRegistry.register('loadServers', vi.fn());
  BridgeRegistry.register('navigateToChannel', navigate);
  BridgeRegistry.register('toast', toast);
});
afterEach(() => {
  _resetNativeDeepLinksForTest(); resetRefreshState(); resetCsrfState();
  for (const key of keys) BridgeRegistry.unregister(key);
  delete (window as Window & { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setSessionAuthority('none');
});

it('preserves a cold link until the stored session has actually restored its identity', async () => {
  let finishEarly!: (value: Response) => void;
  const early = new Promise<Response>(resolve => { finishEarly = resolve; });
  const fetch = vi.fn(async () => me ? response(['linked-channel']) : early);
  vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await new Promise(resolve => setTimeout(resolve, 0));
  const requestsBeforeIdentity = fetch.mock.calls.length;

  // The production startApp transition invalidates pre-restoration HTTP work.
  document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
  me = { _id: 'restored-user' };
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  finishEarly(response(['linked-channel']));
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('linked-channel', undefined, { _id: 'server-1' }));
  expect(requestsBeforeIdentity).toBe(0);
  expect(fetch).toHaveBeenCalledOnce();
  expect(toast).not.toHaveBeenCalled();
});

it('forgets the pre-restoration link on logout before another identity signs in', async () => {
  const fetch = vi.fn(async () => response(['linked-channel'])); vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await new Promise(resolve => setTimeout(resolve, 0));
  auth.token = null;
  document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
  auth.token = 'another-session'; me = { _id: 'another-user' };
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
});

it('still refuses a validated session destination withheld by the authorized channel API', async () => {
  me = { _id: 'restored-user' };
  vi.stubGlobal('fetch', vi.fn(async () => response([])));
  queued(); initNativeDeepLinks();
  await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
  expect(navigate).not.toHaveBeenCalled();
});

for (const allowed of [true, false]) {
  it(`reconciles an in-flight link after the same account stabilizes, with fresh authorization ${allowed}`, async () => {
    me = { _id: 'restored-user' };
    let finishOld!: (value: Response) => void;
    const old = new Promise<Response>(resolve => { finishOld = resolve; });
    const fetch = vi.fn().mockImplementationOnce(() => old)
      .mockImplementation(async () => response(allowed ? ['linked-channel'] : []));
    vi.stubGlobal('fetch', fetch);
    queued(); initNativeDeepLinks();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    finishOld(response(['linked-channel']));

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    if (allowed) {
      await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('linked-channel', undefined, { _id: 'server-1' }));
      expect(toast).not.toHaveBeenCalled();
    } else {
      await vi.waitFor(() => expect(toast).toHaveBeenCalledOnce());
      expect(navigate).not.toHaveBeenCalled();
    }
  });
}

it('discards an in-flight previous-account intent without navigating or changing the new account UI', async () => {
  me = { _id: 'previous-user' };
  let finishOld!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finishOld = resolve; }));
  vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
  me = { _id: 'next-user' };
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  finishOld(response(['linked-channel']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('holds an offline-only identity link until server validation, without consuming its authorization lookup', async () => {
  me = { _id: 'restored-user' };
  setSessionAuthority('local');
  const fetch = vi.fn(async () => response(['linked-channel'])); vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).not.toHaveBeenCalled();
  expect(navigate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
  setSessionAuthority('server');
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(fetch).toHaveBeenCalledOnce();
});

it('reconciles repeated auth-success events and ignores old completions after the latest attempt starts', async () => {
  me = { _id: 'restored-user' };
  const completions: Array<(value: Response) => void> = [];
  const fetch = vi.fn(() => new Promise<Response>(resolve => { completions.push(resolve); }));
  vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  completions[0]!(response(['linked-channel']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(navigate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
  completions[1]!(response(['linked-channel']));
  completions[2]!(response(['linked-channel']));
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
  expect(toast).not.toHaveBeenCalled();
});

it('does not navigate from a response body parsed after the account changed', async () => {
  me = { _id: 'previous-user' };
  let finishJson!: (value: unknown) => void;
  const json = vi.fn(() => new Promise(resolve => { finishJson = resolve; }));
  const old = response([]); old.json = json;
  vi.stubGlobal('fetch', vi.fn(async () => old));
  queued(); initNativeDeepLinks();
  await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
  document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
  me = { _id: 'next-user' };
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  finishJson([{ _id: 'linked-channel' }]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(navigate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('forgets an interrupted link on logout even when the same account signs in again', async () => {
  me = { _id: 'restored-user' };
  let finishOld!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finishOld = resolve; }));
  vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
  auth.token = null; me = null;
  document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
  auth.token = 'new-token'; me = { _id: 'restored-user' };
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  finishOld(response(['linked-channel']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it('keeps the original link deadline across an interrupted lookup', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  me = { _id: 'restored-user' };
  let finishOld!: (value: Response) => void;
  const fetch = vi.fn(() => new Promise<Response>(resolve => { finishOld = resolve; }));
  vi.stubGlobal('fetch', fetch);
  queued(); initNativeDeepLinks();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  document.dispatchEvent(new CustomEvent('bridge:auth-transition'));
  now += 10 * 60_000 + 1;
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
  finishOld(response(['linked-channel']));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(fetch).toHaveBeenCalledOnce();
  expect(navigate).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});
