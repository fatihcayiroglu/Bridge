// server/tests/pg-integration/inbox-attention-created-once.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: ONE MENTION, ONE NOTIFICATION — EVEN WHEN IT IS DELIVERED
// TWICE AT ONCE
// ════════════════════════════════════════════════════════════════════════════
// An inbox row has a deterministic id (`inbox:<user>:<message>`, or
// `inbox:saved-reminder:<user>:<saved>:<time>`), so retried deliveries cannot
// store it twice. `insertChannelAttention` / `insertSavedReminder` return
// whether THIS call stored it, and the callers announce the row (realtime
// `notification:mention` and `inbox:changed`, a push, +1 unread) only on
// `true`.
//
// THE DEFECT: on PostgreSQL the generic collection insert runs
// `ON CONFLICT (_id) DO NOTHING` and returns the row that already exists, so
// it never fails on a duplicate. Two deliveries that both passed the
// existence check therefore BOTH got `true`: one mention was announced twice,
// the pending push counted it twice ("2 new mentions") and the unread counter
// moved by 2. The in-memory unit DB could not show this.
//
// HOW THE RACE IS MADE CERTAIN: each delivery's REAL existence check (a read
// on PostgreSQL) is held until both have read, so both miss each other and
// both write. Nothing else is stubbed except the push transport (network).

const mockPushes: unknown[] = [];
jest.mock('../../lib/pushSender', () => ({
  sendPushToUser: async (...args: unknown[]) => { mockPushes.push(args); },
}));

import { Notifications } from '../../db/repositories';
import { processNotifications, __pendingPushForTest } from '../../lib/notifications';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-att';
const AUTHOR = `${P}-author`;
const BOB = `${P}-bob`;
const SRV = `${P}-srv`;
const CH = `${P}-ch`;
const MSG = `${P}-m1`;

/** Holds the first `n` REAL existence checks on the inbox until all n have read. */
function raceTheExistenceChecks(n: number) {
  const realFindOne = db.notifications.findOne.bind(db.notifications);
  const prechecks: unknown[] = [];
  let started = 0;
  let release!: () => void;
  const allRead = new Promise<void>(resolve => { release = resolve; });
  const giveUp = setTimeout(release, 5_000);
  jest.spyOn(db.notifications, 'findOne').mockImplementation(async (...args: unknown[]) => {
    if (++started > n) return realFindOne(...args);
    const found = await realFindOne(...args);
    prechecks.push(found);
    if (prechecks.length === n) { clearTimeout(giveUp); release(); }
    await allRead;
    return found;
  });
  return { prechecks };
}

RUN('real PostgreSQL — a duplicate inbox delivery is announced once', () => {
  const q = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await db._pool.query(sql, params)).rows;
  const inboxRows = async (userId: string) => q(`SELECT _id, type FROM notifications WHERE "userId" = $1 ORDER BY _id`, [userId]);
  const cleanup = async () => {
    await q(`DELETE FROM notifications WHERE "userId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM unread_counts WHERE "userId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM channels WHERE _id = $1`, [CH]);
    await q(`DELETE FROM members WHERE "serverId" = $1`, [SRV]);
    await q(`DELETE FROM servers WHERE _id = $1`, [SRV]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };

  beforeEach(async () => {
    await cleanup();
    mockPushes.length = 0;
    for (const id of [AUTHOR, BOB]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
    // Bob owns the server, so he can view the channel without a role setup.
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', $2, 1)`, [SRV, BOB]);
    for (const id of [AUTHOR, BOB]) {
      await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [id, SRV]);
    }
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'general', 1)`, [CH, SRV]);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const [key, pending] of __pendingPushForTest) {
      if (key.startsWith(`${P}-`)) { if (pending.timer) clearTimeout(pending.timer); __pendingPushForTest.delete(key); }
    }
  });
  afterAll(cleanup);

  it('a mention processed twice at once is stored once, announced once, counted once', async () => {
    const msg = {
      _id: MSG, channelId: CH, serverId: SRV, userId: AUTHOR, username: AUTHOR, displayName: 'Author',
      content: `hey <@${BOB}>, look at this`, createdAt: Date.now(),
    };
    await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
             VALUES ($1, $2, $3, $4, $4, 'Author', $5, $6)`, [MSG, CH, SRV, AUTHOR, msg.content, msg.createdAt]);
    const emitted: Array<{ room: string; event: string }> = [];
    const io = { to: (room: string) => ({ emit: (event: string) => { emitted.push({ room, event }); } }) };

    const race = raceTheExistenceChecks(2);
    await Promise.all([processNotifications(msg, io, new Map()), processNotifications(msg, io, new Map())]);

    expect(race.prechecks).toEqual([null, null]);
    expect(await inboxRows(BOB)).toEqual([{ _id: `inbox:${BOB}:${MSG}`, type: 'mention' }]);
    const toBob = emitted.filter(e => e.room === `user:${BOB}`).map(e => e.event).sort();
    expect(toBob).toEqual(['inbox:changed', 'notification:mention']);
    expect(__pendingPushForTest.get(`${BOB}:${CH}`)?.count).toBe(1);
    const unread = await q(`SELECT count FROM unread_counts WHERE "userId" = $1 AND "channelId" = $2`, [BOB, CH]);
    expect(unread.map(r => Number(r.count))).toEqual([1]);
  });

  it('two concurrent writes of the same channel attention: exactly one reports that it stored the row', async () => {
    const race = raceTheExistenceChecks(2);
    const attention = { userId: BOB, type: 'mention' as const, serverId: SRV, channelId: CH, messageId: MSG, actorId: AUTHOR };
    const results = await Promise.all([
      Notifications.insertChannelAttention(attention),
      Notifications.insertChannelAttention(attention),
    ]);
    expect(race.prechecks).toEqual([null, null]);
    expect(results.sort()).toEqual([false, true]);
    expect(await inboxRows(BOB)).toHaveLength(1);
    // A later retry finds the row and stores nothing.
    await expect(Notifications.insertChannelAttention(attention)).resolves.toBe(false);
  });

  it('two concurrent writes of the same saved reminder: exactly one reports that it stored the row', async () => {
    const race = raceTheExistenceChecks(2);
    const results = await Promise.all([
      Notifications.insertSavedReminder(BOB, `saved:${BOB}:channel:${MSG}`, 1_790_000_000_000),
      Notifications.insertSavedReminder(BOB, `saved:${BOB}:channel:${MSG}`, 1_790_000_000_000),
    ]);
    expect(race.prechecks).toEqual([null, null]);
    expect(results.sort()).toEqual([false, true]);
    expect(await inboxRows(BOB)).toEqual([{ _id: `inbox:saved-reminder:${BOB}:saved:${BOB}:channel:${MSG}:1790000000000`, type: 'saved_reminder' }]);
  });

  it('a write failure that is not a duplicate still rejects, and nothing is stored', async () => {
    const broken = { userId: BOB, type: 'mention' as const, serverId: SRV, channelId: CH, messageId: MSG, actorId: AUTHOR, createdAt: Number.NaN };
    await expect(Notifications.insertChannelAttention(broken)).rejects.toMatchObject({ code: '22P02' });
    expect(await inboxRows(BOB)).toEqual([]);
  });
});
