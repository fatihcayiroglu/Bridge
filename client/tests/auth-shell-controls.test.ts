// client/tests/auth-shell-controls.test.ts
//
// The login screen has no inline handlers: every button and every Enter key
// reaches auth-compat through one delegated click listener and one keydown
// listener keyed by `data-auth-action` / `data-auth-tab` / `data-auth-enter`.
// The recovery controls were already driven that way (ux-final21-recovery);
// sign-in, the second-factor step, registration and the passkey buttons were
// only ever called as functions, so a broken attribute or listener arm would
// leave a visible control that does nothing.
//
// This suite loads the REAL auth screen from `client/index.html`, presses the
// real controls and checks the request each one sends and what the person
// sees. It also pins:
//   - Back from the second-factor step drops the pending temp token;
//   - an answer to a superseded sign-in step (Back, tab switch) shows nothing;
//   - server bodies are never reflected for unexpected statuses;
//   - the SSO callback route does not restore the previously stored session,
//     and a handoff superseded while `/api/me` is in flight does not sign in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../js/core/i18n/index.ts';

vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
// Partial: api-fetch (reached by session restore) needs the other real exports.
vi.mock('../js/core/globals.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../js/core/globals.ts')>(),
  getAPI: () => 'http://test.local',
}));

const SHELL = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const AUTH_SCREEN = SHELL.slice(SHELL.indexOf('<div id="auth-screen"'), SHELL.indexOf('<!-- MAIN APP -->'));
const PANEL = '<div id="app" style="display:none"></div><div id="my-avatar"></div><div id="my-username"></div><div id="my-status-dot"></div><div id="my-tag"></div>';

type AuthModule = typeof import('../js/core/auth-compat.ts');
const fetchMock = vi.fn();
const pageErrors: unknown[] = [];
const onPageError = (event: ErrorEvent) => { pageErrors.push(event.error ?? event.message); };

// Each fresh import binds its own document listeners (the product loads the
// module once); remove them after every test so one click reaches one module.
const added: Array<[string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined]> = [];
const nativeAdd = document.addEventListener.bind(document);

async function freshModule(url = '/'): Promise<AuthModule> {
  window.history.replaceState(null, '', url);
  vi.resetModules();
  const mod = await import('../js/core/auth-compat.ts');
  await new Promise(r => setTimeout(r, 0));
  return mod;
}
function reply(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const input = (id: string, value: string) => { $<HTMLInputElement>(`#${id}`).value = value; };
const press = (selector: string) => $(selector).click();
const enter = (id: string, key = 'Enter') =>
  $(`#${id}`).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
const shown = (id: string) => $(`#${id}`).style.display !== 'none';
const message = () => (shown('auth-msg') ? $('#auth-msg').textContent ?? '' : '');
const posts = () => fetchMock.mock.calls.map(([url, init]) => ({
  url: String(url), body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
}));
const settle = () => new Promise(r => setTimeout(r, 0));
const user = { _id: 'u1', username: 'alice', displayName: 'Alice Doe' };

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = AUTH_SCREEN + PANEL;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  pageErrors.length = 0;
  window.addEventListener('error', onPageError);
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    added.push([type, listener, options]);
    nativeAdd(type, listener, options);
  });
});
afterEach(() => {
  for (const [type, listener, options] of added.splice(0)) document.removeEventListener(type, listener, options);
  window.removeEventListener('error', onPageError);
  delete (globalThis as Record<string, unknown>).BridgeWebAuthn;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

describe('the real auth shell exposes every control it renders', () => {
  it('every data-auth-action / data-auth-enter in index.html is one this suite drives', () => {
    const actions = [...new Set([...AUTH_SCREEN.matchAll(/data-auth-action="([^"]+)"/g)].map(m => m[1]))].sort();
    const enters = [...new Set([...AUTH_SCREEN.matchAll(/data-auth-enter="([^"]+)"/g)].map(m => m[1]))].sort();
    expect(actions).toEqual(['cancel-2fa', 'complete-2fa', 'forgot', 'forgot-send', 'login', 'passkey-login',
      'passkey-register', 'recovery-back', 'register', 'reset-save']);
    expect(enters).toEqual(['complete-2fa', 'forgot-send', 'login', 'register', 'reset-save']);
  });
});

describe('sign in', () => {
  it('Sign In posts the typed credentials once and opens the app with the returned session', async () => {
    await freshModule();
    fetchMock.mockResolvedValueOnce(reply(200, { token: 'access-1', user }));
    input('l-username', '  alice  ');
    input('l-password', ' pass with spaces ');
    press('#login-credentials [data-auth-action="login"]');
    await settle();

    expect(posts()).toEqual([{ url: 'http://test.local/api/login', body: { username: 'alice', password: ' pass with spaces ' } }]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', credentials: 'include', redirect: 'error' });
    expect(localStorage.getItem('token')).toBe('access-1');
    expect(shown('auth-screen')).toBe(false);
    expect($('#app').style.display).toBe('flex');
    expect($('#my-avatar').textContent).toBe('AD');
    expect(pageErrors).toEqual([]);
  });

  it('Enter in the password field signs in; other keys and fields without an Enter action do not', async () => {
    await freshModule();
    fetchMock.mockResolvedValue(reply(401, { error: 'Invalid credentials for alice from 10.0.0.1' }));
    input('l-username', 'alice');
    input('l-password', 'wrong');
    enter('l-password', 'a');
    enter('l-username');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();

    enter('l-password');
    await settle();
    expect(posts()).toEqual([{ url: 'http://test.local/api/login', body: { username: 'alice', password: 'wrong' } }]);
    expect(message()).toBe(t('auth_invalid_credentials', 'Kullanıcı adı veya şifre hatalı.'));
  });

  it('an unexpected refusal (403) says sign-in failed and never shows the server text', async () => {
    await freshModule();
    fetchMock.mockResolvedValueOnce(reply(403, { error: 'Account suspended by admin@internal' }));
    input('l-username', 'alice');
    input('l-password', 'secret-pass');
    press('#login-credentials [data-auth-action="login"]');
    await settle();
    expect(message()).toBe(t('auth_login_failed', 'Giriş başarısız.'));
    expect(document.body.textContent).not.toContain('admin@internal');
    expect(shown('auth-screen')).toBe(true);
  });

  it('clicks that are not on an auth control, or not on an element, do nothing', async () => {
    await freshModule();
    $('.auth-brand h1').click();
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown('login-form')).toBe(true);
    expect(pageErrors).toEqual([]);
  });
});

describe('second factor', () => {
  async function challenge(): Promise<void> {
    fetchMock.mockResolvedValueOnce(reply(202, { requiresTwoFactor: true, tempToken: 'temp-1' }));
    input('l-username', 'alice');
    input('l-password', 'secret-pass');
    press('#login-credentials [data-auth-action="login"]');
    await settle();
  }

  it('a 2FA challenge swaps to the code step; Enter and Verify send the temp token with the code', async () => {
    await freshModule();
    await challenge();
    expect(shown('login-credentials')).toBe(false);
    expect(shown('twofactor-login-form')).toBe(true);
    expect(document.activeElement?.id).toBe('l-2fa-code');
    expect(localStorage.getItem('token')).toBeNull();

    fetchMock.mockResolvedValueOnce(reply(401, { error: 'bad code' }));
    input('l-2fa-code', ' 123456 ');
    enter('l-2fa-code');
    await settle();
    expect(message()).toBe(t('auth_invalid_code', 'Doğrulama kodu geçersiz veya süresi dolmuş.'));

    fetchMock.mockResolvedValueOnce(reply(200, { token: 'access-2', user }));
    press('#twofactor-login-form [data-auth-action="complete-2fa"]');
    await settle();
    expect(posts().slice(1)).toEqual([
      { url: 'http://test.local/api/2fa/check', body: { tempToken: 'temp-1', code: '123456' } },
      { url: 'http://test.local/api/2fa/check', body: { tempToken: 'temp-1', code: '123456' } },
    ]);
    expect(localStorage.getItem('token')).toBe('access-2');
    expect($('#app').style.display).toBe('flex');
  });

  it('Back returns to the credentials, clears the code and drops the temp token', async () => {
    await freshModule();
    await challenge();
    input('l-2fa-code', '654321');
    press('#twofactor-login-form [data-auth-action="cancel-2fa"]');
    expect(shown('login-credentials')).toBe(true);
    expect(shown('twofactor-login-form')).toBe(false);
    expect($<HTMLInputElement>('#l-2fa-code').value).toBe('');

    input('l-2fa-code', '654321');
    press('#twofactor-login-form [data-auth-action="complete-2fa"]');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(message()).toBe(t('ui_dogrulama_kodunu_girin', 'Doğrulama kodunu girin.'));
  });

  it('a code check that fails after the person pressed Back shows nothing', async () => {
    await freshModule();
    await challenge();
    const check = deferred<Response>();
    fetchMock.mockReturnValueOnce(check.promise);
    input('l-2fa-code', '123456');
    press('#twofactor-login-form [data-auth-action="complete-2fa"]');
    const before = message();
    press('#twofactor-login-form [data-auth-action="cancel-2fa"]');
    check.reject(new TypeError('Failed to fetch'));
    await settle();
    expect(message()).toBe(before);
    expect(shown('login-credentials')).toBe(true);
  });
});

describe('registration', () => {
  it('the Create Account tab shows the form; its button and Enter post the registration', async () => {
    await freshModule();
    press('[data-auth-tab="register"]');
    expect(shown('register-form')).toBe(true);
    expect(shown('login-form')).toBe(false);
    expect($('[data-auth-tab="register"]').classList.contains('active')).toBe(true);
    expect($('[data-auth-tab="login"]').classList.contains('active')).toBe(false);

    fetchMock.mockResolvedValueOnce(reply(409, { error: 'duplicate key value violates unique constraint "users_username_key"' }));
    input('r-displayname', 'Alice');
    input('r-username', 'alice_1');
    input('r-password', 'long-enough-pw');
    press('#register-form [data-auth-action="register"]');
    await settle();
    expect(message()).toBe(t('auth_username_taken', 'Bu kullanıcı adı zaten kullanılıyor.'));
    expect(document.body.textContent).not.toContain('users_username_key');

    fetchMock.mockResolvedValueOnce(reply(201, { token: 'access-3', user: { _id: 'u3', username: 'alice_1' } }));
    enter('r-password');
    await settle();
    expect(posts()).toEqual([
      { url: 'http://test.local/api/register', body: { username: 'alice_1', password: 'long-enough-pw', displayName: 'Alice' } },
      { url: 'http://test.local/api/register', body: { username: 'alice_1', password: 'long-enough-pw', displayName: 'Alice' } },
    ]);
    expect(localStorage.getItem('token')).toBe('access-3');

    press('[data-auth-tab="login"]');
    expect(shown('login-form')).toBe(true);
    expect(shown('register-form')).toBe(false);
  });

  it('names the broken rule before any request: username length, password too long', async () => {
    await freshModule();
    press('[data-auth-tab="register"]');
    input('r-username', 'ab');
    input('r-password', 'long-enough-pw');
    press('#register-form [data-auth-action="register"]');
    expect(message()).toBe(t('auth_err_username_length'));

    input('r-username', 'alice');
    input('r-password', 'x'.repeat(129));
    enter('r-password');
    expect(message()).toBe(t('auth_err_password_long'));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a registration that fails after the person switched tabs shows nothing', async () => {
    await freshModule();
    press('[data-auth-tab="register"]');
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    input('r-username', 'alice');
    input('r-password', 'long-enough-pw');
    press('#register-form [data-auth-action="register"]');
    press('[data-auth-tab="login"]');
    pending.reject(new TypeError('Failed to fetch'));
    await settle();
    expect(message()).toBe('');
    expect(shown('login-form')).toBe(true);
  });
});

describe('passkey buttons', () => {
  it('call the WebAuthn owner, including when the click lands on the icon inside the button', async () => {
    const api = { passkeyLogin: vi.fn(), registerPasskey: vi.fn() };
    (globalThis as Record<string, unknown>).BridgeWebAuthn = api;
    await freshModule();
    $('[data-auth-action="passkey-login"] svg').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    press('[data-auth-action="passkey-register"]');
    expect(api.passkeyLogin).toHaveBeenCalledTimes(1);
    expect(api.registerPasskey).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('do nothing, and throw nothing, when the WebAuthn owner is absent', async () => {
    await freshModule();
    press('[data-auth-action="passkey-login"]');
    press('[data-auth-action="passkey-register"]');
    await settle();
    expect(pageErrors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('user panel initials', () => {
  it('a display name made only of spaces falls back to the B avatar, not an empty one', async () => {
    const auth = await freshModule();
    auth.updateUserPanel({ _id: 'u1', displayName: '   ' });
    expect($('#my-avatar').textContent).toBe('B');
  });
});

describe('SSO callback boot', () => {
  it('on /sso-callback the stored session is not restored: only the handoff and its own /api/me run', async () => {
    localStorage.setItem('token', 'previous-session');
    fetchMock
      .mockResolvedValueOnce(reply(200, { token: 'sso-access' }))
      .mockResolvedValueOnce(reply(200, { user: { _id: 'sso-user', username: 'sso' } }));
    await freshModule('/sso-callback');
    // Session restore reaches /api/me through a dynamic import of api-fetch.
    // Load that module here too, so a wrongly started restore would have
    // issued its request before the assertion below.
    await import('../js/core/api-fetch.ts');
    for (let i = 0; i < 5; i++) await settle();
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)).toEqual([
      'POST http://test.local/api/sso/session',
      'GET http://test.local/api/me',
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer sso-access' });
    expect(localStorage.getItem('token')).toBe('sso-access');
    expect(window.location.pathname).toBe('/');
  });

  it('a handoff superseded while /api/me is in flight neither signs anyone in nor reports its stale outcome', async () => {
    for (const late of [reply(200, { user: { _id: 'sso-user', username: 'sso' } }), reply(401, { error: 'expired' })]) {
      const me = deferred<Response>();
      fetchMock
        .mockResolvedValueOnce(reply(200, { token: 'sso-access' }))
        .mockReturnValueOnce(me.promise);
      await freshModule('/sso-callback');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      press('[data-auth-tab="register"]');
      me.resolve(late);
      await settle();
      expect(localStorage.getItem('token')).toBeNull();
      expect(shown('auth-screen')).toBe(true);
      expect($('#app').style.display).toBe('none');
      expect(message()).toBe('');
      expect(window.location.pathname).toBe('/');
      for (const [type, listener, options] of added.splice(0)) document.removeEventListener(type, listener, options);
      fetchMock.mockReset();
    }
  });

  it('a handoff superseded while the /api/me body is still being read does not sign anyone in', async () => {
    const body = deferred<unknown>();
    let bodyRequested = false;
    fetchMock
      .mockResolvedValueOnce(reply(200, { token: 'sso-access' }))
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => { bodyRequested = true; return body.promise; } } as unknown as Response);
    await freshModule('/sso-callback');
    await vi.waitFor(() => expect(bodyRequested).toBe(true));
    press('[data-auth-tab="register"]');
    body.resolve({ user: { _id: 'sso-user', username: 'sso' } });
    await settle();
    expect(localStorage.getItem('token')).toBeNull();
    expect($('#app').style.display).toBe('none');
    expect(message()).toBe('');
  });
});
