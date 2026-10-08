// server/tests/p7-step-up-core.test.ts
//
// P7 B2 — the step-up owner (lib/stepUp.ts): grant signing and verification,
// scope / level / account / revocation checks, the failed-proof lock and the
// guard's refusal contract. Runs on the single-node counters (no Redis); the
// cluster path is exercised by scripts/stepup-lab on two nodes.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';

const findById = jest.fn();
jest.mock('../db/repositories', () => ({ Users: { findById: (...a: unknown[]) => findById(...a) } }));

import {
  STEP_UP_ACTIONS,
  STEP_UP_HEADER,
  STEP_UP_POLICY,
  STEP_UP_SCOPES,
  accountFactors,
  availableOptions,
  checkStepUpGrant,
  evaluateStepUp,
  factorsOf,
  hasUsablePassword,
  isStepUpScope,
  methodLevel,
  mintSignInGrants,
  mintStepUpGrant,
  recordFailedStepUpProof,
  requireStepUp,
  requiredLevel,
  scopeEnforced,
  stepUpProofsLocked,
  type AccountFactors,
  type StepUpAction,
} from '../lib/stepUp';
import { makeToken, verifyToken } from '../middleware/auth';
import * as socketRateLimit from '../socket/socketRateLimit';

const T0 = 1_800_000_000_000;
const BCRYPT = '$2b$12$abcdefghijklmnopqrstuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuuu';
let seq = 0;
const uid = () => `stepup-user-${++seq}`;

const plain: AccountFactors = { password: true, twoFactor: false, tokenVersion: 0 };
const twoFa: AccountFactors = { password: true, twoFactor: true, tokenVersion: 0 };

function derivedKey(secret = process.env.JWT_SECRET as string): Buffer {
  return crypto.createHmac('sha256', secret).update('bridge-step-up-grant-v1').digest();
}

function forge(payload: Record<string, unknown>, key: Buffer | string = derivedKey(), audience = 'bridge-step-up'): string {
  return jwt.sign(payload, key, { algorithm: 'HS256', expiresIn: 600, audience });
}

function req(grant?: string | string[]): Request {
  return { headers: grant === undefined ? {} : { [STEP_UP_HEADER]: grant } } as unknown as Request;
}

function res() {
  const r = { statusCode: 0, body: undefined as unknown, status: jest.fn(), json: jest.fn() };
  r.status.mockImplementation((code: number) => { r.statusCode = code; return r; });
  r.json.mockImplementation((body: unknown) => { r.body = body; return r; });
  return r;
}

beforeAll(() => { delete process.env.REDIS_URL; });
beforeEach(() => {
  findById.mockReset();
  delete process.env.STEP_UP_SECRET;
  delete process.env.STEP_UP_DISABLED_SCOPES;
});

describe('P7 B2 policy and catalog', () => {
  it('uses the approved defaults: 10 min grants, 5 destructive moderation actions per 60 s, 5 failed proofs per 15 min', () => {
    expect(STEP_UP_POLICY.ttlMs).toBe(600_000);
    expect(STEP_UP_POLICY.moderationBurst).toEqual({ max: 5, windowMs: 60_000 });
    expect(STEP_UP_POLICY.failedProof).toEqual({ max: 5, windowMs: 900_000 });
  });

  it('every protected action belongs to exactly one scope and explains itself', () => {
    for (const [action, spec] of Object.entries(STEP_UP_ACTIONS)) {
      expect(isStepUpScope(spec.scope)).toBe(true);
      expect(spec.why.length).toBeGreaterThan(20);
      expect(spec.when === 'burst').toBe(spec.scope === 'moderation-burst');
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
    }
    // Invite creation is deliberately not a step-up action in this implementation (deferred).
    expect(Object.keys(STEP_UP_ACTIONS).some((a) => a.includes('invite'))).toBe(false);
    expect(isStepUpScope('*')).toBe(false);
    expect(isStepUpScope(42)).toBe(false);
  });

  it('levels follow how the credential was proven; plain SSO is never level 2', () => {
    expect(methodLevel('password')).toBe(1);
    expect(methodLevel('sso')).toBe(1);
    expect(methodLevel('totp')).toBe(2);
    expect(methodLevel('backup_code')).toBe(2);
    expect(methodLevel('passkey')).toBe(2);
  });

  it('reads account factors from the account itself and offers only what the account has', () => {
    expect(hasUsablePassword(BCRYPT)).toBe(true);
    expect(hasUsablePassword('')).toBe(false);
    expect(hasUsablePassword(null)).toBe(false);
    expect(factorsOf({ password: BCRYPT, twoFactorEnabled: 1, tokenVersion: '3' })).toEqual({ password: true, twoFactor: true, tokenVersion: 3 });
    expect(factorsOf({ password: '', twoFactorEnabled: false })).toEqual({ password: false, twoFactor: false, tokenVersion: 0 });
    for (const flag of [true, 1, '1', 't', 'true']) expect(factorsOf({ twoFactorEnabled: flag }).twoFactor).toBe(true);
    for (const flag of [false, 0, '0', 'f', null, undefined]) expect(factorsOf({ twoFactorEnabled: flag }).twoFactor).toBe(false);
    expect(() => factorsOf({ tokenVersion: 'corrupt' })).toThrow(TypeError);

    expect(requiredLevel(plain)).toBe(1);
    expect(requiredLevel(twoFa)).toBe(2);
    expect(availableOptions(plain)).toEqual(['password', 'sign_in']);
    expect(availableOptions(twoFa)).toEqual(['totp', 'backup_code', 'sign_in']);
    expect(availableOptions({ password: false, twoFactor: false, tokenVersion: 0 })).toEqual(['sign_in']);
    expect(availableOptions(twoFa, true)).toEqual(['sign_in']);
  });

  it('accountFactors returns null for a vanished account', async () => {
    findById.mockResolvedValueOnce(null);
    await expect(accountFactors('gone')).resolves.toBeNull();
    findById.mockResolvedValueOnce({ password: BCRYPT, twoFactorEnabled: 0, tokenVersion: 2 });
    await expect(accountFactors('here')).resolves.toEqual({ password: true, twoFactor: false, tokenVersion: 2 });
  });

  it('the operator rollback switch disables only the listed scopes', () => {
    expect(scopeEnforced('account-security')).toBe(true);
    process.env.STEP_UP_DISABLED_SCOPES = ' moderation-burst , sensitive-export';
    expect(scopeEnforced('moderation-burst')).toBe(false);
    expect(scopeEnforced('sensitive-export')).toBe(false);
    expect(scopeEnforced('account-security')).toBe(true);
  });
});

describe('P7 B2 grant signing and verification', () => {
  it('a grant carries { sub, v, level, method, scope, typ, iat, exp } and verifies for its own scope', () => {
    const g = mintStepUpGrant({ _id: 'u1', tokenVersion: 4 }, 'password', 'account-security', T0);
    expect(g).toMatchObject({ scope: 'account-security', level: 1, method: 'password', ttlMs: 600_000, expiresAt: T0 + 600_000 });
    const decoded = jwt.decode(g.token) as Record<string, unknown>;
    expect(decoded).toMatchObject({ sub: 'u1', v: 4, level: 1, method: 'password', scope: 'account-security', typ: 'stepup', aud: 'bridge-step-up' });
    expect(decoded.exp).toBe((decoded.iat as number) + 600);
    expect(Object.keys(decoded).sort()).toEqual(['aud', 'exp', 'iat', 'level', 'method', 'scope', 'sub', 'typ', 'v']);

    const ok = checkStepUpGrant(g.token, 'u1', { ...plain, tokenVersion: 4 }, 'account-security', T0 + 1_000);
    expect(ok).toEqual({ ok: true, claims: expect.objectContaining({ sub: 'u1', scope: 'account-security' }) });
  });

  it('a proof for one scope never authorises another scope', () => {
    for (const scope of STEP_UP_SCOPES) {
      const g = mintStepUpGrant({ _id: 'u1' }, 'totp', scope, T0);
      for (const other of STEP_UP_SCOPES) {
        const r = checkStepUpGrant(g.token, 'u1', twoFa, other, T0);
        expect(r.ok).toBe(other === scope);
        if (other !== scope) expect(r).toEqual({ ok: false, reason: 'step_up_scope_mismatch' });
      }
    }
  });

  it('a sign-in yields one single-scope grant per scope, at the method’s level', () => {
    const s = mintSignInGrants({ _id: 'u2', tokenVersion: 1 }, 'passkey', T0);
    expect(s).toMatchObject({ level: 2, method: 'passkey', ttlMs: 600_000, expiresAt: T0 + 600_000 });
    expect(Object.keys(s.grants).sort()).toEqual([...STEP_UP_SCOPES].sort());
    for (const scope of STEP_UP_SCOPES) {
      expect((jwt.decode(s.grants[scope]) as { scope: string }).scope).toBe(scope);
      expect(checkStepUpGrant(s.grants[scope], 'u2', { ...twoFa, tokenVersion: 1 }, scope, T0).ok).toBe(true);
    }
    expect(mintSignInGrants({ _id: 'u2' }, 'sso', T0).level).toBe(1);
    const live = mintSignInGrants({ _id: 'u2' }, 'password');
    expect(live.expiresAt).toBeGreaterThan(Date.now());
    expect(checkStepUpGrant(live.grants['destructive-admin'], 'u2', plain, 'destructive-admin').ok).toBe(true);
  });

  it('refuses a missing, oversized, expired, foreign, revoked or under-levelled grant with a named reason', () => {
    const g = mintStepUpGrant({ _id: 'u3', tokenVersion: 0 }, 'password', 'destructive-admin', T0).token;
    expect(checkStepUpGrant(undefined, 'u3', plain, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_missing' });
    expect(checkStepUpGrant('', 'u3', plain, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_missing' });
    expect(checkStepUpGrant(['x'], 'u3', plain, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_missing' });
    expect(checkStepUpGrant('a'.repeat(2049), 'u3', plain, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_invalid' });
    expect(checkStepUpGrant('not.a.jwt', 'u3', plain, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_invalid' });
    expect(checkStepUpGrant(g, 'u3', plain, 'destructive-admin', T0 + 601_000)).toEqual({ ok: false, reason: 'step_up_expired' });
    expect(checkStepUpGrant(g, 'someone-else', plain, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_other_account' });
    expect(checkStepUpGrant(g, 'u3', { ...plain, tokenVersion: 1 }, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_revoked' });
    // A password proof does not satisfy an account that has a second factor.
    expect(checkStepUpGrant(g, 'u3', twoFa, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_level' });
    const sso = mintStepUpGrant({ _id: 'u3' }, 'sso', 'destructive-admin', T0).token;
    expect(checkStepUpGrant(sso, 'u3', twoFa, 'destructive-admin', T0)).toEqual({ ok: false, reason: 'step_up_level' });
    expect(checkStepUpGrant(sso, 'u3', { password: false, twoFactor: false, tokenVersion: 0 }, 'destructive-admin', T0).ok).toBe(true);
  });

  it('an access token never verifies as a grant, and a grant never verifies as an access token', () => {
    const access = makeToken({ _id: 'u4', username: 'u4', tokenVersion: 0 });
    expect(checkStepUpGrant(access, 'u4', plain, 'account-security', Date.now())).toEqual({ ok: false, reason: 'step_up_invalid' });
    const grant = mintStepUpGrant({ _id: 'u4' }, 'password', 'account-security').token;
    expect(verifyToken(grant)).toBeNull();
    // Even signed with the raw JWT secret and the right shape, the audience/key separation holds.
    const rawSigned = forge({ sub: 'u4', v: 0, level: 1, method: 'password', scope: 'account-security', typ: 'stepup' }, process.env.JWT_SECRET as string);
    expect(checkStepUpGrant(rawSigned, 'u4', plain, 'account-security', Date.now())).toEqual({ ok: false, reason: 'step_up_invalid' });
  });

  it('STEP_UP_SECRET is domain-separated too, and replaces the JWT_SECRET derivation', () => {
    const before = mintStepUpGrant({ _id: 'u5' }, 'password', 'account-security').token;
    process.env.STEP_UP_SECRET = process.env.JWT_SECRET; // even a careless equal value never yields the access key
    const sameSecret = mintStepUpGrant({ _id: 'u5' }, 'password', 'account-security').token;
    expect(verifyToken(sameSecret)).toBeNull();
    process.env.STEP_UP_SECRET = 'a-dedicated-step-up-secret-of-sufficient-length-0123456789';
    expect(checkStepUpGrant(before, 'u5', plain, 'account-security').ok).toBe(false);
    const dedicated = mintStepUpGrant({ _id: 'u5' }, 'password', 'account-security').token;
    expect(checkStepUpGrant(dedicated, 'u5', plain, 'account-security').ok).toBe(true);
    expect(jwt.verify(dedicated, derivedKey('a-dedicated-step-up-secret-of-sufficient-length-0123456789'))).toBeTruthy();
  });

  it('refuses tokens with the right key but the wrong shape', () => {
    const base = { sub: 'u6', v: 0, level: 1, method: 'password', scope: 'account-security', typ: 'stepup' };
    const bad: Array<Record<string, unknown>> = [
      { ...base, typ: 'access' },
      { ...base, sub: '' },
      { ...base, sub: 7 },
      { ...base, v: -1 },
      { ...base, v: 1.5 },
      { ...base, level: 3 },
      { ...base, method: 'magic' },
      { ...base, scope: '*' },
      { ...base, level: 2, method: 'password' }, // a level the method cannot prove
      { ...base, level: 2, method: 'sso' },
    ];
    for (const payload of bad) {
      expect(checkStepUpGrant(forge(payload), 'u6', plain, 'account-security')).toEqual({ ok: false, reason: 'step_up_invalid' });
    }
    expect(checkStepUpGrant(forge(base, derivedKey(), 'bridge-access'), 'u6', plain, 'account-security')).toEqual({ ok: false, reason: 'step_up_invalid' });
    const noExp = jwt.sign({ ...base, iat: Math.floor(Date.now() / 1000) }, derivedKey(), { algorithm: 'HS256', audience: 'bridge-step-up' });
    expect(checkStepUpGrant(noExp, 'u6', plain, 'account-security')).toEqual({ ok: false, reason: 'step_up_invalid' });
    expect(checkStepUpGrant(forge(base), 'u6', plain, 'account-security').ok).toBe(true);
  });

  it('cannot sign or verify without any secret', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      expect(() => mintStepUpGrant({ _id: 'u7' }, 'password', 'account-security')).toThrow(/required/);
      expect(checkStepUpGrant('x.y.z', 'u7', plain, 'account-security')).toEqual({ ok: false, reason: 'step_up_invalid' });
    } finally {
      process.env.JWT_SECRET = saved;
    }
  });
});

describe('P7 B2 failed-proof lock', () => {
  it('locks step-up proofs after the configured failures and reports it', async () => {
    const u = uid();
    await expect(stepUpProofsLocked(u)).resolves.toBe(false);
    for (let i = 1; i < STEP_UP_POLICY.failedProof.max; i++) {
      await expect(recordFailedStepUpProof(u)).resolves.toBe(false);
      await expect(stepUpProofsLocked(u)).resolves.toBe(false);
    }
    await expect(recordFailedStepUpProof(u)).resolves.toBe(true);
    await expect(stepUpProofsLocked(u)).resolves.toBe(true);
    // Per account: another account is untouched.
    await expect(stepUpProofsLocked(uid())).resolves.toBe(false);
  });

  it('fails closed when the configured counter authority is unavailable', async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    try {
      await expect(stepUpProofsLocked(uid())).rejects.toThrow(/unavailable/);
      await expect(recordFailedStepUpProof(uid())).rejects.toThrow();
    } finally {
      delete process.env.REDIS_URL;
    }
  });
});

describe('P7 B2 decision and guard', () => {
  function account(userId: string, f: Partial<{ password: string; twoFactorEnabled: number; tokenVersion: number }> = {}) {
    findById.mockImplementation(async (id: string) => (id === userId ? { password: BCRYPT, twoFactorEnabled: 0, tokenVersion: 0, ...f } : null));
  }

  it('always-protected actions refuse without a grant with the full, explainable contract', async () => {
    const u = uid();
    account(u);
    const d = await evaluateStepUp(req(), u, 'email.change', T0);
    expect(d).toEqual({
      allowed: false,
      status: 403,
      body: {
        error: 'STEP_UP_REQUIRED',
        action: 'email.change',
        scope: 'account-security',
        reasons: ['step_up_missing'],
        why: STEP_UP_ACTIONS['email.change'].why,
        level: 1,
        methods: ['password', 'sign_in'],
        ttlMs: 600_000,
      },
    });
  });

  it('passes with a grant of the right scope and level, and names the mismatch otherwise', async () => {
    const u = uid();
    account(u, { twoFactorEnabled: 1 });
    const l2 = mintStepUpGrant({ _id: u }, 'totp', 'sensitive-export', T0).token;
    await expect(evaluateStepUp(req(l2), u, 'account.export', T0)).resolves.toEqual({ allowed: true, via: 'grant' });
    await expect(evaluateStepUp(req([l2, 'second']), u, 'account.export', T0)).resolves.toEqual({ allowed: true, via: 'grant' });
    const wrongScope = await evaluateStepUp(req(l2), u, 'account.delete', T0);
    expect(wrongScope).toMatchObject({ allowed: false, status: 403, body: { scope: 'destructive-admin', reasons: ['step_up_scope_mismatch'], level: 2, methods: ['totp', 'backup_code', 'sign_in'] } });
    const l1 = mintStepUpGrant({ _id: u }, 'password', 'sensitive-export', T0).token;
    expect(await evaluateStepUp(req(l1), u, 'account.export', T0)).toMatchObject({ allowed: false, body: { reasons: ['step_up_level'] } });
  });

  it('a vanished account is a 401, never a waived proof', async () => {
    findById.mockResolvedValue(null);
    await expect(evaluateStepUp(req(), 'nobody', 'account.delete', T0)).resolves.toEqual({ allowed: false, status: 401, body: { error: 'User not found' } });
  });

  it('destructive moderation is unprompted up to the burst, then asks once and continues with the grant', async () => {
    const u = uid();
    account(u);
    const actions: StepUpAction[] = ['moderation.ban', 'moderation.kick', 'messages.bulk_delete', 'moderation.ban', 'moderation.kick'];
    for (const [i, action] of actions.entries()) {
      await expect(evaluateStepUp(req(), u, action, T0 + i * 1_000)).resolves.toEqual({ allowed: true, via: 'not_required' });
    }
    const sixth = await evaluateStepUp(req(), u, 'moderation.ban', T0 + 6_000);
    expect(sixth).toMatchObject({ allowed: false, status: 403, body: { scope: 'moderation-burst', reasons: ['moderation_burst', 'step_up_missing'] } });
    const grant = mintStepUpGrant({ _id: u }, 'password', 'moderation-burst', T0 + 7_000).token;
    for (let i = 0; i < 40; i++) {
      await expect(evaluateStepUp(req(grant), u, 'moderation.ban', T0 + 8_000 + i * 100)).resolves.toEqual({ allowed: true, via: 'grant' });
    }
    // The burst window is per actor and slides: after it passes, ordinary moderation is unprompted again.
    await expect(evaluateStepUp(req(), u, 'moderation.kick', T0 + 70_000)).resolves.toEqual({ allowed: true, via: 'not_required' });
    // Another moderator is unaffected by this one's burst.
    const other = uid();
    account(other);
    await expect(evaluateStepUp(req(), other, 'moderation.ban', T0 + 6_500)).resolves.toEqual({ allowed: true, via: 'not_required' });
  });

  it('a grant for another scope does not continue a moderation burst', async () => {
    const u = uid();
    account(u);
    for (let i = 0; i < 5; i++) await evaluateStepUp(req(), u, 'moderation.ban', T0 + i);
    const exportGrant = mintStepUpGrant({ _id: u }, 'password', 'sensitive-export', T0).token;
    expect(await evaluateStepUp(req(exportGrant), u, 'moderation.ban', T0 + 10)).toMatchObject({
      allowed: false, body: { reasons: ['moderation_burst', 'step_up_scope_mismatch'] },
    });
  });

  it('a locked account is told to sign in again', async () => {
    const u = uid();
    account(u, { twoFactorEnabled: 1 });
    for (let i = 0; i < STEP_UP_POLICY.failedProof.max; i++) await recordFailedStepUpProof(u);
    expect(await evaluateStepUp(req(), u, 'passkey.add', T0)).toMatchObject({
      allowed: false, body: { reasons: ['step_up_missing', 'step_up_locked'], methods: ['sign_in'] },
    });
    // A grant obtained by signing in again still works while proofs are locked.
    const signIn = mintSignInGrants({ _id: u }, 'totp', T0).grants['account-security'];
    await expect(evaluateStepUp(req(signIn), u, 'passkey.add', T0)).resolves.toEqual({ allowed: true, via: 'grant' });
  });

  it('a disabled scope is not enforced (operator rollback)', async () => {
    const u = uid();
    account(u);
    process.env.STEP_UP_DISABLED_SCOPES = 'sensitive-export';
    await expect(evaluateStepUp(req(), u, 'account.export', T0)).resolves.toEqual({ allowed: true, via: 'not_required' });
    expect(await evaluateStepUp(req(), u, 'email.change', T0)).toMatchObject({ allowed: false, status: 403 });
  });

  it('requireStepUp: next() with a grant, the refusal body without, 503 when the check cannot run', async () => {
    const u = uid();
    account(u);
    const guard = requireStepUp('server.delete');

    const grant = mintStepUpGrant({ _id: u }, 'password', 'destructive-admin').token;
    const okReq = { ...req(grant), user: { id: u } } as unknown as Request;
    const next = jest.fn();
    const r1 = res();
    await guard(okReq, r1 as unknown as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(r1.status).not.toHaveBeenCalled();

    const r2 = res();
    await guard({ ...req(), user: { id: u } } as unknown as Request, r2 as unknown as Response, next);
    expect(r2.statusCode).toBe(403);
    expect(r2.body).toMatchObject({ error: 'STEP_UP_REQUIRED', action: 'server.delete', scope: 'destructive-admin' });

    const r3 = res();
    await guard(req() as Request, r3 as unknown as Response, next);
    expect(r3.statusCode).toBe(401);

    findById.mockRejectedValueOnce(new Error('db down'));
    const r4 = res();
    await guard({ ...req(), user: { id: u } } as unknown as Request, r4 as unknown as Response, next);
    expect(r4.statusCode).toBe(503);
    expect(r4.body).toEqual({ error: 'STEP_UP_UNAVAILABLE', action: 'server.delete' });

    findById.mockRejectedValueOnce('string failure');
    const r5 = res();
    await guard({ ...req(), user: { id: u } } as unknown as Request, r5 as unknown as Response, next);
    expect(r5.statusCode).toBe(503);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the burst counter authority is unavailable and no grant is presented', async () => {
    const u = uid();
    account(u);
    // countInWindow reports an unavailable authority as "over the limit"; the lock check then cannot run.
    const counter = jest.spyOn(socketRateLimit, 'countInWindow').mockResolvedValue(Number.MAX_SAFE_INTEGER);
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    try {
      const r = res();
      await requireStepUp('moderation.ban')({ ...req(), user: { id: u } } as unknown as Request, r as unknown as Response, jest.fn());
      expect(r.statusCode).toBe(503);
      // With a valid grant the counter is not consulted, so a proven moderator keeps working.
      const grant = mintStepUpGrant({ _id: u }, 'password', 'moderation-burst').token;
      const next = jest.fn();
      await requireStepUp('moderation.ban')({ ...req(grant), user: { id: u } } as unknown as Request, res() as unknown as Response, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(counter).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.REDIS_URL;
      counter.mockRestore();
    }
  });
});
