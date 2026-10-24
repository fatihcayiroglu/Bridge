import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const state = { token: 'old-account' as string | null };
  return { state, saveToken: vi.fn((token: string) => { state.token = token; }), logout: vi.fn(),
    storageAvailable: vi.fn(() => false), publishResult: vi.fn(), releaseLease: vi.fn() };
});
vi.mock('../js/core/auth-compat.ts', () => ({
  readToken: () => mocks.state.token, saveToken: mocks.saveToken, logout: mocks.logout,
}));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'https://bridge.test', toServerUrl: (url: string) => url }));
vi.mock('../js/core/refresh-coordinator.ts', () => ({
  storageAvailable: mocks.storageAvailable, tryAcquireLease: () => true, releaseLease: mocks.releaseLease,
  publishResult: mocks.publishResult, waitForOtherTab: vi.fn(),
}));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/bridge-registry.ts', () => ({ BridgeRegistry: { register: vi.fn() } }));

import { apiFetch, isConfirmedAccountDeletion, isRefreshInFlight, refreshAccessToken, resetCsrfState, resetRefreshState } from '../js/core/api-fetch.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
function replaceAccount(): void {
  mocks.state.token = 'new-account';
  document.dispatchEvent(new CustomEvent('bridge:auth-success'));
}
beforeEach(() => {
  resetRefreshState(); resetCsrfState();
  mocks.storageAvailable.mockReturnValue(false); mocks.publishResult.mockClear(); mocks.releaseLease.mockClear();
  mocks.state.token = 'old-account'; mocks.saveToken.mockClear(); mocks.logout.mockClear();
});
afterEach(() => { resetRefreshState(); resetCsrfState(); vi.unstubAllGlobals(); });

describe('HTTP work cannot cross a local account transition', () => {
  it.each(['bridge:auth-logout', 'bridge:auth-success', 'bridge:auth-transition'])('does not persist a pending refresh after %s', async event => {
    const pending = deferred<Response>();
    const fetch = vi.fn((_url: string, _init?: RequestInit) => pending.promise);
    vi.stubGlobal('fetch', fetch);
    const refreshing = refreshAccessToken();
    mocks.state.token = event === 'bridge:auth-logout' ? null : 'new-account';
    document.dispatchEvent(new CustomEvent(event));
    expect(fetch.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    pending.resolve(response({ token: 'old-account-refreshed' }));
    await expect(refreshing).resolves.toBe(false);
    expect(mocks.saveToken).not.toHaveBeenCalled();
    expect(mocks.state.token).toBe(event === 'bridge:auth-logout' ? null : 'new-account');
  });

  it('a stale refresh completion cannot clear the new account single-flight', async () => {
    mocks.storageAvailable.mockReturnValue(true);
    const old = deferred<Response>(), current = deferred<Response>();
    const fetch = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
    vi.stubGlobal('fetch', fetch);
    const first = refreshAccessToken(); replaceAccount();
    const second = refreshAccessToken();
    old.resolve(response({ token: 'old-refreshed' })); await first;
    expect(mocks.publishResult).not.toHaveBeenCalled();
    expect(mocks.releaseLease).not.toHaveBeenCalled();
    expect(isRefreshInFlight()).toBe(true);
    const shared = refreshAccessToken();
    expect(fetch).toHaveBeenCalledTimes(2);
    current.resolve(response({ token: 'new-refreshed' }));
    await expect(Promise.all([second, shared])).resolves.toEqual([true, true]);
    expect(mocks.state.token).toBe('new-refreshed');
    expect(mocks.publishResult).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.releaseLease).toHaveBeenCalledOnce();
  });

  it.each([401, 503])('ignores an earlier account refresh HTTP %s without poisoning the current session', async status => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockImplementationOnce(() => pending.promise)
      .mockImplementation(async () => response({ token: 'new-refreshed' }));
    vi.stubGlobal('fetch', fetch);
    const old = refreshAccessToken(); replaceAccount();
    await expect(refreshAccessToken()).resolves.toBe(true);
    pending.resolve(response({}, status)); await expect(old).resolves.toBe(false);
    await expect(refreshAccessToken()).resolves.toBe(true);
    expect(mocks.state.token).toBe('new-refreshed');
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('does not store a refresh body parsed after an account change', async () => {
    const body = deferred<{ token: string }>();
    const json = vi.fn(() => body.promise);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json })));
    const refreshing = refreshAccessToken();
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    replaceAccount(); body.resolve({ token: 'old-refreshed' });
    await expect(refreshing).resolves.toBe(false);
    expect(mocks.saveToken).not.toHaveBeenCalled();
    expect(mocks.state.token).toBe('new-account');
  });

  it('does not replay an old mutation when its initial 401 arrives after another login', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith('/csrf-token')) return response({ token: 'old-csrf' });
      if (url.endsWith('/refresh')) return response({ token: 'new-refreshed' });
      if (fetch.mock.calls.filter(([path]) => String(path).endsWith('/old-action')).length === 1) return pending.promise;
      return response({ success: true });
    });
    vi.stubGlobal('fetch', fetch);
    const request = apiFetch('https://bridge.test/api/old-action', { method: 'POST', body: 'old-private-body' });
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/old-action'))).toBe(true));
    replaceAccount(); pending.resolve(response({}, 401));
    const result = await request;
    expect(result.ok).toBe(false);
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/old-action'))).toHaveLength(1);
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/refresh'))).toBe(false);
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('does not send an old mutation after its CSRF preflight finishes in another session', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn(() => pending.promise); vi.stubGlobal('fetch', fetch);
    const request = apiFetch('https://bridge.test/api/old-action', { method: 'POST', body: 'old-private-body' });
    expect(fetch).toHaveBeenCalledOnce();
    replaceAccount(); pending.resolve(response({ token: 'old-csrf' }));
    const result = await request;
    expect(result.ok).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.state.token).toBe('new-account');
  });

  it('a stale CSRF completion cannot clear the replacement session preflight', async () => {
    const old = deferred<Response>(), current = deferred<Response>();
    const fetch = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise)
      .mockImplementation(async () => response({ success: true }));
    vi.stubGlobal('fetch', fetch);
    const first = apiFetch('https://bridge.test/api/old-action', { method: 'POST' });
    replaceAccount();
    const second = apiFetch('https://bridge.test/api/new-action', { method: 'POST' });
    old.resolve(response({ token: 'old-csrf' })); expect((await first).status).toBe(409);
    const third = apiFetch('https://bridge.test/api/new-action', { method: 'POST' });
    expect(fetch).toHaveBeenCalledTimes(2);
    current.resolve(response({ token: 'new-csrf' }));
    const results = await Promise.all([second, third]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(4);
    for (const call of fetch.mock.calls.slice(2)) {
      expect(String(call[0])).toContain('/new-action');
      expect(new Headers(call[1].headers).get('X-CSRF-Token')).toBe('new-csrf');
      expect(new Headers(call[1].headers).get('Authorization')).toBe('Bearer new-account');
    }
  });

  it('does not hand a delayed successful response from the old account to the caller', async () => {
    const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const request = apiFetch('https://bridge.test/api/me');
    replaceAccount(); pending.resolve(response({ privateOldAccount: 'must-not-escape' }));
    const result = await request;
    expect(result.status).toBe(409);
    expect(await result.typed()).toEqual({ error: 'AUTH_SESSION_CHANGED' });
  });

  it.each(['bridge:auth-logout', 'bridge:auth-success'])('retains only a verified deletion acknowledgement after %s', async event => {
    const pending = deferred<Response>();
    const fetch = vi.fn((url: string) => url.endsWith('/csrf-token')
      ? Promise.resolve(response({ token: 'csrf' })) : pending.promise);
    vi.stubGlobal('fetch', fetch);
    const deletion = apiFetch('/api/account', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    mocks.state.token = event === 'bridge:auth-logout' ? null : 'replacement-account';
    document.dispatchEvent(new CustomEvent(event));
    pending.resolve(response({ deleted: true, privateData: 'never exposed' }));
    const result = await deletion;
    expect(result.status).toBe(409);
    expect(await result.typed()).toEqual({ error: 'AUTH_SESSION_CHANGED' });
    expect(isConfirmedAccountDeletion(result)).toBe(true);
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('does not treat a fabricated or unrelated 409 as a confirmed deletion', async () => {
    expect(isConfirmedAccountDeletion(response({ error: 'AUTH_SESSION_CHANGED' }, 409))).toBe(false);
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const request = apiFetch('/api/me');
    replaceAccount(); pending.resolve(response({ deleted: true }));
    expect(isConfirmedAccountDeletion(await request)).toBe(false);
  });
});
