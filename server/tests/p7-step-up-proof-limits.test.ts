// server/tests/p7-step-up-proof-limits.test.ts
//
// P7 B2 — the step-up proof endpoints keep the ordinary protections of a
// credential check: the production `limits.twoFactor()` limiter (5 requests per
// window) and the global API CSRF middleware. The per-account failed-proof lock
// is additional (p7-step-up-proofs.test.ts); this file proves the existing
// limiter and CSRF were not bypassed by the new routes.

process.env.RL_2FA_MAX = '5';
process.env.RL_2FA_WIN = '300000';

import express from 'express';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

const request = require('supertest');
import db from '../db/loader';
import stepUpRouter from '../routes/stepUp';
import twoFactorRouter from '../routes/twoFactor';
import { enforceApiCsrf } from '../middleware/csrf';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';

const tok = (uid: string) => jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET as string, { expiresIn: '1h' });

async function makeUser(): Promise<string> {
  const id = uuidv4();
  await (db as unknown as { users: { insert(d: Record<string, unknown>): Promise<unknown> } }).users.insert({
    _id: id, username: `u-${id.slice(0, 8)}`, tokenVersion: 0, password: '', twoFactorEnabled: false,
  });
  return id;
}

beforeEach(() => {
  _resetRateLimitStoreForTest();
  (db as unknown as { _reset?: () => void })._reset?.();
});

describe.each([
  ['/api/step-up/password', { password: 'x', scope: 'account-security' }],
  ['/api/2fa/step-up', { code: '000000', scope: 'account-security' }],
])('%s', (path, body) => {
  it('is under the production 2FA limiter: the 6th request in the window is 429', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/step-up', stepUpRouter);
    app.use('/api/2fa', twoFactorRouter);
    const token = tok(await makeUser());
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      statuses.push((await request(app).post(path).set('Authorization', `Bearer ${token}`).send(body)).status);
    }
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it('is under the global API CSRF middleware', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', enforceApiCsrf);
    app.use('/api/step-up', stepUpRouter);
    app.use('/api/2fa', twoFactorRouter);
    const r = await request(app).post(path).set('Authorization', `Bearer ${tok(await makeUser())}`).send(body);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'CSRF token missing' });
  });
});

describe('protected 2FA routes keep their existing limiter accounting', () => {
  it('attempts without a proof are refused with STEP_UP_REQUIRED and still count toward limits.twoFactor()', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/2fa', twoFactorRouter);
    const token = tok(await makeUser());
    const results: string[] = [];
    for (let i = 0; i < 7; i++) {
      const r = await request(app).post('/api/2fa/verify').set('Authorization', `Bearer ${token}`).send({ code: String(111110 + i) });
      results.push(r.status === 403 ? `403 ${r.body.error}` : String(r.status));
    }
    expect(results).toEqual([
      ...Array(5).fill('403 STEP_UP_REQUIRED'),
      '429', '429',
    ]);
  });
});
