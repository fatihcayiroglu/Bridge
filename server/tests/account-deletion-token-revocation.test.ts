'use strict';
// Account deletion is an immediate revocation boundary: the deleted person's
// access token must stop authenticating at once — on a single node too, where
// `authMiddleware` keeps each user's `tokenVersion` in a 30 s process cache.
//
// Found by the e2e journey `account-deletion-journey.spec.ts` (P3 baseline):
// `GET /api/me` with the old token right after deletion answered 404 ("user
// not found" behind a PASSING auth check) instead of 401, because the deletion
// route never dropped the cached version. This test runs the REAL middleware
// and the REAL account route; only persistence is modelled.
process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL; // single-node mode: the version cache is active

import express from 'express';
import request from 'supertest';

let userExists = true;
const storedUser = { _id: 'u-del', username: 'leaving', password: 'hash', tokenVersion: 0 };
const users = { findById: jest.fn(async () => (userExists ? { ...storedUser } : null)) };
const auth = { revokeAllForUser: jest.fn(async () => undefined) };

jest.mock('../db/repositories', () => ({ Users: users, Auth: auth }));
jest.mock('../db/loader', () => ({
  __esModule: true,
  default: { _pool: { query: jest.fn(async () => ({ rows: [] })) }, _transaction: jest.fn() },
}));
jest.mock('../lib/accountDeletion', () => ({
  ownershipBlockers: jest.fn(async () => []),
  eraseAccountData: jest.fn(async () => { userExists = false; return { applied: [], plan: {} }; }),
  releaseAfterErasure: jest.fn(async () => ({ removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 0 })),
  existingTables: jest.fn(async () => new Set()),
  tableColumns: jest.fn(async () => new Set()),
}));
jest.mock('bcryptjs', () => ({ compare: jest.fn(async () => true) }));
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn(async () => undefined) }));
jest.mock('../middleware/rateLimit', () => ({ limits: { write: () => (_req: unknown, _res: unknown, next: () => void) => next() } }));

import { authMiddleware, makeToken } from '../middleware/auth';
import accountRouter from '../routes/account';

function app() {
  const a = express();
  a.use(express.json());
  a.get('/api/me', authMiddleware, (_req, res) => { res.json({ ok: true }); });
  a.use('/api/account', accountRouter);
  return a;
}

describe('account deletion revokes the access token immediately (single-node token-version cache)', () => {
  beforeEach(() => { userExists = true; jest.clearAllMocks(); });

  it('the same token is rejected with 401 right after the account is deleted', async () => {
    const token = makeToken(storedUser);
    const server = app();

    // Warm the cache: an ordinary authenticated request before deletion.
    await request(server).get('/api/me').set('Authorization', `Bearer ${token}`).expect(200);

    const del = await request(server).delete('/api/account')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'DELETE', password: 'correct' });
    expect(del.status).toBe(200);
    expect(userExists).toBe(false);

    const after = await request(server).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
  });
});
