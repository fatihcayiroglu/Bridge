// client/tests/p7-step-up-client.test.ts
//
// P7 B2 — the client step-up owner (js/core/step-up.ts) and its one caller,
// apiFetch: a `403 STEP_UP_REQUIRED` refusal leads to ONE proof through the
// existing product dialog (password, or an authenticator / backup code for 2FA
// accounts), the grant is held in memory only and sent in the explicit
// X-Bridge-Step-Up header, the request is retried once, concurrent refusals
// share one prompt, and cancel returns the original 403.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  token: 'access-token' as string | null,
  logout: vi.fn(),
  prompt: vi.fn<(options: Record<string, unknown>) => Promise<string | null>>(),
  confirm: vi.fn<(options: Record<string, unknown>) => Promise<boolean>>(),
}));

vi.mock('../js/core/globals.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../js/core/globals.ts')>()),
  getAPI: () => 'https://bridge.test',
  toServerUrl: (url: string) => url,
}));
vi.mock('../js/core/auth-compat.ts', () => ({
  readToken: () => mocks.token,
  saveToken: vi.fn(),
  logout: mocks.logout,
}));
vi.mock('../js/core/product-dialog.ts', () => ({
  promptProductText: mocks.prompt,
  confirmProductAction: mocks.confirm,
}));

import { apiFetch, resetCsrfState, resetRefreshState } from '../js/core/api-fetch.ts';
import {
  STEP_UP_HEADER, clearStepUpGrants, grantFor, obtainStepUp, readStepUpRefusal, rememberGrant,
  rememberSignInGrants, scopeForRequest, type StepUpRefusal,
} from '../js/core/step-up.ts';
import { t } from '../js/core/i18n/index.ts';

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function response(body: unknown = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone: () => response(body, status),
  } as unknown as Response;
}

function refusalBody(over: Partial<StepUpRefusal> = {}): StepUpRefusal {
  return {
    error: 'STEP_UP_REQUIRED', action: 'account.export', scope: 'sensitive-export', reasons: ['step_up_missing'],
    why: 'The export contains your whole account history.', level: 1, methods: ['password', 'sign_in'], ttlMs: 600_000,
    ...over,
  };
}

const grantBody = (scope: string, token: string) =>
  ({ ok: true, stepUp: { scope, token, level: 1, method: 'password', expiresAt: Date.now() + 600_000, ttlMs: 600_000 } });

let fetchMock: ReturnType<typeof vi.fn>;
let routes: Array<{ match: (url: string, init: RequestInit) => boolean; handle: Handler }>;

function route(match: (url: string, init: RequestInit) => boolean, handle: Handler) { routes.push({ match, handle }); }
const stepUpHeaderOf = (call: number) => new Headers((fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers).get(STEP_UP_HEADER);
const callsTo = (fragment: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(fragment));

beforeEach(() => {
  mocks.token = 'access-token';
  mocks.logout.mockReset();
  mocks.prompt.mockReset();
  mocks.confirm.mockReset();
  resetCsrfState();
  resetRefreshState();
  clearStepUpGrants();
  routes = [];
  route((url) => url.includes('/api/csrf-token'), () => response({ token: 'csrf' }));
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const hit = routes.find(r => r.match(String(url), init));
    if (!hit) throw new Error(`unexpected request ${String(url)}`);
    return hit.handle(String(url), init);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('which requests carry which grant', () => {
  it.each([
    ['POST', '/api/email/add', 'account-security'],
    ['POST', 'https://bridge.test/api/v1/webauthn/register/begin', 'account-security'],
    ['POST', '/api/webauthn/register/complete', 'account-security'],
    ['DELETE', '/api/webauthn/credentials/abc', 'account-security'],
    ['POST', '/api/2fa/setup', 'account-security'],
    ['POST', '/api/2fa/backup-codes/regenerate', 'account-security'],
    ['GET', '/api/account/export', 'sensitive-export'],
    ['DELETE', '/api/account', 'destructive-admin'],
    ['DELETE', '/api/servers/s1', 'destructive-admin'],
    ['DELETE', '/api/admin/users/u1', 'destructive-admin'],
    ['POST', '/api/servers/s1/bans', 'moderation-burst'],
    ['post', '/api/servers/s1/members/u1/kick', 'moderation-burst'],
    ['DELETE', '/api/channels/bulk', 'moderation-burst'],
  ])('%s %s → %s', (method, url, scope) => {
    expect(scopeForRequest(method, url)).toBe(scope);
  });

  it.each([
    ['GET', '/api/servers/s1'],
    ['POST', '/api/2fa/check'],
    ['DELETE', '/api/servers/s1/bans/u1'],
    ['DELETE', '/api/2fa'],
    ['GET', 'http://[broken'],
  ])('%s %s is not protected', (method, url) => {
    expect(scopeForRequest(method, url)).toBeNull();
  });
});

describe('memory-only grants', () => {
  it('a sign-in replaces earlier grants with one per scope and never touches browser storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    rememberGrant('moderation-burst', 'old', Date.now() + 600_000);
    rememberSignInGrants({ expiresAt: Date.now() + 600_000, grants: { 'account-security': 'g-acc', 'sensitive-export': 'g-exp', bogus: 'x', 'destructive-admin': 7 } });
    expect(grantFor('account-security')).toBe('g-acc');
    expect(grantFor('sensitive-export')).toBe('g-exp');
    expect(grantFor('destructive-admin')).toBeNull();
    expect(grantFor('moderation-burst')).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
  });

  it('ignores malformed sign-in payloads and drops grants that are about to expire', () => {
    for (const bad of [undefined, null, 'x', { grants: 'no' }, []]) {
      rememberGrant('account-security', 'held', Date.now() + 600_000);
      rememberSignInGrants(bad);
      expect(grantFor('account-security')).toBeNull();
    }
    rememberGrant('account-security', 'soon', Date.now() + 3_000);
    expect(grantFor('account-security')).toBeNull();
    rememberGrant('account-security', '', Date.now() + 600_000);
    rememberGrant('account-security', 'nan', Number.NaN);
    expect(grantFor('account-security')).toBeNull();
  });

  it('sign-out drops every grant', () => {
    rememberGrant('destructive-admin', 'g', Date.now() + 600_000);
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    expect(grantFor('destructive-admin')).toBeNull();
  });
});

describe('localised explanations', () => {
  it.each([
    ['email.change', 'stepup_why_email_change'],
    ['passkey.add', 'stepup_why_passkey_add'],
    ['passkey.remove', 'stepup_why_passkey_remove'],
    ['two_factor.enable', 'stepup_why_two_factor_enable'],
    ['two_factor.disable', 'stepup_why_two_factor_disable'],
    ['backup_codes.regenerate', 'stepup_why_backup_codes'],
    ['account.export', 'stepup_why_account_export'],
    ['account.delete', 'stepup_why_account_delete'],
    ['server.delete', 'stepup_why_server_delete'],
    ['admin.user.delete', 'stepup_why_admin_user_delete'],
    ['admin.server.delete', 'stepup_why_admin_server_delete'],
    ['moderation.ban', 'stepup_why_moderation_burst'],
    ['moderation.kick', 'stepup_why_moderation_burst'],
    ['messages.bulk_delete', 'stepup_why_moderation_burst'],
    ['something.new', 'stepup_generic_why'],
  ])('%s → %s', async (action, key) => {
    mocks.prompt.mockResolvedValueOnce(null);
    await obtainStepUp(refusalBody({ action }), null, { send: vi.fn(), signInAgain: vi.fn() });
    expect(mocks.prompt.mock.calls[0]![0].message).toBe(t(key));
    expect(t(key)).not.toBe(key);
  });
});

describe('readStepUpRefusal', () => {
  it('recognises only a well-formed 403 STEP_UP_REQUIRED and sanitises it', async () => {
    expect(await readStepUpRefusal(response(refusalBody(), 400))).toBeNull();
    expect(await readStepUpRefusal(response({ error: 'No permission' }, 403))).toBeNull();
    expect(await readStepUpRefusal(response({ error: 'STEP_UP_REQUIRED', scope: '*' }, 403))).toBeNull();
    expect(await readStepUpRefusal({ status: 403, clone: () => { throw new Error('no body'); } } as unknown as Response)).toBeNull();
    expect(await readStepUpRefusal(response({ error: 'STEP_UP_REQUIRED', scope: 'sensitive-export', reasons: ['a', 3], methods: 'x', level: 2, ttlMs: 'n' }, 403)))
      .toEqual({ error: 'STEP_UP_REQUIRED', action: '', scope: 'sensitive-export', reasons: ['a'], why: undefined, level: 2, methods: [], ttlMs: undefined });
  });
});

describe('apiFetch + step-up', () => {
  it('a held grant rides along up front — a freshly signed-in person is never prompted', async () => {
    rememberGrant('sensitive-export', 'held-grant', Date.now() + 600_000);
    route((url) => url.endsWith('/api/account/export'), () => response({ format: 'bridge-personal-export' }));
    const res = await apiFetch('/api/account/export');
    expect(res.status).toBe(200);
    expect(stepUpHeaderOf(0)).toBe('held-grant');
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('unprotected requests carry no grant', async () => {
    rememberGrant('sensitive-export', 'held-grant', Date.now() + 600_000);
    route((url) => url.endsWith('/api/me'), () => response({}));
    await apiFetch('/api/me');
    expect(stepUpHeaderOf(0)).toBeNull();
  });

  it('a refusal asks once for the password, then retries with the new grant', async () => {
    let exportCalls = 0;
    route((url) => url.endsWith('/api/account/export'), (_url, init) => {
      exportCalls += 1;
      return new Headers(init.headers).get(STEP_UP_HEADER) === 'new-grant' ? response({ ok: true }) : response(refusalBody(), 403);
    });
    route((url) => url.endsWith('/api/step-up/password'), (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ password: 'correct horse', scope: 'sensitive-export' });
      return response(grantBody('sensitive-export', 'new-grant'));
    });
    mocks.prompt.mockResolvedValueOnce('correct horse');

    const res = await apiFetch('/api/account/export');
    expect(res.status).toBe(200);
    expect(exportCalls).toBe(2);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(mocks.prompt.mock.calls[0]![0]).toMatchObject({
      title: t('stepup_title'), inputType: 'password', inputLabel: t('stepup_password_label'),
      // Localised on the client; the server's English `why` is not shown.
      message: t('stepup_why_account_export'),
    });
    expect(mocks.prompt.mock.calls[0]![0]).not.toHaveProperty('error');
    expect(grantFor('sensitive-export')).toBe('new-grant');
    // The proof itself went through apiFetch (CSRF attached).
    expect(new Headers((callsTo('/api/step-up/password')[0]![1] as RequestInit).headers).get('X-CSRF-Token')).toBe('csrf');
  });

  it('an account with 2FA is asked for an authenticator or backup code', async () => {
    route((url) => url.endsWith('/api/2fa/setup'), (_url, init) =>
      new Headers(init.headers).get(STEP_UP_HEADER) === 'l2' ? response({ secret: 's' }) : response(refusalBody({ scope: 'account-security', action: 'two_factor.enable', level: 2, methods: ['totp', 'backup_code', 'sign_in'], why: undefined }), 403));
    route((url) => url.endsWith('/api/2fa/step-up'), (_url, init) => {
      expect(JSON.parse(String(init.body))).toEqual({ code: '123456', scope: 'account-security' });
      return response({ ok: true, stepUp: { token: 'l2', expiresAt: Date.now() + 600_000 } });
    });
    mocks.prompt.mockResolvedValueOnce('123456');
    expect((await apiFetch('/api/2fa/setup', { method: 'POST' })).status).toBe(200);
    expect(mocks.prompt.mock.calls[0]![0]).toMatchObject({ inputType: 'one-time-code', inputLabel: t('stepup_code_label'), message: t('stepup_why_two_factor_enable') });
  });

  it('cancel returns the original 403 and sends nothing more', async () => {
    route((url) => url.endsWith('/api/account/export'), () => response(refusalBody(), 403));
    mocks.prompt.mockResolvedValueOnce(null);
    const res = await apiFetch('/api/account/export');
    expect(res.status).toBe(403);
    expect(callsTo('/api/account/export')).toHaveLength(1);
    expect(callsTo('/api/step-up')).toHaveLength(0);
  });

  it('a wrong or empty proof re-asks with an explanation', async () => {
    route((url) => url.endsWith('/api/account/export'), (_url, init) =>
      new Headers(init.headers).get(STEP_UP_HEADER) ? response({ ok: true }) : response(refusalBody(), 403));
    let attempts = 0;
    route((url) => url.endsWith('/api/step-up/password'), () =>
      (++attempts === 1 ? response({ error: 'STEP_UP_PROOF_INVALID', locked: false }, 400) : response(grantBody('sensitive-export', 'g'))));
    mocks.prompt.mockResolvedValueOnce('  ').mockResolvedValueOnce('wrong').mockResolvedValueOnce('right');
    expect((await apiFetch('/api/account/export')).status).toBe(200);
    expect(mocks.prompt).toHaveBeenCalledTimes(3);
    expect(mocks.prompt.mock.calls[1]![0]).toMatchObject({ error: t('stepup_empty'), message: t('stepup_why_account_export') });
    expect(mocks.prompt.mock.calls[2]![0]).toMatchObject({ error: t('stepup_wrong') });
  });

  it('concurrent refusals for one scope share ONE prompt', async () => {
    route((url) => url.includes('/bans'), (_url, init) =>
      new Headers(init.headers).get(STEP_UP_HEADER) === 'mod' ? response({ ok: true }) : response(refusalBody({ scope: 'moderation-burst', action: 'moderation.ban', reasons: ['moderation_burst', 'step_up_missing'] }), 403));
    route((url) => url.endsWith('/api/step-up/password'), () => response(grantBody('moderation-burst', 'mod')));
    let release!: (v: string) => void;
    mocks.prompt.mockReturnValueOnce(new Promise<string>((resolve) => { release = resolve; }));
    const all = Promise.all([1, 2, 3].map(i => apiFetch(`/api/servers/s1/bans`, { method: 'POST', body: JSON.stringify({ userId: `u${i}` }) })));
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledTimes(1));
    release('pw');
    expect((await all).map(r => r.status)).toEqual([200, 200, 200]);
    expect(mocks.prompt).toHaveBeenCalledTimes(1);
    expect(callsTo('/api/step-up/password')).toHaveLength(1);
  });

  it('a held grant the request did not carry is used silently; a stale one is dropped and re-asked', async () => {
    rememberGrant('sensitive-export', 'held', Date.now() + 600_000);
    const hooks = { send: vi.fn(), signInAgain: vi.fn() };
    await expect(obtainStepUp(refusalBody(), null, hooks)).resolves.toBe('held');
    expect(mocks.prompt).not.toHaveBeenCalled();
    mocks.prompt.mockResolvedValueOnce(null);
    await expect(obtainStepUp(refusalBody({ reasons: ['step_up_revoked'] }), 'held', hooks)).resolves.toBeNull();
    expect(grantFor('sensitive-export')).toBeNull();
  });

  it('an account with no password or second factor (SSO-only) is told to sign in again', async () => {
    route((url) => url.endsWith('/api/account'), () => response(refusalBody({ scope: 'destructive-admin', action: 'account.delete', methods: ['sign_in'] }), 403));
    mocks.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect((await apiFetch('/api/account', { method: 'DELETE' })).status).toBe(403);
    expect(mocks.confirm.mock.calls[0]![0]).toMatchObject({ confirmLabel: t('stepup_sign_in_again') });
    expect(String(mocks.confirm.mock.calls[0]![0].message)).toContain(t('stepup_sign_in_again_body'));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    // Declining keeps the session.
    expect((await apiFetch('/api/account', { method: 'DELETE' })).status).toBe(403);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('locked proofs (refusal or 429 on the proof) lead to the sign-in-again explanation', async () => {
    const hooks = { send: vi.fn(async () => response({ error: 'STEP_UP_LOCKED' }, 429)), signInAgain: vi.fn() };
    mocks.confirm.mockResolvedValue(false);
    await expect(obtainStepUp(refusalBody({ reasons: ['step_up_missing', 'step_up_locked'], methods: ['sign_in'] }), null, hooks)).resolves.toBeNull();
    expect(String(mocks.confirm.mock.calls[0]![0].message)).toContain(t('stepup_locked'));
    mocks.prompt.mockResolvedValueOnce('pw');
    await expect(obtainStepUp(refusalBody(), null, hooks)).resolves.toBeNull();
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    const lockedBody = { send: vi.fn(async () => response({ error: 'STEP_UP_PROOF_INVALID', locked: true }, 400)), signInAgain: vi.fn() };
    mocks.prompt.mockResolvedValueOnce('pw');
    await expect(obtainStepUp(refusalBody(), null, lockedBody)).resolves.toBeNull();
    expect(mocks.confirm).toHaveBeenCalledTimes(3);
  });

  it('switches to the second factor when 2FA was turned on meanwhile, and to sign-in when there is no password', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(response({ error: 'STEP_UP_SECOND_FACTOR_REQUIRED', methods: ['totp', 'backup_code', 'sign_in'] }, 400))
      .mockResolvedValueOnce(response({ ok: true, stepUp: { token: 'l2', expiresAt: Date.now() + 600_000 } }));
    mocks.prompt.mockResolvedValueOnce('pw').mockResolvedValueOnce('654321');
    await expect(obtainStepUp(refusalBody(), null, { send, signInAgain: vi.fn() })).resolves.toBe('l2');
    expect(send.mock.calls.map(c => c[0])).toEqual(['/api/step-up/password', '/api/2fa/step-up']);
    expect(mocks.prompt.mock.calls[1]![0]).toMatchObject({ inputType: 'one-time-code' });

    clearStepUpGrants();
    const noPassword = vi.fn().mockResolvedValueOnce(response({ error: 'STEP_UP_NO_PASSWORD', methods: ['sign_in'] }, 400));
    mocks.prompt.mockResolvedValueOnce('pw');
    mocks.confirm.mockResolvedValueOnce(false);
    await expect(obtainStepUp(refusalBody(), null, { send: noPassword, signInAgain: vi.fn() })).resolves.toBeNull();
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
  });

  it('a failing or malformed proof response says so and lets the person cancel', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => { throw new Error('not json'); } } as unknown as Response)
      .mockResolvedValueOnce(response(['not', 'an', 'object'], 503));
    mocks.prompt.mockResolvedValueOnce('a').mockResolvedValueOnce('b').mockResolvedValueOnce('c').mockResolvedValueOnce(null);
    await expect(obtainStepUp(refusalBody(), null, { send, signInAgain: vi.fn() })).resolves.toBeNull();
    for (const call of [1, 2, 3]) expect(mocks.prompt.mock.calls[call]![0]).toMatchObject({ error: t('stepup_unavailable') });
  });

  it('if the prompt itself fails, apiFetch returns the original refusal', async () => {
    route((url) => url.endsWith('/api/account/export'), () => response(refusalBody(), 403));
    mocks.prompt.mockRejectedValueOnce(new Error('dialog unavailable'));
    expect((await apiFetch('/api/account/export')).status).toBe(403);
  });

  it('an ordinary 403 (missing permission) is returned untouched', async () => {
    route((url) => url.endsWith('/api/servers/s1/bans'), () => response({ error: 'No permission' }, 403));
    const res = await apiFetch('/api/servers/s1/bans', { method: 'POST', body: '{}' });
    expect(res.status).toBe(403);
    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(callsTo('/api/servers/s1/bans')).toHaveLength(1);
  });
});
