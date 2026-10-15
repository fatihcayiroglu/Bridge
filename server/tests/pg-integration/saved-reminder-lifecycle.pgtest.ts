// server/tests/pg-integration/saved-reminder-lifecycle.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: A SAVED-MESSAGE REMINDER, FROM "REMIND ME" TO THE INBOX
// ════════════════════════════════════════════════════════════════════════════
// A user saves a message and asks to be reminded later. The reminder job then
// writes a personal inbox row and sends one push; the inbox shows it until the
// user reads it. Every unit test of this flow replaces the Saved and
// Notification repositories with mocks, so the queries that scope each step to
// its owner (`setReminder`, `clearReminder`, `findByIdForUser`,
// `markSavedReminderRead`), the due-reminder query and the conditional
// "delivered" write had never run against a database. Proven here, through
// the real routes and the real job:
//   - only the owner can set or clear a reminder on a saved item, both at the
//     route and in the repository behind it;
//   - a due reminder is delivered once (one inbox row, one push, delivery
//     recorded); a later one waits; a second tick delivers nothing new;
//     delivered reminders never crowd a due one out of the job's batch;
//   - two server instances delivering the same reminder at once create ONE
//     inbox row, record ONE delivery and send ONE push;
//   - a reminder rescheduled while it is being delivered is not recorded as
//     delivered and sends no push; the new time is delivered later;
//   - only the owner sees the reminder in the inbox and can mark it read, and
//     "read all" only touches the caller's reminders;
//   - a reminder whose saved item was deleted is retired from the inbox, and
//     another user cannot delete someone else's saved item.
//
// Only the push transport is replaced (it would reach the network): the test
// records each push the job sends. Requests carry the caller's id in a test
// header in place of a session token.

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { headers: Record<string, unknown>; user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: String(req.headers['x-test-user'] ?? '') };
    next();
  },
}));
const mockPushes: Array<{ userId: string; savedId: unknown }> = [];
jest.mock('../../lib/pushSender', () => ({
  sendPushToUser: async (userId: string, payload: { data?: { savedId?: unknown } }) => {
    mockPushes.push({ userId, savedId: payload?.data?.savedId });
  },
}));

import express from 'express';
import request from 'supertest';
import { Notifications, SavedMessages } from '../../db/repositories';
import { runSavedMessageReminderTick } from '../../jobs/savedMessageReminders';

const db = require('../../db/loader').default;
const savedRouter = require('../../routes/saved').default;
const inboxRouter = require('../../routes/inbox').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-rem';
const ALICE = `${P}-alice`;
const BOB = `${P}-bob`;
const SRV = `${P}-srv`;
const CH = `${P}-ch`;
const M1 = `${P}-m1`;
const M2 = `${P}-m2`;

RUN('real PostgreSQL — saved-message reminders from "remind me" to the inbox', () => {
  let otherDb: { _pool?: { end(): Promise<void> } } | null = null;
  const q = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await db._pool.query(sql, params)).rows;
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use('/api/saved', savedRouter);
    a.use('/api/inbox', inboxRouter);
    return a;
  };
  const as = (userId: string) => ({
    get: (url: string) => request(app()).get(url).set('x-test-user', userId),
    post: (url: string, body: unknown) => request(app()).post(url).set('x-test-user', userId).send(body as object),
    put: (url: string, body: unknown) => request(app()).put(url).set('x-test-user', userId).send(body as object),
    patch: (url: string) => request(app()).patch(url).set('x-test-user', userId).send({}),
    del: (url: string) => request(app()).delete(url).set('x-test-user', userId),
  });
  const enc = encodeURIComponent;
  const savedRow = async (id: string) => (await q(`SELECT "remindAt", "remindedAt" FROM saved_messages WHERE _id = $1`, [id]))[0];
  const reminderRows = async (userId: string) =>
    q(`SELECT _id, read FROM notifications WHERE "userId" = $1 AND type = 'saved_reminder' ORDER BY _id`, [userId]);
  const save = async (messageId: string) => {
    const res = await as(ALICE).post('/api/saved', { destinationType: 'channel', destinationId: CH, messageId });
    expect(res.status).toBe(201);
    return String(res.body.id);
  };
  const remindIn = async (id: string, ms: number) => {
    const remindAt = Date.now() + ms;
    const res = await as(ALICE).put(`/api/saved/${enc(id)}/reminder`, { remindAt });
    expect(res.status).toBe(200);
    return remindAt;
  };

  const cleanup = async () => {
    await q(`DELETE FROM notifications WHERE "userId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM saved_messages WHERE "userId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM channels WHERE _id = $1`, [CH]);
    await q(`DELETE FROM members WHERE "serverId" = $1`, [SRV]);
    await q(`DELETE FROM servers WHERE _id = $1`, [SRV]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };

  beforeEach(async () => {
    await cleanup();
    mockPushes.length = 0;
    for (const id of [ALICE, BOB]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', $2, 1)`, [SRV, ALICE]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [ALICE, SRV]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'c', 1)`, [CH, SRV]);
    for (const id of [M1, M2]) {
      await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
               VALUES ($1, $2, $3, $4, $4, $4, 'remember this', 1)`, [id, CH, SRV, ALICE]);
    }
  });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => {
    await cleanup();
    await otherDb?._pool?.end();
  });

  it('a reminder is set and cleared only on the caller\'s own saved item', async () => {
    const id = await save(M1);
    const remindAt = Date.now() + 60_000;

    const bobSets = await as(BOB).put(`/api/saved/${enc(id)}/reminder`, { remindAt });
    expect(bobSets.status).toBe(404);
    expect(await savedRow(id)).toEqual({ remindAt: null, remindedAt: null });

    const aliceSets = await as(ALICE).put(`/api/saved/${enc(id)}/reminder`, { remindAt });
    expect(aliceSets.status).toBe(200);
    expect(await savedRow(id)).toEqual({ remindAt, remindedAt: null });

    const bobClears = await as(BOB).put(`/api/saved/${enc(id)}/reminder`, { remindAt: null });
    expect(bobClears.status).toBe(404);
    expect(await savedRow(id)).toEqual({ remindAt, remindedAt: null });

    const aliceClears = await as(ALICE).put(`/api/saved/${enc(id)}/reminder`, { remindAt: null });
    expect(aliceClears.status).toBe(200);
    expect(await savedRow(id)).toEqual({ remindAt: null, remindedAt: null });
  });

  it('the repository itself never changes another user\'s saved item (a second line behind the route check)', async () => {
    const id = await save(M1);
    const remindAt = await remindIn(id, 60_000);

    expect(await SavedMessages.setReminder(BOB, id, remindAt + 1)).toEqual({ updated: 0 });
    expect(await SavedMessages.clearReminder(BOB, id)).toEqual({ updated: 0 });
    expect(await SavedMessages.findByIdForUser(BOB, id)).toBeNull();
    expect(await savedRow(id)).toEqual({ remindAt, remindedAt: null });
  });

  it('the job delivers a due reminder once — one inbox row, one push, delivery recorded — and a later reminder waits', async () => {
    const due = await save(M1);
    const later = await save(M2);
    const dueAt = await remindIn(due, 10_000);
    const laterAt = await remindIn(later, 3_600_000);
    const now = dueAt + 1;

    await runSavedMessageReminderTick(now);
    expect(mockPushes).toEqual([{ userId: ALICE, savedId: due }]);
    expect(await reminderRows(ALICE)).toEqual([{ _id: `inbox:saved-reminder:${ALICE}:${due}:${dueAt}`, read: false }]);
    expect(await savedRow(due)).toEqual({ remindAt: dueAt, remindedAt: now });
    expect(await savedRow(later)).toEqual({ remindAt: laterAt, remindedAt: null });

    // A second tick at the same moment finds nothing left to deliver.
    await runSavedMessageReminderTick(now);
    expect(mockPushes).toHaveLength(1);
    expect(await reminderRows(ALICE)).toHaveLength(1);
  });

  it('reminders already delivered never crowd out a due one (the job reads 100 due reminders per tick)', async () => {
    // 100 older reminders, all already delivered, sort before the due one.
    const base = Date.now() - 3_600_000;
    await q(
      `INSERT INTO saved_messages (_id, "userId", "destinationType", "destinationId", "messageId", "createdAt", "remindAt", "remindedAt")
       SELECT 'saved:' || $1 || ':channel:old-' || i, $1, 'channel', $2, 'old-' || i, 1, $3::bigint + i, $3::bigint + i + 1
       FROM generate_series(1, 100) AS i`,
      [ALICE, CH, base],
    );
    const id = await save(M1);
    const remindAt = await remindIn(id, 10_000);

    await runSavedMessageReminderTick(remindAt + 1);
    expect(mockPushes).toEqual([{ userId: ALICE, savedId: id }]);
    expect(await savedRow(id)).toEqual({ remindAt, remindedAt: remindAt + 1 });
  });

  it('two server instances delivering the same due reminder at once create one inbox row, record one delivery and send one push', async () => {
    const id = await save(M1);
    const remindAt = await remindIn(id, 10_000);
    const now = remindAt + 1;

    // A second, independent copy of the job and its repositories (as on a
    // second server instance), with its own connection pool to the same DB.
    let otherTick!: typeof runSavedMessageReminderTick;
    let otherSaved!: typeof SavedMessages;
    jest.isolateModules(() => {
      otherTick = require('../../jobs/savedMessageReminders').runSavedMessageReminderTick;
      otherSaved = require('../../db/repositories').SavedMessages;
      otherDb = require('../../db/loader').default;
    });

    // Hold each instance's REAL due-reminder query until both have read, so
    // both pick up the same reminder before either records the delivery.
    const found: unknown[][] = [];
    let release!: () => void;
    const bothRead = new Promise<void>(resolve => { release = resolve; });
    const giveUp = setTimeout(release, 5_000);
    for (const repo of [SavedMessages, otherSaved]) {
      const real = repo.findDueReminders.bind(repo);
      jest.spyOn(repo, 'findDueReminders').mockImplementationOnce(async (clock: number, limit?: number) => {
        const rows = await real(clock, limit);
        found.push(rows.map(r => r._id));
        if (found.length === 2) { clearTimeout(giveUp); release(); }
        await bothRead;
        return rows;
      });
    }

    await Promise.all([runSavedMessageReminderTick(now), otherTick(now)]);
    expect(found).toEqual([[id], [id]]);
    expect(await reminderRows(ALICE)).toEqual([{ _id: `inbox:saved-reminder:${ALICE}:${id}:${remindAt}`, read: false }]);
    expect(await savedRow(id)).toEqual({ remindAt, remindedAt: now });
    expect(mockPushes).toEqual([{ userId: ALICE, savedId: id }]);
  });

  it('a reminder rescheduled while it is being delivered is not recorded as delivered and sends no push; the new time is delivered later', async () => {
    const id = await save(M1);
    const firstAt = await remindIn(id, 10_000);
    let secondAt = 0;

    // The user moves the reminder after the job has written the inbox row and
    // before it records the delivery.
    const realInsert = Notifications.insertSavedReminder.bind(Notifications);
    jest.spyOn(Notifications, 'insertSavedReminder').mockImplementationOnce(async (userId, savedId, remindAt) => {
      const result = await realInsert(userId, savedId, remindAt);
      secondAt = await remindIn(id, 120_000);
      return result;
    });

    await runSavedMessageReminderTick(firstAt + 1);
    expect(mockPushes).toEqual([]);
    expect(await savedRow(id)).toEqual({ remindAt: secondAt, remindedAt: null });

    await runSavedMessageReminderTick(secondAt + 1);
    expect(mockPushes).toEqual([{ userId: ALICE, savedId: id }]);
    expect(await savedRow(id)).toEqual({ remindAt: secondAt, remindedAt: secondAt + 1 });
    expect((await reminderRows(ALICE)).map(r => r._id)).toEqual([
      `inbox:saved-reminder:${ALICE}:${id}:${firstAt}`,
      `inbox:saved-reminder:${ALICE}:${id}:${secondAt}`,
    ]);
  });

  it('only the owner sees a delivered reminder in the inbox and can mark it read; "read all" only touches the caller', async () => {
    const id = await save(M1);
    const remindAt = await remindIn(id, 10_000);
    await runSavedMessageReminderTick(remindAt + 1);
    const reminderId = `inbox:saved-reminder:${ALICE}:${id}:${remindAt}`;

    const aliceInbox = await as(ALICE).get('/api/inbox?filter=reminders');
    expect(aliceInbox.status).toBe(200);
    expect(aliceInbox.body.items).toEqual([expect.objectContaining({
      id: reminderId, kind: 'reminder', destination: { type: 'saved', savedId: id },
    })]);
    const bobInbox = await as(BOB).get('/api/inbox?filter=reminders');
    expect(bobInbox.status).toBe(200);
    expect(bobInbox.body.items).toEqual([]);

    // Another user's mark-read answers like any other, but changes nothing.
    expect((await as(BOB).patch(`/api/inbox/${enc(reminderId)}/read`)).status).toBe(200);
    expect(await reminderRows(ALICE)).toEqual([{ _id: reminderId, read: false }]);
    expect((await as(BOB).patch('/api/inbox/read-all')).status).toBe(200);
    expect(await reminderRows(ALICE)).toEqual([{ _id: reminderId, read: false }]);

    expect((await as(ALICE).patch(`/api/inbox/${enc(reminderId)}/read`)).status).toBe(200);
    expect(await reminderRows(ALICE)).toEqual([{ _id: reminderId, read: true }]);
    expect((await as(ALICE).get('/api/inbox?filter=reminders')).body.items).toEqual([]);
  });

  it('"read all" marks every unread reminder of the caller as read', async () => {
    const first = await save(M1);
    const second = await save(M2);
    const firstAt = await remindIn(first, 10_000);
    const secondAt = await remindIn(second, 20_000);
    await runSavedMessageReminderTick(secondAt + 1);
    expect((await reminderRows(ALICE)).map(r => r.read)).toEqual([false, false]);
    expect(firstAt).toBeLessThan(secondAt);

    expect((await as(ALICE).patch('/api/inbox/read-all')).status).toBe(200);
    expect((await reminderRows(ALICE)).map(r => r.read)).toEqual([true, true]);
  });

  it('a reminder whose saved item was deleted is retired from the inbox; another user cannot delete the saved item', async () => {
    const id = await save(M1);
    const remindAt = await remindIn(id, 10_000);
    await runSavedMessageReminderTick(remindAt + 1);
    const reminderId = `inbox:saved-reminder:${ALICE}:${id}:${remindAt}`;

    expect((await as(BOB).del(`/api/saved/${enc(id)}`)).status).toBe(204);
    expect(await savedRow(id)).toBeDefined();
    expect((await as(ALICE).get('/api/inbox?filter=reminders')).body.items).toHaveLength(1);

    expect((await as(ALICE).del(`/api/saved/${enc(id)}`)).status).toBe(204);
    expect(await savedRow(id)).toBeUndefined();
    const inbox = await as(ALICE).get('/api/inbox?filter=reminders');
    expect(inbox.body.items).toEqual([]);
    expect(await reminderRows(ALICE)).toEqual([{ _id: reminderId, read: true }]);
  });
});
