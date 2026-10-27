// server/tests/native-auth.test.ts
//
// Native sign-in (authorization code + PKCE) and native refresh rotation,
// against the real auth router, refresh-token rotation and in-memory store.
// Contract and threat model: docs/NATIVE_AUTH.md. These are server contract
// tests; they are NOT native-device or Keychain/Keystore evidence.
import crypto from 'crypto';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { setCookiesOf } from './helpers/httpDoubles';

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';
process.env.BASE_URL       = 'https://bridge.example';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createMockDb } = require('./helpers/mockDb');
const _db = createMockDb();
jest.mock('../db/loader', () => _db);
jest.mock('../db/index',  () => _db);

jest.mock('../lib/captcha', () => ({
  botFilterMiddleware:            () => (_req: Request, _res: Response, next: NextFunction) => next(),
  loginLockMiddleware:            (_req: Request, _res: Response, next: NextFunction) => next(),
  progressiveCaptchaMiddleware:   (_req: Request, _res: Response, next: NextFunction) => next(),
  captchaMiddleware:              (_req: Request, _res: Response, next: NextFunction) => next(),
  registrationThrottleMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
  recordFailedLogin:              jest.fn().mockResolvedValue(undefined),
  recordSuccessfulLogin:          jest.fn().mockResolvedValue(undefined),
  checkSuspiciousLogin:           jest.fn().mockResolvedValue(undefined),
  recordRegistration:             jest.fn().mockResolvedValue(undefined),
  claimRegistrationSlot:          jest.fn().mockResolvedValue(true),
  _getIp:                         () => '127.0.0.1',
  GENERIC_LOGIN_ERROR:            'Invalid username or password',
}));
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));
jest.mock('../middleware/rateLimit', () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  limits: new Proxy({}, { get: () => () => (_req: Request, _res: Response, next: NextFunction) => next() }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { router: authRouter } = require('../routes/auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createNativeAuthRouters } = require('../routes/nativeAuth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nativeAuthLib = require('../lib/nativeAuth');

const APP_REDIRECT = 'com.bridge.app:/oauth';
const LINK_REDIRECT = 'https://links.bridge.example/oauth';

function buildApp(env: Record<string, string | undefined> = {
  NATIVE_AUTH_REDIRECT_URIS: `${APP_REDIRECT},${LINK_REDIRECT}`, BASE_URL: 'https://bridge.example',
}): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const native = createNativeAuthRouters(nativeAuthLib.loadNativeAuthConfig(env));
  app.use('/api', authRouter);
  app.use('/api/refresh/native-authorize', native.authorize);
  app.use('/api/native-auth', native.token);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: err.message }));
  return app;
}

const app = buildApp();
beforeEach(() => { _db._reset?.(); });

const PASSWORD = 'nativeParola123';

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, state: crypto.randomBytes(16).toString('base64url') };
}

function refreshCookieOf(res: request.Response): string | null {
  const line = setCookiesOf(res.headers).find((c) => c.startsWith('bridge_refresh=') && !c.startsWith('bridge_refresh=;'));
  return line ? line.split(';')[0].slice('bridge_refresh='.length) : null;
}

async function browserSession(username: string) {
  const r = await request(app).post('/api/register').send({ username, password: PASSWORD });
  expect(r.status).toBe(200);
  return { cookie: refreshCookieOf(r) as string, userId: String(r.body.user._id ?? r.body.user.id), access: r.body.token as string };
}

function consent(cookie: string | null, fields: Record<string, string>, headers: Record<string, string> = { 'Sec-Fetch-Site': 'same-origin' }) {
  let req = request(app).post('/api/refresh/native-authorize').type('form').redirects(0);
  for (const [k, v] of Object.entries(headers)) req = req.set(k, v);
  if (cookie) req = req.set('Cookie', `bridge_refresh=${cookie}`);
  return req.send(fields);
}

async function authorizeCode(cookie: string, p = pkce(), redirectUri = APP_REDIRECT) {
  const r = await consent(cookie, { redirect_uri: redirectUri, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state });
  expect(r.status).toBe(303);
  const location = new URL(r.headers.location);
  return { ...p, code: location.searchParams.get('code') as string, location, response: r };
}

function exchange(code: string, verifier: string, redirectUri = APP_REDIRECT) {
  return request(app).post('/api/native-auth/token').send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri });
}
function nativeRefresh(refreshToken: string) {
  return request(app).post('/api/native-auth/refresh').send({ refresh_token: refreshToken });
}
function me(access: string) {
  return request(app).get('/api/me').set('Authorization', `Bearer ${access}`);
}

async function nativeSession(username: string) {
  const browser = await browserSession(username);
  const a = await authorizeCode(browser.cookie);
  const t = await exchange(a.code, a.verifier);
  expect(t.status).toBe(200);
  return { ...browser, access: t.body.access_token as string, refresh: t.body.refresh_token as string };
}

describe('normal sign-in: consent → code → token', () => {
  it('redirects to the exact app address with code and state, rotates the browser session, and never returns JSON', async () => {
    const browser = await browserSession('n_ok');
    const a = await authorizeCode(browser.cookie);
    expect({
      target: `${a.location.protocol}${a.location.pathname}`,
      state: a.location.searchParams.get('state'),
      codeShape: /^[A-Za-z0-9_-]{43}$/.test(a.code),
      noStore: a.response.headers['cache-control'],
      referrer: a.response.headers['referrer-policy'],
      browserRotated: refreshCookieOf(a.response) !== null && refreshCookieOf(a.response) !== browser.cookie,
      body: a.response.headers['content-type']?.includes('json') ?? false,
    }).toEqual({ target: APP_REDIRECT, state: a.state, codeShape: true, noStore: 'no-store', referrer: 'no-referrer', browserRotated: true, body: false });
  });

  it('exchanges the code for an access token and a rotating refresh token, without cookies', async () => {
    const browser = await browserSession('n_exchange');
    const a = await authorizeCode(browser.cookie);
    const t = await exchange(a.code, a.verifier);
    expect({
      status: t.status,
      type: t.body.token_type,
      expires: t.body.expires_in,
      refreshShape: /^[0-9a-f]{96}$/.test(t.body.refresh_token),
      user: String(t.body.user?._id ?? t.body.user?.id),
      passwordLeak: JSON.stringify(t.body).includes('password'),
      setCookie: setCookiesOf(t.headers).length,
      noStore: t.headers['cache-control'],
    }).toEqual({ status: 200, type: 'Bearer', expires: 900, refreshShape: true, user: browser.userId, passwordLeak: false, setCookie: 0, noStore: 'no-store' });
    expect((await me(t.body.access_token)).status).toBe(200);
  });

  it('the browser login and refresh responses still never carry a refresh token in JSON', async () => {
    const reg = await request(app).post('/api/register').send({ username: 'n_browser', password: PASSWORD });
    const login = await request(app).post('/api/login').send({ username: 'n_browser', password: PASSWORD });
    const refresh = await request(app).post('/api/refresh').set('Cookie', `bridge_refresh=${refreshCookieOf(login)}`);
    for (const r of [reg, login, refresh]) {
      expect(Object.keys(r.body).filter((k) => /refresh/i.test(k))).toEqual([]);
    }
  });
});

describe('2FA-required login', () => {
  it('a password-only step (202 challenge) yields no browser session, so no code can be issued', async () => {
    await browserSession('n_2fa');
    await _db.users.update({ username: 'n_2fa' }, { $set: { twoFactorEnabled: true } });
    const login = await request(app).post('/api/login').send({ username: 'n_2fa', password: PASSWORD });
    expect({ status: login.status, twoFactor: login.body.requiresTwoFactor, cookie: refreshCookieOf(login) }).toEqual({ status: 202, twoFactor: true, cookie: null });
    const p = pkce();
    const r = await consent(null, { redirect_uri: APP_REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state });
    expect({ status: r.status, location: r.headers.location }).toEqual({ status: 401, location: undefined });
  });
});

describe('PKCE and code rules', () => {
  it('an invalid verifier is refused and burns the code (the right verifier cannot use it afterwards)', async () => {
    const browser = await browserSession('n_badpkce');
    const a = await authorizeCode(browser.cookie);
    const wrong = await exchange(a.code, crypto.randomBytes(32).toString('base64url'));
    const right = await exchange(a.code, a.verifier);
    expect([wrong.status, wrong.body.error, right.status, right.body.error]).toEqual([400, 'invalid_grant', 400, 'invalid_grant']);
    expect(right.body.refresh_token).toBeUndefined();
  });

  it('a reused authorization code is refused AND revokes the session it produced', async () => {
    const browser = await browserSession('n_reuse');
    const a = await authorizeCode(browser.cookie);
    const first = await exchange(a.code, a.verifier);
    expect(first.status).toBe(200);
    const replay = await exchange(a.code, a.verifier);
    expect([replay.status, replay.body.error]).toEqual([400, 'invalid_grant']);
    const afterReplay = await nativeRefresh(first.body.refresh_token);
    expect([afterReplay.status, afterReplay.body.error]).toEqual([401, 'invalid_grant']);
  });

  it('the redirect address at exchange must equal the one consented to', async () => {
    const browser = await browserSession('n_redirmismatch');
    const a = await authorizeCode(browser.cookie);
    const r = await exchange(a.code, a.verifier, LINK_REDIRECT);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
  });

  it('a code older than 60 s is refused', async () => {
    const browser = await browserSession('n_expired_code');
    const a = await authorizeCode(browser.cookie);
    const realNow = Date.now;
    const later = realNow() + 61_000;
    Date.now = () => later;
    try {
      const r = await exchange(a.code, a.verifier);
      expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
    } finally { Date.now = realNow; }
  });

  it('only S256 is accepted; plain and malformed values are refused before any code exists', async () => {
    const browser = await browserSession('n_plain');
    const p = pkce();
    const cases = [
      { redirect_uri: APP_REDIRECT, code_challenge: p.verifier, code_challenge_method: 'plain', state: p.state },
      { redirect_uri: APP_REDIRECT, code_challenge: 'short', code_challenge_method: 'S256', state: p.state },
      { redirect_uri: APP_REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: 'x' },
    ];
    for (const fields of cases) {
      const r = await consent(browser.cookie, fields);
      expect({ status: r.status, location: r.headers.location }).toEqual({ status: 400, location: undefined });
    }
  });

  it('a logout-everywhere between consent and exchange invalidates the code', async () => {
    const browser = await browserSession('n_versioned');
    const a = await authorizeCode(browser.cookie);
    await request(app).post('/api/logout-all').set('Authorization', `Bearer ${browser.access}`).send({});
    const r = await exchange(a.code, a.verifier);
    expect([r.status, r.body.error]).toEqual([400, 'invalid_grant']);
  });
});

describe('open redirect and request-origin defences', () => {
  it.each([
    ['https://evil.example/oauth'],
    [`${APP_REDIRECT}/extra`],
    [`${APP_REDIRECT}?next=https://evil.example`],
    ['com.bridge.app:/OAUTH'],
    [''],
  ])('refuses redirect address %p without redirecting', async (redirectUri) => {
    const browser = await browserSession(`n_open_${crypto.randomBytes(3).toString('hex')}`);
    const p = pkce();
    const r = await consent(browser.cookie, { redirect_uri: redirectUri, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state });
    expect({ status: r.status, location: r.headers.location }).toEqual({ status: 400, location: undefined });
  });

  it('a signed-out or replayed browser session cannot authorize; a replay ends the browser session', async () => {
    const out = await browserSession('n_browser_out');
    await request(app).post('/api/refresh/logout').set('Cookie', `bridge_refresh=${out.cookie}`).send({});
    const p = pkce();
    const fields = { redirect_uri: APP_REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state };
    const afterLogout = await consent(out.cookie, fields);

    const stolen = await browserSession('n_browser_replay');
    const first = await authorizeCode(stolen.cookie);          // rotates the browser cookie
    const replay = await consent(stolen.cookie, fields);        // the pre-rotation cookie again
    const successor = await consent(refreshCookieOf(first.response), fields);
    expect([afterLogout.status, afterLogout.headers.location, replay.status, replay.headers.location, successor.status])
      .toEqual([401, undefined, 401, undefined, 401]);
  });

  it('refuses a cross-site or unidentified submission even with a valid cookie', async () => {
    const browser = await browserSession('n_csrf');
    const p = pkce();
    const fields = { redirect_uri: APP_REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state };
    const crossSite = await consent(browser.cookie, fields, { 'Sec-Fetch-Site': 'cross-site' });
    const sameSite = await consent(browser.cookie, fields, { 'Sec-Fetch-Site': 'same-site' });
    const wrongOrigin = await consent(browser.cookie, fields, { Origin: 'https://evil.example' });
    const noHeaders = await consent(browser.cookie, fields, {});
    const rightOrigin = await consent(browser.cookie, fields, { Origin: 'https://bridge.example' });
    expect([crossSite.status, sameSite.status, wrongOrigin.status, noHeaders.status, rightOrigin.status]).toEqual([403, 403, 403, 403, 303]);
  });

  it('configuration rejects unsafe redirect addresses and fails closed on any bad entry', () => {
    const load = (uris: string) => nativeAuthLib.loadNativeAuthConfig({ NATIVE_AUTH_REDIRECT_URIS: uris, BASE_URL: 'https://bridge.example' });
    expect({
      none: load('').enabled,
      http: load('http://links.bridge.example/oauth').enabled,
      sameOriginHttps: load('https://bridge.example/oauth').enabled,
      query: load('https://links.bridge.example/oauth?x=1').enabled,
      notReverseDomain: load('bridge:/oauth').enabled,
      oneBadEntry: load(`${APP_REDIRECT},javascript:alert(1)`).enabled,
      good: load(`${APP_REDIRECT},${LINK_REDIRECT}`).enabled,
    }).toEqual({ none: false, http: false, sameOriginHttps: false, query: false, notReverseDomain: false, oneBadEntry: false, good: true });
    // CSP form-action gains exactly the configured scheme/origin, nothing broader.
    expect(load(`${APP_REDIRECT},${LINK_REDIRECT}`).formActionSources).toEqual(['com.bridge.app:', 'https://links.bridge.example']);
  });

  it('when not configured, every native endpoint fails closed', async () => {
    const off = buildApp({ BASE_URL: 'https://bridge.example' });
    const browser = await browserSession('n_off');
    const p = pkce();
    const c = await request(off).post('/api/refresh/native-authorize').type('form').redirects(0)
      .set('Sec-Fetch-Site', 'same-origin').set('Cookie', `bridge_refresh=${browser.cookie}`)
      .send({ redirect_uri: APP_REDIRECT, code_challenge: p.challenge, code_challenge_method: 'S256', state: p.state });
    const t = await request(off).post('/api/native-auth/token').send({ grant_type: 'authorization_code', code: 'a'.repeat(43), code_verifier: p.verifier, redirect_uri: APP_REDIRECT });
    expect([c.status, c.headers.location, t.status]).toEqual([503, undefined, 503]);
  });
});

describe('native refresh lifecycle', () => {
  it('expired access token: refused by the API, recovered through refresh', async () => {
    const s = await nativeSession('n_expired_access');
    const claims = jwt.decode(s.access) as Record<string, unknown>;
    const expired = jwt.sign({ id: claims.id, username: claims.username, v: claims.v, exp: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET as string);
    expect((await me(expired)).status).toBe(401);
    const r = await nativeRefresh(s.refresh);
    expect(r.status).toBe(200);
    expect((await me(r.body.access_token)).status).toBe(200);
  });

  it('rotates: every refresh returns a new refresh token, in the body only', async () => {
    const s = await nativeSession('n_rotate');
    const r1 = await nativeRefresh(s.refresh);
    const r2 = await nativeRefresh(r1.body.refresh_token);
    expect({
      statuses: [r1.status, r2.status],
      distinct: new Set([s.refresh, r1.body.refresh_token, r2.body.refresh_token]).size,
      cookies: setCookiesOf(r1.headers).length + setCookiesOf(r2.headers).length,
      noStore: r1.headers['cache-control'],
    }).toEqual({ statuses: [200, 200], distinct: 3, cookies: 0, noStore: 'no-store' });
  });

  it('replayed refresh token (also: crash after server rotation): reuse detected, whole session revoked', async () => {
    const s = await nativeSession('n_replay');
    const rotated = await nativeRefresh(s.refresh);
    expect(rotated.status).toBe(200);
    // The client never persisted `rotated` (crash/lost response) and presents the old token.
    const replay = await nativeRefresh(s.refresh);
    expect([replay.status, replay.body.error, replay.body.reason]).toEqual([401, 'invalid_grant', 'reuse']);
    // Reuse detection is not weakened: the successor is dead too → reauthentication.
    const successor = await nativeRefresh(rotated.body.refresh_token);
    expect([successor.status, successor.body.error]).toEqual([401, 'invalid_grant']);
  });

  it('concurrent refresh with one token: exactly one wins, and the race is treated as reuse', async () => {
    const s = await nativeSession('n_concurrent');
    const results = await Promise.all([nativeRefresh(s.refresh), nativeRefresh(s.refresh)]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 401]);
    const winner = results.find((r) => r.status === 200) as request.Response;
    expect((await nativeRefresh(winner.body.refresh_token)).status).toBe(401);
  });

  it('a revoked refresh session (logout with body token) cannot refresh; browser cookie path untouched', async () => {
    const s = await nativeSession('n_logout');
    const out = await request(app).post('/api/refresh/logout').send({ refreshToken: s.refresh });
    expect(out.status).toBe(200);
    const r = await nativeRefresh(s.refresh);
    expect([r.status, r.body.error]).toEqual([401, 'invalid_grant']);
  });

  it('logout everywhere revokes native refresh sessions too', async () => {
    const s = await nativeSession('n_logoutall');
    await request(app).post('/api/logout-all').set('Authorization', `Bearer ${s.access}`).send({});
    expect((await nativeRefresh(s.refresh)).status).toBe(401);
  });

  it('native refresh never reads the browser cookie', async () => {
    const browser = await browserSession('n_cookie_only');
    const r = await request(app).post('/api/native-auth/refresh').set('Cookie', `bridge_refresh=${browser.cookie}`).send({});
    expect([r.status, r.body.error]).toEqual([400, 'invalid_request']);
  });
});

describe('cross-account isolation', () => {
  it('a code is bound to its account and verifier; each session resolves only to its own user', async () => {
    const a = await browserSession('n_iso_a');
    const b = await browserSession('n_iso_b');
    const codeA = await authorizeCode(a.cookie);
    const codeB = await authorizeCode(b.cookie);
    const crossed = await exchange(codeA.code, codeB.verifier);
    expect([crossed.status, crossed.body.error]).toEqual([400, 'invalid_grant']);
    const tB = await exchange(codeB.code, codeB.verifier);
    const meB = await me(tB.body.access_token);
    const refreshedB = await nativeRefresh(tB.body.refresh_token);
    const meB2 = await me(refreshedB.body.access_token);
    const idOf = (r: request.Response) => String(r.body?.user?._id ?? r.body?._id ?? r.body?.id);
    expect([idOf(meB), idOf(meB2)]).toEqual([b.userId, b.userId]);
    expect(idOf(meB)).not.toBe(a.userId);
  });
});
