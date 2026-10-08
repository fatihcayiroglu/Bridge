// server/tests/p7-step-up-proofs.test.ts
//
// P7 B2 — obtaining a step-up grant: the password proof (POST /api/step-up/password,
// level 1), the TOTP / backup-code proof (POST /api/2fa/step-up, level 2, with the
// existing replay protection) and the grants every sign-in returns. The per-route
// limiter itself is measured in p7-step-up-proof-limits.test.ts; here it is raised so
// the semantics can be exercised (the production default is untouched).

process.env.RL_2FA_MAX = '1000';

import express from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

const request = require('supertest');
import db from '../db/loader';
import { Users } from '../db/repositories';
import stepUpRouter from '../routes/stepUp';
import twoFactorRouter, {
  __hashBackupCodeForTest as hashBackupCode,
  __totpNowForTest as totpNow,
} from '../routes/twoFactor';
import { issueTwoFactorLoginChallenge } from '../lib/twoFactorLoginChallenge';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';
import * as stepUp from '../lib/stepUp';
import { STEP_UP_SCOPES, checkStepUpGrant } from '../lib/stepUp';

const SECRET = 'JBSWY3DPEHPK3PXP';
const BACKUP = 'a1b2c3d4e5f60718';
let PASSWORD_HASH = '';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/step-up', stepUpRouter);
  app.use('/api/2fa', twoFactorRouter);
  return app;
}
const tok = (uid: string, v = 0) => jwt.sign({ id: uid, v }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

type Row = Record<string, unknown>;
async function makeUser(extra: Row = {}): Promise<{ id: string; token: string }> {
  const id = uuidv4();
  await (db as unknown as { users: { insert(d: Row): Promise<unknown> } }).users.insert({
    _id: id, username: `u-${id.slice(0, 8)}`, tokenVersion: 0, password: PASSWORD_HASH, twoFactorEnabled: false, ...extra,
  });
  return { id, token: tok(id) };
}
const with2fa = (): Row => ({ twoFactorEnabled: true, twoFactorSecret: SECRET, twoFactorBackup: JSON.stringify([hashBackupCode(BACKUP)]) });
const factors = (twoFactor: boolean) => ({ password: true, twoFactor, tokenVersion: 0 });
const currentTotp = () => totpNow(SECRET)[1]!;

let app: ReturnType<typeof buildApp>;
beforeAll(async () => { PASSWORD_HASH = await bcrypt.hash('correct horse', 4); delete process.env.REDIS_URL; });
beforeEach(() => {
  _resetRateLimitStoreForTest();
  (db as unknown as { _reset?: () => void })._reset?.();
  app = buildApp();
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/step-up/password (level 1)', () => {
  it('needs a session', async () => {
    await request(app).post('/api/step-up/password').send({ password: 'correct horse', scope: 'account-security' }).expect(401);
  });

  it('validates scope and password before touching the credential', async () => {
    const u = await makeUser();
    for (const body of [{ password: 'correct horse' }, { password: 'correct horse', scope: '*' }, { password: 'x', scope: 42 }]) {
      const r = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`).send(body);
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('scope required');
    }
    for (const path of ['/api/step-up/password', '/api/2fa/step-up']) {
      const noBody = await request(app).post(path).set('Authorization', `Bearer ${u.token}`);
      expect(noBody.status).toBe(400);
      expect(noBody.body.error).toBe('scope required');
    }
    for (const password of ['', 7, 'x'.repeat(129), null]) {
      const r = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`).send({ password, scope: 'account-security' });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('password required');
    }
  });

  it('a correct password yields a grant for exactly the requested scope', async () => {
    const u = await makeUser();
    const r = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`)
      .send({ password: 'correct horse', scope: 'sensitive-export' }).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ ok: true, stepUp: expect.objectContaining({ scope: 'sensitive-export', level: 1, method: 'password', ttlMs: 600_000 }) });
    for (const scope of STEP_UP_SCOPES) {
      expect(checkStepUpGrant(r.body.stepUp.token, u.id, factors(false), scope).ok).toBe(scope === 'sensitive-export');
    }
    // Another account cannot use it.
    expect(checkStepUpGrant(r.body.stepUp.token, uuidv4(), factors(false), 'sensitive-export')).toEqual({ ok: false, reason: 'step_up_other_account' });
  });

  it('is refused for an account with 2FA (a password is not its sign-in strength) and for SSO-only accounts', async () => {
    const twoFa = await makeUser(with2fa());
    const r1 = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${twoFa.token}`)
      .send({ password: 'correct horse', scope: 'account-security' }).expect(400);
    expect(r1.body).toEqual({ error: 'STEP_UP_SECOND_FACTOR_REQUIRED', methods: ['totp', 'backup_code', 'sign_in'] });
    const sso = await makeUser({ password: '' });
    const r2 = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${sso.token}`)
      .send({ password: 'anything', scope: 'destructive-admin' }).expect(400);
    expect(r2.body).toEqual({ error: 'STEP_UP_NO_PASSWORD', methods: ['sign_in'] });
  });

  it('a vanished account is 404', async () => {
    const ghost = uuidv4();
    // authMiddleware resolves the user first; an account deleted between the two reads reaches the route.
    jest.spyOn(Users, 'findById')
      .mockResolvedValueOnce({ _id: ghost, tokenVersion: 0 } as never)
      .mockResolvedValueOnce(null as never);
    await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${tok(ghost)}`)
      .send({ password: 'x', scope: 'account-security' }).expect(404);
  });

  it('wrong passwords count toward the per-account lock; once locked even the right password is refused', async () => {
    const u = await makeUser();
    for (let i = 1; i <= 5; i++) {
      const r = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`)
        .send({ password: `wrong-${i}`, scope: 'account-security' }).expect(400);
      expect(r.body).toEqual({ error: 'STEP_UP_PROOF_INVALID', locked: i === 5 });
    }
    const locked = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`)
      .send({ password: 'correct horse', scope: 'account-security' }).expect(429);
    expect(locked.body).toEqual({ error: 'STEP_UP_LOCKED', retryAfterMs: 900_000, methods: ['sign_in'] });
    // Another account is not affected.
    const other = await makeUser();
    await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${other.token}`)
      .send({ password: 'correct horse', scope: 'account-security' }).expect(200);
  });

  it('fails closed (503) when the failed-proof counter cannot be read or written', async () => {
    const u = await makeUser();
    jest.spyOn(stepUp, 'stepUpProofsLocked').mockRejectedValueOnce(new Error('counter offline'));
    await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`)
      .send({ password: 'correct horse', scope: 'account-security' }).expect(503);
    jest.spyOn(stepUp, 'recordFailedStepUpProof').mockRejectedValueOnce('counter offline');
    const r = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`)
      .send({ password: 'wrong', scope: 'account-security' }).expect(503);
    expect(r.body).toEqual({ error: 'STEP_UP_UNAVAILABLE' });
  });
});

describe('POST /api/2fa/step-up (level 2)', () => {
  const post = (token: string, body: Row) => request(app).post('/api/2fa/step-up').set('Authorization', `Bearer ${token}`).send(body);

  it('validates scope and code, and needs 2FA to be enabled', async () => {
    const u = await makeUser(with2fa());
    expect((await post(u.token, { code: '123456' })).body.error).toBe('scope required');
    for (const code of ['', 5, 'x'.repeat(129)]) {
      expect((await post(u.token, { code, scope: 'account-security' })).body.error).toBe('code required');
    }
    const plain = await makeUser();
    expect((await post(plain.token, { code: '123456', scope: 'account-security' })).body.error).toBe('2FA not enabled');
  });

  it('a current TOTP code yields a level-2 grant for that scope, and the same code cannot be replayed', async () => {
    const u = await makeUser(with2fa());
    const code = currentTotp();
    const r = await post(u.token, { code: ` ${code.slice(0, 3)} ${code.slice(3)} `, scope: 'destructive-admin' }).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toEqual({ ok: true, stepUp: expect.objectContaining({ scope: 'destructive-admin', level: 2, method: 'totp' }) });
    expect(checkStepUpGrant(r.body.stepUp.token, u.id, factors(true), 'destructive-admin').ok).toBe(true);
    expect(checkStepUpGrant(r.body.stepUp.token, u.id, factors(true), 'account-security')).toEqual({ ok: false, reason: 'step_up_scope_mismatch' });
    const replay = await post(u.token, { code, scope: 'destructive-admin' }).expect(400);
    expect(replay.body).toEqual({ error: 'STEP_UP_PROOF_INVALID', locked: false });
  });

  it('a backup code works once and reports how many remain', async () => {
    const u = await makeUser(with2fa());
    const r = await post(u.token, { code: BACKUP, scope: 'account-security' }).expect(200);
    expect(r.body).toEqual({ ok: true, usedBackup: true, remaining: 0, stepUp: expect.objectContaining({ level: 2, method: 'backup_code', scope: 'account-security' }) });
    expect((await post(u.token, { code: BACKUP, scope: 'account-security' })).body).toEqual({ error: 'STEP_UP_PROOF_INVALID', locked: false });
  });

  it('an account whose stored secret is missing can still use a backup code', async () => {
    const u = await makeUser({ ...with2fa(), twoFactorSecret: null });
    await post(u.token, { code: BACKUP, scope: 'moderation-burst' }).expect(200);
  });

  it('wrong codes lock step-up proofs (not sign-in) after five failures', async () => {
    const u = await makeUser(with2fa());
    for (let i = 1; i <= 5; i++) {
      expect((await post(u.token, { code: '000000', scope: 'account-security' })).body).toEqual({ error: 'STEP_UP_PROOF_INVALID', locked: i === 5 });
    }
    const locked = await post(u.token, { code: currentTotp(), scope: 'account-security' }).expect(429);
    expect(locked.body.error).toBe('STEP_UP_LOCKED');
    // Sign-in with the second factor still works and returns fresh grants.
    const tempToken = await issueTwoFactorLoginChallenge(u.id, 0);
    const signIn = await request(app).post('/api/2fa/check').send({ tempToken, code: currentTotp() }).expect(200);
    expect(signIn.body.stepUp).toEqual(expect.objectContaining({ level: 2, method: 'totp' }));
    expect(checkStepUpGrant(signIn.body.stepUp.grants['account-security'], u.id, factors(true), 'account-security').ok).toBe(true);
  });

  it('fails closed (503) when the counter or the second-factor store is unavailable', async () => {
    const u = await makeUser(with2fa());
    jest.spyOn(stepUp, 'stepUpProofsLocked').mockRejectedValueOnce(new Error('counter offline'));
    await post(u.token, { code: currentTotp(), scope: 'account-security' }).expect(503);
    jest.spyOn(stepUp, 'recordFailedStepUpProof').mockRejectedValueOnce('counter offline');
    expect((await post(u.token, { code: '000000', scope: 'account-security' }).expect(503)).body).toEqual({ error: 'STEP_UP_UNAVAILABLE' });
  });
});

describe('post-revocation: a security change ends every earlier grant', () => {
  it('enabling 2FA rotates the session — the grant used to enable it no longer works, even with the new token', async () => {
    const u = await makeUser();
    const proof = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${u.token}`)
      .send({ password: 'correct horse', scope: 'account-security' }).expect(200);
    const grant = { 'x-bridge-step-up': proof.body.stepUp.token as string };
    const setup = await request(app).post('/api/2fa/setup').set('Authorization', `Bearer ${u.token}`).set(grant).expect(200);
    const code = totpNow(setup.body.secret)[1]!;
    const verify = await request(app).post('/api/2fa/verify').set('Authorization', `Bearer ${u.token}`).set(grant).send({ code }).expect(200);
    const newToken = verify.body.token as string;
    expect(newToken).toBeTruthy();
    // The old access token is revoked…
    await request(app).post('/api/2fa/backup-codes/regenerate').set('Authorization', `Bearer ${u.token}`).set(grant).send({ password: 'correct horse' }).expect(401);
    // …and so is the old grant, even beside the new token (and it was only level 1 anyway).
    const r = await request(app).post('/api/2fa/backup-codes/regenerate').set('Authorization', `Bearer ${newToken}`).set(grant).send({ password: 'correct horse' });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: 'STEP_UP_REQUIRED', reasons: ['step_up_revoked'], level: 2 });
  });
});

describe('sign-in responses carry one grant per scope', () => {
  it('2FA sign-in with a backup code returns level-2 backup_code grants', async () => {
    const u = await makeUser(with2fa());
    const tempToken = await issueTwoFactorLoginChallenge(u.id, 0);
    const r = await request(app).post('/api/2fa/check').send({ tempToken, code: BACKUP }).expect(200);
    expect(r.body.stepUp).toEqual(expect.objectContaining({ level: 2, method: 'backup_code', ttlMs: 600_000 }));
    expect(Object.keys(r.body.stepUp.grants).sort()).toEqual([...STEP_UP_SCOPES].sort());
    for (const scope of STEP_UP_SCOPES) {
      expect(checkStepUpGrant(r.body.stepUp.grants[scope], u.id, factors(true), scope).ok).toBe(true);
    }
  });
});
