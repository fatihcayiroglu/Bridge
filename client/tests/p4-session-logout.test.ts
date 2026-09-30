// client/tests/p4-session-logout.test.ts
//
// P4 — SIGNING OUT ENDS THE SESSION AND THIS INSTALLATION'S PUSH DELIVERY.
//
// MEASURED (real Chromium, local server): after the client's logout the refresh session was still
// alive — `/api/refresh` answered 200. The refresh cookie is path-scoped to `/api/refresh`, the
// client posted to `/api/logout` with `redirect: 'error'`, the server answered 307, the redirect was
// never followed (under the service worker the page even received a synthetic 503 "offline").
//
// These tests pin the new contract; the first one is the negative control for the old request.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'https://api.bridge.test' }));

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));

const shell = `
  <div id="auth-msg"></div>
  <div id="login-credentials"><input id="l-username" /><input id="l-password" /></div>
  <form id="login-form"><button class="btn-primary">Sign In</button></form>
  <div id="twofactor-login-form" style="display:none"><input id="l-2fa-code" /><button class="btn-primary">Verify</button></div>
  <form id="register-form"><button class="btn-primary">Create</button></form>
  <input id="r-username" /><input id="r-displayname" /><input id="r-password" />
  <div id="app"></div><div id="auth-screen"></div>
`;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.body.innerHTML = shell;
  localStorage.clear();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response));
  vi.stubGlobal('fetch', fetchMock);
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ok: true, status: 200 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('logout() ends the server session (P4-01)', () => {
  it('posts straight to the path-scoped /api/refresh/logout — never the redirecting /api/logout', async () => {
    const { logout } = await import('../js/core/auth-compat.ts');
    logout();

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls).toContain('https://api.bridge.test/api/refresh/logout');
    // Negative control: the old request (answered with a 307 the client refused to follow).
    expect(urls).not.toContain('https://api.bridge.test/api/logout');
    const init = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/refresh/logout'))?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('names this installation\'s push targets so the server can stop delivering to it (P4-03)', async () => {
    localStorage.setItem('bridge_native_push_token', 'fcm-install-1');
    localStorage.setItem('bridge_web_push_endpoint', 'https://push.example/ep-1');
    const { logout } = await import('../js/core/auth-compat.ts');
    logout();

    const init = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/refresh/logout'))?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      push: { nativeToken: 'fcm-install-1', webEndpoint: 'https://push.example/ep-1' },
    });
  });

  it('with no push installation the body carries no identifiers', async () => {
    const { logout } = await import('../js/core/auth-compat.ts');
    logout();
    const init = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/refresh/logout'))?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ push: {} });
  });
});

describe('web push is unbound from a signed-out browser (P4-16)', () => {
  it('logout retires the browser subscription and forgets the endpoint', async () => {
    const unsubscribe = vi.fn(async () => true);
    const subscription = { endpoint: 'https://push.example/ep-2', unsubscribe };
    const registration = { pushManager: { getSubscription: vi.fn(async () => subscription) } };
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('PushManager', function PushManager() {});
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration) } });
    localStorage.setItem('bridge_web_push_endpoint', 'https://push.example/ep-2');
    localStorage.setItem('bridge_web_push_server_synced_v1', 'yes');

    const { bindWebPushToSession, _resetWebPushSessionBindingForTest } = await import('../js/core/notifications/web-push-client.ts');
    _resetWebPushSessionBindingForTest();
    bindWebPushToSession();

    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem('bridge_web_push_endpoint')).toBeNull();
    expect(localStorage.getItem('bridge_web_push_server_synced_v1')).toBeNull();
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });
});
