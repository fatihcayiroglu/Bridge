// server/tests/p7-dm-new-conversation-route.test.ts
//
// P7 B1 (lab ATK-05, DM spray) — the REST half of the new-conversation budget.
// `POST /api/dm/:userId` opens a conversation exactly like the socket path, so
// it must spend the same budget (lib/abusePolicy.ts claimNewDmConversation):
// otherwise a spammer simply switches transport. Existing conversations never
// consume it. The budget here is the real policy on the single-node window.

process.env.NODE_ENV = 'test';
process.env.ABUSE_DM_NEW_MAX = '2';
delete process.env.REDIS_URL;

import express from 'express';
import request from 'supertest';

const users = new Map<string, { _id: string; username: string }>();
const findOrCreateConversation = jest.fn(async (a: string, b: string) => ({ conv: { participants: [a, b] }, dmId: `dm-${a}-${b}` }));
const evaluateDmAccess = jest.fn();

jest.mock('../db/repositories', () => ({
  Users: { findById: jest.fn(async (id: string) => users.get(id) ?? null) },
  Dms: { findOrCreateConversation: (a: string, b: string) => findOrCreateConversation(a, b) },
}));
jest.mock('../lib/dmAccessPolicy', () => ({ evaluateDmAccess: (...args: unknown[]) => evaluateDmAccess(...args) }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; headers: Record<string, string | undefined> }, _res: unknown, next: () => void) => {
    req.user = { id: req.headers['x-test-user'] ?? 'sender' };
    next();
  },
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { dm: () => (_req: unknown, _res: unknown, next: () => void) => next() } }));

import { router as dmRouter } from '../routes/dm';
import { ABUSE_POLICY } from '../lib/abusePolicy';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/dm', dmRouter);
  return a;
}

beforeAll(() => {
  for (let i = 0; i < 6; i++) users.set(`target-${i}`, { _id: `target-${i}`, username: `target${i}` });
});

beforeEach(() => {
  findOrCreateConversation.mockClear();
  evaluateDmAccess.mockReset();
});

describe('P7 B1 REST DM — new-conversation budget', () => {
  it('the policy under test is the configured one', () => {
    expect(ABUSE_POLICY.dmNew.max).toBe(2);
  });

  it('opening more NEW conversations than the budget is refused with a retry time; nothing is created', async () => {
    evaluateDmAccess.mockResolvedValue({ allowed: true, existingConversation: false });
    const opened = [];
    for (let i = 0; i < 3; i++) {
      opened.push(await request(app()).post(`/api/dm/target-${i}`).set('x-test-user', 'sprayer'));
    }
    expect(opened.map(r => r.status)).toEqual([200, 200, 429]);
    expect(opened[2].body).toEqual({ error: 'DM_NEW_CONVERSATION_LIMIT', retryAfterMs: ABUSE_POLICY.dmNew.windowMs });
    expect(opened[2].headers['retry-after']).toBe(String(Math.ceil(ABUSE_POLICY.dmNew.windowMs / 1000)));
    expect(findOrCreateConversation).toHaveBeenCalledTimes(2);
  });

  it('continuing an EXISTING conversation never spends the budget', async () => {
    evaluateDmAccess.mockResolvedValue({ allowed: true, existingConversation: true });
    for (let i = 0; i < 5; i++) {
      const res = await request(app()).post('/api/dm/target-0').set('x-test-user', 'chatty-friend');
      expect(res.status).toBe(200);
      expect(res.body._id).toBe('dm-chatty-friend-target-0');
    }
    // The budget is untouched: two new conversations still open.
    evaluateDmAccess.mockResolvedValue({ allowed: true, existingConversation: false });
    for (const target of ['target-4', 'target-5']) {
      await expect(request(app()).post(`/api/dm/${target}`).set('x-test-user', 'chatty-friend')).resolves.toMatchObject({ status: 200 });
    }
  });

  it('each account has its own budget', async () => {
    evaluateDmAccess.mockResolvedValue({ allowed: true, existingConversation: false });
    for (const sender of ['alice', 'bob']) {
      for (let i = 0; i < 2; i++) {
        await expect(request(app()).post(`/api/dm/target-${i}`).set('x-test-user', sender)).resolves.toMatchObject({ status: 200 });
      }
    }
  });

  it('privacy and blocks are decided before the budget is touched', async () => {
    evaluateDmAccess.mockResolvedValue({ allowed: false, reason: 'blocked' });
    for (let i = 0; i < 4; i++) {
      await expect(request(app()).post('/api/dm/target-1').set('x-test-user', 'blocked-sender')).resolves.toMatchObject({ status: 403 });
    }
    evaluateDmAccess.mockResolvedValue({ allowed: true, existingConversation: false });
    await expect(request(app()).post('/api/dm/target-1').set('x-test-user', 'blocked-sender')).resolves.toMatchObject({ status: 200 });
  });
});
