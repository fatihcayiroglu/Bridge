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
