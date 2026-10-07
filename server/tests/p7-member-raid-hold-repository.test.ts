// server/tests/p7-member-raid-hold-repository.test.ts
//
// P7 B1 — the repository half of the raid hold (MemberRepository
// holdRecentYoungJoiners / releaseRaidHold). Route and raid-policy suites mock
// these two methods; this suite runs them for real: the in-memory store that
// tests and single-node development use, and the PostgreSQL statement shape.
//
// Contract under test (docs/P7_TRUST_SOCIAL_FOUNDATION.md § B1 evidence):
//   · only members who joined inside the surge AND whose account is young are held;
//   · banned rows and established accounts are never touched;
//   · a longer existing timeout (a moderator's) is never shortened;
//   · release lifts exactly the holds the raid placed, never a moderator timeout.

process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();
jest.mock('../db/loader', () => mockDb);

import Members from '../db/repositories/MemberRepository';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60_000;
const SURGE_START = NOW - 10_000;
const YOUNG_SINCE = NOW - 24 * HOUR;
const HOLD_UNTIL = NOW + 10 * 60_000;

type Row = Record<string, unknown>;

async function seed(userId: string, { joinedAt, createdAt, banned = false, timeoutUntil = null }:
  { joinedAt: number; createdAt?: number; banned?: boolean; timeoutUntil?: number | null }) {
  if (createdAt !== undefined) await mockDb.users.insert({ _id: userId, username: userId, createdAt });
  await mockDb.members.insert({ userId, serverId: 'srv', joinedAt, banned, timeoutUntil });
}

async function timeoutOf(userId: string): Promise<unknown> {
  const row = await mockDb.members.findOne({ userId, serverId: 'srv' }) as Row | null;
  return row?.timeoutUntil ?? null;
}

describe('P7 B1 raid hold — in-memory store', () => {
  beforeEach(() => {
    mockDb._reset?.();
    delete (mockDb as unknown as { _pool?: unknown })._pool;
  });

  it('holds exactly the young accounts that joined inside the surge', async () => {
    await seed('raider-1', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR });
    await seed('raider-2', { joinedAt: NOW - 2_000, createdAt: NOW - 2 * HOUR, timeoutUntil: NOW + 1_000 }); // shorter: extended
    await seed('veteran', { joinedAt: NOW - 1_000, createdAt: NOW - 400 * 24 * HOUR });                     // established account
    await seed('old-member', { joinedAt: NOW - 30 * 24 * HOUR, createdAt: NOW - HOUR });                   // joined before the surge
    await seed('banned', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR, banned: true });
    await seed('punished', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR, timeoutUntil: NOW + 24 * HOUR }); // moderator timeout: longer
    await seed('ghost', { joinedAt: NOW - 1_000 });                                                           // no user row

    const held = await Members.holdRecentYoungJoiners('srv', { joinedSince: SURGE_START, accountCreatedSince: YOUNG_SINCE, holdUntil: HOLD_UNTIL });

    expect(held).toBe(2);
    await expect(timeoutOf('raider-1')).resolves.toBe(HOLD_UNTIL);
    await expect(timeoutOf('raider-2')).resolves.toBe(HOLD_UNTIL);
    await expect(timeoutOf('veteran')).resolves.toBeNull();
    await expect(timeoutOf('old-member')).resolves.toBeNull();
    await expect(timeoutOf('banned')).resolves.toBeNull();
    await expect(timeoutOf('punished')).resolves.toBe(NOW + 24 * HOUR);
    await expect(timeoutOf('ghost')).resolves.toBeNull();
  });

  it('a second hold for the same surge is idempotent', async () => {
    await seed('raider', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR });
    const bounds = { joinedSince: SURGE_START, accountCreatedSince: YOUNG_SINCE, holdUntil: HOLD_UNTIL };
    await expect(Members.holdRecentYoungJoiners('srv', bounds)).resolves.toBe(1);
    await expect(Members.holdRecentYoungJoiners('srv', bounds)).resolves.toBe(0);
  });

  it('release lifts only the raid holds and leaves moderator timeouts in place', async () => {
    await seed('held-a', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR, timeoutUntil: HOLD_UNTIL });
    await seed('held-b', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR, timeoutUntil: HOLD_UNTIL });
    await seed('moderated', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR, timeoutUntil: HOLD_UNTIL + 1 });
    await seed('free', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR });

    await expect(Members.releaseRaidHold('srv', HOLD_UNTIL)).resolves.toBe(2);
    await expect(timeoutOf('held-a')).resolves.toBeNull();
    await expect(timeoutOf('held-b')).resolves.toBeNull();
    await expect(timeoutOf('moderated')).resolves.toBe(HOLD_UNTIL + 1);
    await expect(Members.releaseRaidHold('srv', HOLD_UNTIL)).resolves.toBe(0);
  });

  it.each([
    ['negative', { joinedSince: -1, accountCreatedSince: YOUNG_SINCE, holdUntil: HOLD_UNTIL }],
    ['fractional', { joinedSince: SURGE_START, accountCreatedSince: 0.5, holdUntil: HOLD_UNTIL }],
    ['unsafe', { joinedSince: SURGE_START, accountCreatedSince: YOUNG_SINCE, holdUntil: Number.MAX_SAFE_INTEGER + 2 }],
    ['NaN', { joinedSince: Number.NaN, accountCreatedSince: YOUNG_SINCE, holdUntil: HOLD_UNTIL }],
  ])('refuses %s hold bounds before touching any row', async (_label, bounds) => {
    await seed('raider', { joinedAt: NOW - 1_000, createdAt: NOW - HOUR });
    await expect(Members.holdRecentYoungJoiners('srv', bounds)).rejects.toThrow(RangeError);
    await expect(timeoutOf('raider')).resolves.toBeNull();
  });

  it.each([-1, 1.5, Number.NaN])('refuses release bound %p', async (holdUntil) => {
    await expect(Members.releaseRaidHold('srv', holdUntil)).rejects.toThrow(RangeError);
  });
});

describe('P7 B1 raid hold — PostgreSQL statement', () => {
  const query = jest.fn();
  beforeEach(() => {
    mockDb._reset?.();
    query.mockReset();
    (mockDb as unknown as { _pool?: unknown })._pool = { query };
  });
  afterAll(() => { delete (mockDb as unknown as { _pool?: unknown })._pool; });

  it('holds in ONE conditional UPDATE joined to account age, never shortening a timeout', async () => {
    query.mockResolvedValueOnce({ rowCount: 7 });
    await expect(Members.holdRecentYoungJoiners('srv', { joinedSince: SURGE_START, accountCreatedSince: YOUNG_SINCE, holdUntil: HOLD_UNTIL })).resolves.toBe(7);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE members m SET "timeoutUntil" = \$4\s+FROM users u/);
    expect(sql).toContain('m.banned = FALSE');
    expect(sql).toContain('u."createdAt" >= $3');
    expect(sql).toContain('(m."timeoutUntil" IS NULL OR m."timeoutUntil" < $4)');
    expect(params).toEqual(['srv', SURGE_START, YOUNG_SINCE, HOLD_UNTIL]);
  });

  it('release clears only rows carrying the exact raid hold value', async () => {
    query.mockResolvedValueOnce({ rowCount: 3 });
    await expect(Members.releaseRaidHold('srv', HOLD_UNTIL)).resolves.toBe(3);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toBe('UPDATE members SET "timeoutUntil" = NULL WHERE "serverId" = $1 AND "timeoutUntil" = $2');
    expect(params).toEqual(['srv', HOLD_UNTIL]);
  });

  it('a driver that omits rowCount reports zero rows changed', async () => {
    query.mockResolvedValue({});
    await expect(Members.holdRecentYoungJoiners('srv', { joinedSince: SURGE_START, accountCreatedSince: YOUNG_SINCE, holdUntil: HOLD_UNTIL })).resolves.toBe(0);
    await expect(Members.releaseRaidHold('srv', HOLD_UNTIL)).resolves.toBe(0);
  });
});
