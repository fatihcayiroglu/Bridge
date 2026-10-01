// server/tests/p4-session-push-revocation.test.ts
//
// P4 — PUSH DELIVERY ENDS WITH THE SESSION.
//
// MEASURED DEFECT: push targets (native device tokens, Web Push subscriptions) were not tied to any
// session and nothing removed them on logout, logout-all or password change. A signed-out phone —
// or a lost one after "log out everywhere" — kept showing the account's DM and mention previews.
//
// Each test below would fail on the pre-P4 routes (rows survive); they are the negative control.

import { setCookiesOf } from './helpers/httpDoubles';
import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

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
const { router } = require('../routes/auth');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const mobilePush = require('../routes/mobilePush');

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api', router);
  app.use('/api/mobile', mobilePush);
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: err.message }));
  return app;
}

const app = buildApp();
beforeEach(() => { _db._reset?.(); });

const PASSWORD = 'p4Password123';

async function signUp(username: string) {
  const r = await request(app).post('/api/register').send({ username, password: PASSWORD });
  const cookie = setCookiesOf(r.headers).find((c) => c.startsWith('bridge_refresh='));
  return { token: r.body.token as string, userId: (r.body.user?._id ?? r.body.user?.id) as string, cookie: cookie?.split(';')[0] ?? '' };
}

async function seedTargets(userId: string, tag: string) {
  await _db.nativePushTokens.insert({ _id: `npt_${tag}_a`, userId, platform: 'android', token: `${tag}-phone`, createdAt: 1, updatedAt: 1 });
  await _db.nativePushTokens.insert({ _id: `npt_${tag}_b`, userId, platform: 'ios', token: `${tag}-tablet`, createdAt: 1, updatedAt: 1 });
  await _db.pushSubscriptions.insert({ _id: `ps_${tag}_1`, userId, endpoint: `https://push.example/${tag}-laptop`, keys: {}, createdAt: 1 });
  await _db.pushSubscriptions.insert({ _id: `ps_${tag}_2`, userId, endpoint: `https://push.example/${tag}-desktop`, keys: {}, createdAt: 1 });
}
const nativeOf = async (userId: string) => ((await _db.nativePushTokens.find({ userId })) as Array<{ token: string }>).map((r) => r.token).sort();
const webOf = async (userId: string) => ((await _db.pushSubscriptions.find({ userId })) as Array<{ endpoint: string }>).map((r) => r.endpoint).sort();

describe('logout ends push delivery for the signing-out installation only', () => {
  it('removes the named native token and web endpoint of the session owner; other devices keep theirs', async () => {
    const me = await signUp('p4_lo_me');
    await seedTargets(me.userId, 'me');

    const r = await request(app).post('/api/refresh/logout').set('Cookie', me.cookie)
      .send({ push: { nativeToken: 'me-phone', webEndpoint: 'https://push.example/me-laptop' } });

    expect(r.status).toBe(200);
    expect(await nativeOf(me.userId)).toEqual(['me-tablet']);
    expect(await webOf(me.userId)).toEqual(['https://push.example/me-desktop']);
  });

  it('cannot remove ANOTHER account\'s targets by naming them', async () => {
    const me = await signUp('p4_lo_me2');
    const other = await signUp('p4_lo_other');
    await seedTargets(other.userId, 'other');

    await request(app).post('/api/refresh/logout').set('Cookie', me.cookie)
      .send({ push: { nativeToken: 'other-phone', webEndpoint: 'https://push.example/other-laptop' } });

    expect(await nativeOf(other.userId)).toEqual(['other-phone', 'other-tablet']);
    expect(await webOf(other.userId)).toHaveLength(2);
  });

  it('without a refresh session nothing is removed (no owner is trusted from the body)', async () => {
    const other = await signUp('p4_lo_nosession');
    await seedTargets(other.userId, 'ns');
    const r = await request(app).post('/api/refresh/logout').send({ push: { nativeToken: 'ns-phone' } });
    expect(r.status).toBe(200);
    expect(await nativeOf(other.userId)).toEqual(['ns-phone', 'ns-tablet']);
  });

  it('the refresh session itself is revoked', async () => {
    const me = await signUp('p4_lo_refresh');
    await request(app).post('/api/refresh/logout').set('Cookie', me.cookie).send({});
    const refreshed = await request(app).post('/api/refresh').set('Cookie', me.cookie).send({});
    expect(refreshed.status).toBe(401);
  });

  it('oversized identifiers are ignored, not stored or matched', async () => {
    const me = await signUp('p4_lo_big');
    await seedTargets(me.userId, 'big');
    const r = await request(app).post('/api/refresh/logout').set('Cookie', me.cookie)
      .send({ push: { nativeToken: 'x'.repeat(5000), webEndpoint: 42 } });
    expect(r.status).toBe(200);
    expect(await nativeOf(me.userId)).toHaveLength(2);
  });
});

describe('logout-all and password change end push delivery on every device', () => {
  it('logout-all removes every native token and web subscription of the account', async () => {
    const me = await signUp('p4_la_me');
    const other = await signUp('p4_la_other');
    await seedTargets(me.userId, 'la');
    await seedTargets(other.userId, 'keep');

    const r = await request(app).post('/api/logout-all').set('Authorization', `Bearer ${me.token}`).send({});
    expect(r.status).toBe(200);
    expect(await nativeOf(me.userId)).toEqual([]);
    expect(await webOf(me.userId)).toEqual([]);
    expect(await nativeOf(other.userId)).toHaveLength(2);
    expect(await webOf(other.userId)).toHaveLength(2);
  });

  it('password change removes every push target (other sessions were revoked with it)', async () => {
    const me = await signUp('p4_cp_me');
    await seedTargets(me.userId, 'cp');
    const r = await request(app).post('/api/change-password').set('Authorization', `Bearer ${me.token}`)
      .send({ currentPassword: PASSWORD, newPassword: 'p4NewPassword456' });
    expect(r.status).toBe(200);
    expect(await nativeOf(me.userId)).toEqual([]);
    expect(await webOf(me.userId)).toEqual([]);
  });
});

describe('native token ownership (P4-04) and per-installation unregister', () => {
  it('a device token registered by a second account moves to it; the first account stops receiving', async () => {
    const first = await signUp('p4_own_first');
    const second = await signUp('p4_own_second');
    const a = await request(app).post('/api/mobile/push/register-native').set('Authorization', `Bearer ${first.token}`).send({ token: 'shared-phone', platform: 'android' });
    const b = await request(app).post('/api/mobile/push/register-native').set('Authorization', `Bearer ${second.token}`).send({ token: 'shared-phone', platform: 'android' });
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await nativeOf(first.userId)).toEqual([]);
    expect(await nativeOf(second.userId)).toEqual(['shared-phone']);
  });

  it('one account keeps several installations (phone + tablet on the same platform)', async () => {
    const me = await signUp('p4_multi');
    await request(app).post('/api/mobile/push/register-native').set('Authorization', `Bearer ${me.token}`).send({ token: 'phone', platform: 'android' });
    await request(app).post('/api/mobile/push/register-native').set('Authorization', `Bearer ${me.token}`).send({ token: 'tablet', platform: 'android' });
    expect(await nativeOf(me.userId)).toEqual(['phone', 'tablet']);
  });

  it('re-registering the same token does not duplicate it', async () => {
    const me = await signUp('p4_dup');
    for (let i = 0; i < 3; i++) {
      await request(app).post('/api/mobile/push/register-native').set('Authorization', `Bearer ${me.token}`).send({ token: 'phone', platform: 'android' });
    }
    expect(await nativeOf(me.userId)).toEqual(['phone']);
  });

  it('the number of installations per account is bounded', async () => {
    const me = await signUp('p4_cap');
    for (let i = 0; i < 13; i++) {
      await request(app).post('/api/mobile/push/register-native').set('Authorization', `Bearer ${me.token}`).send({ token: `device-${String(i).padStart(2, '0')}`, platform: 'android' });
    }
    const tokens = await nativeOf(me.userId);
    expect(tokens).toHaveLength(10);
    expect(tokens).toContain('device-12');
  });

  it('unregister with a token removes only that installation of the caller', async () => {
    const me = await signUp('p4_unreg');
    const other = await signUp('p4_unreg_other');
    await seedTargets(me.userId, 'un');
    await seedTargets(other.userId, 'uo');
    const r = await request(app).delete('/api/mobile/push/unregister').set('Authorization', `Bearer ${me.token}`).send({ token: 'un-phone' });
    const cross = await request(app).delete('/api/mobile/push/unregister').set('Authorization', `Bearer ${me.token}`).send({ token: 'uo-phone' });
    expect([r.status, cross.status]).toEqual([200, 200]);
    expect(await nativeOf(me.userId)).toEqual(['un-tablet']);
    expect(await nativeOf(other.userId)).toEqual(['uo-phone', 'uo-tablet']);
  });
});
