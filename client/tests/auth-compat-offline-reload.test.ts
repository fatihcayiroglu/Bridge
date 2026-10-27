// P7 offline reload (owner decision on #497): the session bootstrap opens a
// LOCAL-ONLY session from the device's offline grant when the server cannot be
// reached, never for an explicit 401/403, and ends it on refusal or logout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.fn();
const registryCall = vi.fn();
const unlockMock = vi.fn();
const recordMock = vi.fn(async (..._args: unknown[]) => undefined);
const clearMock = vi.fn(async () => undefined);

vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'http://test.local' }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: { call: registryCall, get: vi.fn(), register: vi.fn(), has: vi.fn(() => false) },
}));
vi.mock('../js/core/local-first/offline-session.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/local-first/offline-session.ts')>('../js/core/local-first/offline-session.ts');
  return {
    tokenAccountId: real.tokenAccountId,
    unlockOfflineSession: (...args: unknown[]) => unlockMock(...args),
    recordOfflineSession: (...args: unknown[]) => recordMock(...args),
    clearOfflineSession: (...args: unknown[]) => clearMock(...args),
  };
});

function token(id: string): string {
  const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
  return `${b64({ alg: 'HS256' })}.${b64({ id })}.sig`;
}

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: vi.fn(async () => body) } as unknown as Response;
}
const offline = () => response(503, { error: 'offline' }, { 'X-Bridge-Offline': '1' });
const USER = { _id: 'u-offline', username: 'alice' };

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  apiFetchMock.mockReset();
  registryCall.mockReset();
  unlockMock.mockReset();
  recordMock.mockClear();
  clearMock.mockClear();
  localStorage.clear();
  document.body.innerHTML = `
    <div id="auth-msg"></div><div id="auth-screen"></div><div id="app" style="display:none"></div>
    <div id="my-avatar"></div><div id="my-username"></div><div id="my-status-dot"></div><div id="my-tag"></div>
    <div class="auth-tab"></div><div class="auth-tab"></div>`;
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200, {})));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function boot() {
  const authority = await import('../js/core/session-authority.ts');
  const auth = await import('../js/core/auth-compat.ts');
  await flush();
  return { auth, authority };
}

describe('P7 offline reload session bootstrap', () => {
  it('unreachable server + valid offline grant: local-only shell, no retries, no auth-success, waits for the network', async () => {
    localStorage.setItem('token', token(USER._id));
    apiFetchMock.mockResolvedValue(offline());
    unlockMock.mockResolvedValue({ ok: true, user: USER, validatedAt: 1 });
    const events: string[] = [];
    for (const name of ['bridge:auth-success', 'bridge:auth-local']) document.addEventListener(name, () => events.push(name));

    const { authority } = await boot();

    expect(apiFetchMock).toHaveBeenCalledTimes(1); // the offline answer is not retried
    expect(unlockMock).toHaveBeenCalledWith(token(USER._id));
    expect(authority.sessionAuthority()).toBe('local');
    expect(document.getElementById('app')!.style.display).toBe('flex');
    expect(events).toEqual(['bridge:auth-local']);
    expect(registryCall).toHaveBeenCalledWith('setMe', USER);
    expect(recordMock).not.toHaveBeenCalled(); // a local session never renews its own grant

    // The network returns: /api/me validates and the normal session starts.
    apiFetchMock.mockResolvedValue(response(200, { user: USER }));
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(authority.sessionAuthority()).toBe('server');
    expect(events).toEqual(['bridge:auth-local', 'bridge:auth-success']);
    expect(recordMock).toHaveBeenCalledWith(USER, token(USER._id), undefined, expect.any(Function));
    expect((recordMock.mock.calls.at(-1)![3] as () => boolean)()).toBe(true);
  });

  it('a failed fetch (no service worker) is treated the same as the offline answer', async () => {
    localStorage.setItem('token', token(USER._id));
    apiFetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    unlockMock.mockResolvedValue({ ok: true, user: USER, validatedAt: 1 });
    const { authority } = await boot();
    expect(authority.sessionAuthority()).toBe('local');
  });

  it.each(['no-grant', 'no-device-key', 'token-mismatch', 'expired', 'corrupt', 'erased'])(
    'no valid offline grant (%s): stays on sign-in',
    async (reason) => {
      localStorage.setItem('token', token(USER._id));
      apiFetchMock.mockResolvedValue(offline());
      unlockMock.mockResolvedValue({ ok: false, reason });
      const { authority } = await boot();
      expect(authority.sessionAuthority()).toBe('none');
      expect(document.getElementById('app')!.style.display).toBe('none');
    });

  it('an explicit 401/403 never opens local history and removes the grant', async () => {
    for (const status of [401, 403]) {
      vi.resetModules();
      clearMock.mockClear();
      unlockMock.mockReset();
      localStorage.setItem('token', token(USER._id));
      apiFetchMock.mockResolvedValue(response(status, { error: 'no' }));
      const { authority } = await boot();
      expect(unlockMock).not.toHaveBeenCalled();
      expect(authority.sessionAuthority()).toBe('none');
      expect(clearMock).toHaveBeenCalledWith(USER._id);
    }
  });

  it('a refusal after reconnect ends the local-only session; logout removes the grant', async () => {
    localStorage.setItem('token', token(USER._id));
    apiFetchMock.mockResolvedValue(offline());
    unlockMock.mockResolvedValue({ ok: true, user: USER, validatedAt: 1 });
    const { authority } = await boot();
    expect(authority.sessionAuthority()).toBe('local');

    apiFetchMock.mockResolvedValue(response(403, { error: 'ACCOUNT_DISABLED' }));
    window.dispatchEvent(new Event('online'));
    await flush();
    expect(authority.sessionAuthority()).toBe('none');
    expect(document.getElementById('app')!.style.display).toBe('none');
    expect(clearMock).toHaveBeenCalledWith(USER._id);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('a server-validated session records the grant; a token refresh moves it; switching accounts clears the old one', async () => {
    const { auth } = await boot();
    const first = token('first-user');
    await auth.startApp(first, { _id: 'first-user', username: 'a' });
    expect(recordMock).toHaveBeenLastCalledWith({ _id: 'first-user', username: 'a' }, first, undefined, expect.any(Function));
    const firstWrite = recordMock.mock.calls.at(-1)![3] as () => boolean;
    expect(firstWrite()).toBe(true);
    const refreshed = token('first-user') + 'x';
    auth.saveToken(refreshed);
    expect(recordMock).toHaveBeenLastCalledWith({ _id: 'first-user', username: 'a' }, refreshed, undefined, expect.any(Function));
    expect(firstWrite()).toBe(false);
    const refreshedWrite = recordMock.mock.calls.at(-1)![3] as () => boolean;
    expect(refreshedWrite()).toBe(true);

    await auth.startApp(token('second-user'), { _id: 'second-user' });
    expect(clearMock).toHaveBeenCalledWith('first-user');
    expect(refreshedWrite()).toBe(false);
    const secondWrite = recordMock.mock.calls.at(-1)![3] as () => boolean;
    expect(secondWrite()).toBe(true);

    clearMock.mockClear();
    auth.logout();
    expect(clearMock).toHaveBeenCalledWith('second-user');
    expect(secondWrite()).toBe(false);
  });

  it('invalidates a delayed grant when another tab removes the canonical token without a local auth event', async () => {
    const { auth } = await boot();
    await auth.startApp(token(USER._id), USER);
    const canWrite = recordMock.mock.calls.at(-1)![3] as () => boolean;
    expect(canWrite()).toBe(true);
    localStorage.removeItem('token');
    localStorage.removeItem('bridge_token');
    expect(canWrite()).toBe(false);
  });
});
