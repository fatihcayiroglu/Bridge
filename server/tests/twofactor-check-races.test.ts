// server/tests/twofactor-check-races.test.ts
//
// `/api/2fa/check` turns a password-verified login into a session. Its
// refusal branches that no suite reached:
//   - a malformed or missing body (no JSON at all);
//   - the account turned 2FA off, or its sessions were revoked (tokenVersion
//     bumped), after the challenge was issued — a correct code must not
//     resurrect that login;
//   - two requests that both passed `peek` with the same challenge: only the
//     one that claims it gets a session, the other is told it was used;
//   - the same backup code presented in two different logins at once: both
//     challenges are valid, but the code is burned by exactly one;
// and on `/api/2fa/verify` (turning 2FA on):
//   - two concurrent confirmations: one enables 2FA and returns backup codes,
//     the other gets 409 and NO second set of codes.
//
// The races are made deterministic by holding a REAL repository call (a spy
// that delegates to the original) until the other request has reached a
// chosen point. Nothing is replaced with a fake answer.
process.env.RL_2FA_MAX = '1000'; // the limiter itself is measured in twofactor-rate-limit.test.ts

import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

const request = require('supertest');
import db from '../db/loader';
import { Users } from '../db/repositories';
import { authMiddleware } from '../middleware/auth';
import { issueTwoFactorLoginChallenge } from '../lib/twoFactorLoginChallenge';
import { requireDoc } from './helpers/mockDb';
import twoFactorRouter, {
  __hashBackupCodeForTest as hashBackupCode,
  __readBackupCodesForTest as readBackupCodes,
  __totpNowForTest as totpNow,
} from '../routes/twoFactor';
import { stepUpFor } from './helpers/stepUp';

const SECRET = 'JBSWY3DPEHPK3PXP';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/2fa', twoFactorRouter);
  return app;
}
const accessToken = (uid: string, v = 0) => jwt.sign({ id: uid, v }, process.env.JWT_SECRET as string, { expiresIn: '1h' });
const refreshCookie = (res: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []).filter(c => /refresh/i.test(c));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>(resolve => { open = resolve; });
  return { opened, open };
}

async function seedUser(extra: Record<string, unknown> = {}) {
  const id = uuidv4();
  await db.users.insert({
    _id: id, username: `u-${id.slice(0, 8)}`, displayName: 'U', tokenVersion: 0,
    twoFactorEnabled: true, twoFactorSecret: SECRET, twoFactorBackup: '[]', twoFactorLastUsedStep: null,
    ...extra,
  });
  return id;
}

let app: express.Express;
beforeEach(() => {
  db._reset?.();
  app = buildApp();
});
afterEach(() => jest.restoreAllMocks());

describe('POST /api/2fa/check — shape refusals', () => {
  it('refuses a request with no JSON body, or with a token/code of the wrong shape, before touching any challenge', async () => {
    const findById = jest.spyOn(Users, 'findById');
    const noBody = await request(app).post('/api/2fa/check');
    expect(noBody.status).toBe(400);
    for (const body of [
      { code: '123456' },
      { tempToken: 'x'.repeat(31), code: '123456' },
      { tempToken: 'x'.repeat(129), code: '123456' },
      { tempToken: 'x'.repeat(40), code: '' },
      { tempToken: 'x'.repeat(40), code: 'c'.repeat(129) },
      { tempToken: 'x'.repeat(40), code: 123456 },
    ]) {
      const res = await request(app).post('/api/2fa/check').send(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'tempToken and code required' });
    }
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('POST /api/2fa/check — the account changed after the challenge was issued', () => {
  it('2FA turned off since the password step: a correct code gives no session', async () => {
    const id = await seedUser();
    const tempToken = await issueTwoFactorLoginChallenge(id, 0);
    await db.users.update({ _id: id }, { $set: { twoFactorEnabled: false } });

    const res = await request(app).post('/api/2fa/check').send({ tempToken, code: totpNow(SECRET)[1] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired two-factor challenge' });
    expect(res.body.token).toBeUndefined();
    expect(refreshCookie(res)).toEqual([]);
  });

  it('sessions revoked since the password step (tokenVersion bumped): a correct code gives no session and burns no step', async () => {
    const id = await seedUser();
    const tempToken = await issueTwoFactorLoginChallenge(id, 0);
    await db.users.update({ _id: id }, { $set: { tokenVersion: 1 } });

    const res = await request(app).post('/api/2fa/check').send({ tempToken, code: totpNow(SECRET)[1] });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid or expired two-factor challenge' });
    expect(refreshCookie(res)).toEqual([]);
    expect((await requireDoc(db.users, { _id: id })).twoFactorLastUsedStep).toBeNull();
  });
});

describe('POST /api/2fa/check — concurrent use', () => {
  it('two requests that both passed peek with one challenge: only the claimant signs in, the other is told it was used', async () => {
    const id = await seedUser();
    const tempToken = await issueTwoFactorLoginChallenge(id, 0);
    const code = totpNow(SECRET)[1];

    // Both requests peek the challenge and read the account before either
    // claims it: A waits after its read until B has read too; B then waits
    // until A has finished (claimed and signed in) before it tries to claim.
    const original = Users.findById.bind(Users);
    const bRead = gate();
    const aDone = gate();
    let calls = 0;
    jest.spyOn(Users, 'findById').mockImplementation(async (uid: string) => {
      const n = ++calls;
      const doc = await original(uid);
      if (n === 1) await bRead.opened;
      if (n === 2) { bRead.open(); await aDone.opened; }
      return doc;
    });

    type Res = { status: number; body: Record<string, unknown>; headers: Record<string, unknown> };
    const a: Promise<Res> = request(app).post('/api/2fa/check').send({ tempToken, code }).then((r: Res) => r);
    while (calls < 1) await new Promise(resolve => setTimeout(resolve, 1));
    const b: Promise<Res> = request(app).post('/api/2fa/check').send({ tempToken, code }).then((r: Res) => r);
    const ra = await a;
    aDone.open();
    const rb = await b;

    expect(ra.status).toBe(200);
    expect(typeof ra.body.token).toBe('string');
    expect(rb.status).toBe(401);
    expect(rb.body).toEqual({ error: 'Two-factor challenge already used or expired' });
    expect(refreshCookie(rb)).toEqual([]);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('one backup code in two different logins at the same time is burned once; the second login is refused', async () => {
    const code = '5555666677778888';
    const id = await seedUser({ twoFactorBackup: JSON.stringify([hashBackupCode(code), hashBackupCode('9999aaaabbbbcccc')]) });
    const [first, second] = await Promise.all([issueTwoFactorLoginChallenge(id, 0), issueTwoFactorLoginChallenge(id, 0)]);

    // Both requests read the account while the code is still stored. The
    // first consume waits for the second read; the second consume waits for
    // the first to finish. Each repository call still runs for real.
    const originalFind = Users.findById.bind(Users);
    const originalConsume = Users.consumeBackupCode.bind(Users);
    const bothRead = gate();
    let reads = 0;
    jest.spyOn(Users, 'findById').mockImplementation(async (uid: string) => {
      const doc = await originalFind(uid);
      if (++reads === 2) bothRead.open();
      return doc;
    });
    let firstConsume: Promise<boolean> | null = null;
    const consumeResults: boolean[] = [];
    jest.spyOn(Users, 'consumeBackupCode').mockImplementation(async (uid: string, stored: string) => {
      if (!firstConsume) {
        firstConsume = (async () => { await bothRead.opened; return originalConsume(uid, stored); })();
        const won = await firstConsume;
        consumeResults.push(won);
        return won;
      }
      await firstConsume;
      const won = await originalConsume(uid, stored);
      consumeResults.push(won);
      return won;
    });

    const [ra, rb] = await Promise.all([
      request(app).post('/api/2fa/check').send({ tempToken: first, code }),
      request(app).post('/api/2fa/check').send({ tempToken: second, code }),
    ]);

    expect(reads).toBe(2);
    expect(consumeResults).toEqual([true, false]);
    expect([ra.status, rb.status].sort()).toEqual([200, 401]);
    const refused = ra.status === 401 ? ra : rb;
    expect(refused.body).toEqual({ error: 'Invalid 2FA code' });
    expect(refreshCookie(refused)).toEqual([]);
    const stored = readBackupCodes((await requireDoc(db.users, { _id: id })).twoFactorBackup);
    expect(stored).toEqual([hashBackupCode('9999aaaabbbbcccc')]);
  });
});

describe('2FA setup refusals', () => {
  function withAuth() {
    const a = express();
    a.use(express.json());
    a.use('/api/2fa', authMiddleware, twoFactorRouter);
    return a;
  }

  it('two concurrent confirmations: one turns 2FA on with backup codes, the other gets 409 and no second set', async () => {
    const id = await seedUser({ twoFactorEnabled: false, twoFactorSecret: SECRET });
    const token = accessToken(id);
    const code = totpNow(SECRET)[1];
    const headers = { Authorization: `Bearer ${token}`, ...stepUpFor(token, 'account-security') };

    // Both confirmations read the not-yet-enabled account before either writes.
    const original = Users.findById.bind(Users);
    const bothRead = gate();
    let routeReads = 0;
    jest.spyOn(Users, 'findById').mockImplementation(async (uid: string) => {
      const doc = await original(uid);
      // authMiddleware and the route both read the account; the route's read
      // is the one that carries twoFactorSecret into the enable decision.
      if (doc && (doc as { twoFactorSecret?: unknown }).twoFactorSecret) {
        if (++routeReads === 2) bothRead.open();
        await bothRead.opened;
      }
      return doc;
    });

    const [ra, rb] = await Promise.all([
      request(withAuth()).post('/api/2fa/verify').set(headers).send({ code }),
      request(withAuth()).post('/api/2fa/verify').set(headers).send({ code }),
    ]);

    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const winner = ra.status === 200 ? ra : rb;
    const loser = ra.status === 200 ? rb : ra;
    expect(loser.body).toEqual({ error: '2FA setup was already completed or replaced' });
    expect(loser.body.backupCodes).toBeUndefined();
    expect(winner.body.backupCodes).toHaveLength(8);
    const saved = readBackupCodes((await requireDoc(db.users, { _id: id })).twoFactorBackup);
    expect(saved).toEqual((winner.body.backupCodes as string[]).map(c => hashBackupCode(c)));
    expect((await requireDoc(db.users, { _id: id })).twoFactorEnabled).toBe(true);
  });
});
