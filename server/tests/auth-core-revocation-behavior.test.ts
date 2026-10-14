// server/tests/auth-core-revocation-behavior.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// middleware/auth — REVOCATION SEMANTICS, EXERCISED (not grepped)
// ════════════════════════════════════════════════════════════════════════════
// The security contract of the session layer, driven through the real
// functions on the in-memory adapter:
//
//   · tokenVersion is an immediate revocation boundary in cluster mode
//     (REDIS_URL set): no node may serve a revoked access token from its
//     process-local cache. Single-node mode caches for a bounded window that
//     `_invalidateTokenCache` closes.
//   · an access token minted without a `v` claim is still revocable.
//   · refresh-token rotation fails closed on every abnormal row: a replayed
//     token without a family revokes ALL of the user's sessions, a token of a
//     deleted account or an older generation is destroyed, never rotated.
//   · the PostgreSQL atomic rotation result is mapped faithfully (ok / reuse).
//   · logout helpers never resolve a session owner from an unknown token and
//     never persist the raw refresh token.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: logger, createLogger: () => logger }));

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { Response, NextFunction } from 'express';
import { Auth } from '../db/repositories';
import {
  authMiddleware, makeToken, makeMediaToken, makeRefreshToken, rotateRefreshToken, revokeRefreshToken,
  revokeRefreshSession, verifiedTokenSubject, _invalidateTokenCache, type AuthRequest,
} from '../middleware/auth';

const db = require('../db/loader');
const hash = (raw: string) => crypto.createHmac('sha256', process.env.REFRESH_SECRET!).update(raw).digest('hex');

async function user(id: string, tokenVersion = 0) {
  await db.users.insert({ _id: id, username: id, displayName: id, tokenVersion });
  return { _id: id, username: id, tokenVersion };
}
async function bumpVersion(id: string, tokenVersion: number) {
  await db.users.update({ _id: id }, { $set: { tokenVersion } });
}
/** Runs the real middleware; returns the HTTP status it answered, or 'next'. */
async function guard(token: string): Promise<number | 'next'> {
  let status: number | 'next' = 'next';
  const req = { headers: { authorization: `Bearer ${token}` } } as unknown as AuthRequest;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as unknown as Response;
  await authMiddleware(req, res, (() => undefined) as NextFunction);
  return status;
}

const originalRedis = process.env.REDIS_URL;
beforeEach(() => {
  db._reset?.();
  jest.clearAllMocks();
  jest.restoreAllMocks();
  delete process.env.REDIS_URL;
});
afterAll(() => {
  if (originalRedis === undefined) delete process.env.REDIS_URL; else process.env.REDIS_URL = originalRedis;
});

describe('tokenVersion revocation boundary', () => {
  test('cluster mode re-reads storage on every request: a revoked token dies at once', async () => {
    process.env.REDIS_URL = 'redis://cluster.invalid:6379';
    const u = await user('cluster-user');
    const token = makeToken(u);
    expect(await guard(token)).toBe('next');
    // Another node revokes all sessions; this node has no way to be told.
    await bumpVersion('cluster-user', 1);
    expect(await guard(token)).toBe(401);
  });

  test('single-node mode serves its bounded cache until invalidated, then rejects', async () => {
    const u = await user('single-user');
    const token = makeToken(u);
    expect(await guard(token)).toBe('next');
    await bumpVersion('single-user', 1);
    // The documented single-node window: the local cache still holds v=0.
    expect(await guard(token)).toBe('next');
    _invalidateTokenCache('single-user');
    expect(await guard(token)).toBe(401);
  });

  test('a token minted without a v claim is valid only while the account is at version 0', async () => {
    await user('legacy-claims');
    const noV = jwt.sign({ id: 'legacy-claims', username: 'legacy-claims' }, process.env.JWT_SECRET!, { expiresIn: '5m' });
    expect(await guard(noV)).toBe('next');
    await bumpVersion('legacy-claims', 1);
    _invalidateTokenCache('legacy-claims');
    expect(await guard(noV)).toBe(401);
  });

  test('a token for a deleted account is refused', async () => {
    const u = await user('gone-user');
    const token = makeToken(u);
    await db.users.remove({ _id: 'gone-user' });
    _invalidateTokenCache('gone-user');
    expect(await guard(token)).toBe(401);
  });
});

describe('verified token subject (rate-limit key, never an authorization decision)', () => {
  test('only a signed access token with a non-empty id yields a subject', async () => {
    const u = await user('subject-user');
    expect(verifiedTokenSubject(makeToken(u))).toBe('subject-user');
    for (const value of [undefined, null, 42, '', {}]) expect(verifiedTokenSubject(value)).toBeNull();
    expect(verifiedTokenSubject(makeMediaToken(u))).toBeNull();
    expect(verifiedTokenSubject(jwt.sign({ username: 'no-id' }, process.env.JWT_SECRET!))).toBeNull();
    expect(verifiedTokenSubject(jwt.sign({ id: '' }, process.env.JWT_SECRET!))).toBeNull();
    expect(verifiedTokenSubject(jwt.sign({ id: 'forged' }, 'some-other-secret-that-is-long-enough'))).toBeNull();
  });
});

describe('refresh rotation fails closed on abnormal rows (in-memory fallback)', () => {
  test('replaying a used token that has no family revokes every session of that user', async () => {
    const u = await user('replay-user');
    const replayed = await makeRefreshToken(u);
    const otherDevice = await makeRefreshToken(u);
    await db.refreshTokens.update({ token: hash(replayed) }, { $set: { used: true, family: null } });

    expect(await rotateRefreshToken(replayed)).toEqual({ error: 'reuse' });
    expect(await Auth.findRefreshToken(hash(otherDevice))).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'auth.refresh_token.reuse_detected' }), expect.any(String));
  });

  test('a token whose account no longer exists is destroyed, not rotated', async () => {
    const u = await user('deleted-user');
    const raw = await makeRefreshToken(u);
    await db.users.remove({ _id: 'deleted-user' });

    expect(await rotateRefreshToken(raw)).toEqual({ error: 'user_not_found' });
    expect(await Auth.findRefreshToken(hash(raw))).toBeNull();
  });

  test('a token of an older generation without a family is destroyed alone', async () => {
    const u = await user('stale-gen');
    const stale = await makeRefreshToken(u);
    await db.refreshTokens.update({ token: hash(stale) }, { $set: { family: null } });
    await bumpVersion('stale-gen', 1);
    const current = await makeRefreshToken({ ...u, tokenVersion: 1 });

    expect(await rotateRefreshToken(stale)).toEqual({ error: 'revoked' });
    expect(await Auth.findRefreshToken(hash(stale))).toBeNull();
    // A session issued after the revocation is untouched.
    expect(await Auth.findRefreshToken(hash(current))).not.toBeNull();
  });

  test('a legacy row without a family is rotated into a new family, and the old token is spent', async () => {
    const u = await user('legacy-family');
    const raw = await makeRefreshToken(u);
    await db.refreshTokens.update({ token: hash(raw) }, { $set: { family: null } });

    const rotated = await rotateRefreshToken(raw);
    expect(rotated && 'newToken' in rotated).toBe(true);
    const fresh = await Auth.findRefreshToken(hash((rotated as { newToken: string }).newToken)) as { family?: string } | null;
    expect(typeof fresh?.family).toBe('string');
    expect(fresh!.family!.length).toBeGreaterThan(0);
    expect(await rotateRefreshToken(raw)).toEqual({ error: 'reuse' });
  });
});

describe('PostgreSQL atomic rotation result mapping', () => {
  test('an atomic "ok" returns the stored user with a fresh opaque token', async () => {
    const spy = jest.spyOn(Auth, 'rotateRefreshTokenAtomic').mockResolvedValue({ status: 'ok', user: { _id: 'pg-user', username: 'pg-user' } });
    const result = await rotateRefreshToken('presented-token') as { user: { _id: string }; newToken: string };
    expect(result.user._id).toBe('pg-user');
    expect(result.newToken).toMatch(/^[0-9a-f]{96}$/);
    // The repository only ever receives HMAC digests, never the raw tokens.
    const input = spy.mock.calls[0]![0];
    expect(input.oldTokenHash).toBe(hash('presented-token'));
    expect(input.newTokenHash).toBe(hash(result.newToken));
  });

  test('an atomic "reuse" is reported and logged as a replay', async () => {
    jest.spyOn(Auth, 'rotateRefreshTokenAtomic').mockResolvedValue({ status: 'reuse' });
    expect(await rotateRefreshToken('replayed')).toEqual({ error: 'reuse' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'auth.refresh_token.reuse_detected' }), expect.any(String));
  });

  test('other atomic outcomes are passed through unchanged', async () => {
    for (const status of ['expired', 'not_found', 'user_not_found', 'revoked'] as const) {
      jest.spyOn(Auth, 'rotateRefreshTokenAtomic').mockResolvedValueOnce({ status });
      expect(await rotateRefreshToken('t')).toEqual({ error: status });
    }
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('logout helpers', () => {
  test('revokeRefreshToken deletes the session by its digest and ignores an empty token', async () => {
    const u = await user('logout-user');
    const raw = await makeRefreshToken(u);
    expect(await Auth.findRefreshToken(raw)).toBeNull();          // the raw token is never stored
    const spy = jest.spyOn(Auth, 'revokeRefreshToken');
    await revokeRefreshToken('');
    expect(spy).not.toHaveBeenCalled();
    await revokeRefreshToken(raw);
    expect(spy).toHaveBeenCalledWith(hash(raw));
    expect(await Auth.findRefreshToken(hash(raw))).toBeNull();
  });

  test('revokeRefreshSession names the owner only for a real session', async () => {
    const u = await user('session-owner');
    const raw = await makeRefreshToken(u);
    expect(await revokeRefreshSession('')).toBeNull();
    expect(await revokeRefreshSession('not-a-session')).toBeNull();
    expect(await revokeRefreshSession(raw)).toBe('session-owner');
    expect(await revokeRefreshSession(raw)).toBeNull();           // already gone
  });
});
