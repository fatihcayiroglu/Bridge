// server/tests/pg-integration/thread-reply-idempotency.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: A THREAD REPLY SENT TWICE (RETRY, DOUBLE TAP, RECONNECT)
// IS STORED ONCE
// ════════════════════════════════════════════════════════════════════════════
// `Threads.insertMessageIdempotent` first looks for an existing reply with the
// sender's client nonce. Two requests that arrive together both find nothing
// and both insert; the partial unique index
// `uq_thread_messages_delivery_nonce ("threadId","userId","clientNonce")`
// rejects the loser with 23505, and the loser must answer with the WINNER's
// row instead of failing. That recovery path only exists on PostgreSQL; the
// in-memory unit DB has no unique index, so it had never run. Proven here:
//   - N concurrent sends with one nonce store one row; every caller gets that
//     row; exactly one reports `created: true`;
//   - the nonce is scoped per thread and per sender (same nonce elsewhere is
//     a different reply);
//   - a reply without a nonce is never deduplicated;
//   - a failure that is NOT a uniqueness conflict is rethrown, not swallowed;
//   - if the winning reply is deleted (thread removed) before the loser can
//     read it, the loser reports the conflict instead of answering with nothing;
//   - end to end through `POST /api/threads/:threadId/messages`: concurrent
//     retries of one reply all answer with the same message, and the thread's
//     reply counter, the parent message's thread counter and the realtime
//     `thread:message:new` event move exactly ONCE.
//
// HOW THE RACE IS MADE CERTAIN: left alone, concurrent requests only SOMETIMES
// miss each other's row (a request that starts a little later finds the first
// one's reply and never reaches the conflict path). `raceThePrechecks(n)`
// holds each request's REAL existence check (it runs on PostgreSQL) until all
// n of them have read, so all n miss each other and insert together, and n-1
// of them really meet the unique index. Nothing is stubbed: every lookup and
// insert reaches the database.

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown }, _res: unknown, next: () => void) => { req.user = { id: 'pgt-thrnonce-alice' }; next(); },
}));

import express from 'express';
import request from 'supertest';
import { Threads } from '../../db/repositories';

const db = require('../../db/loader').default;
const threadsRouter = require('../../routes/threads');

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-thrnonce';
const T1 = `${P}-thread-1`;
const T2 = `${P}-thread-2`;
const ALICE = `${P}-alice`;
const BOB = `${P}-bob`;

type Lookup = (threadId: string, userId: string, clientNonce: string) => Promise<unknown>;

function raceThePrechecks(n: number, beforeReread?: () => Promise<void>) {
  const real: Lookup = Threads.findMessageByClientNonce.bind(Threads);
  const precheckResults: unknown[] = [];
  let started = 0;
  let release!: () => void;
  const allRead = new Promise<void>(resolve => { release = resolve; });
  // A request that never arrives must fail the test, not hang it.
  const giveUp = setTimeout(release, 5_000);
  jest.spyOn(Threads, 'findMessageByClientNonce').mockImplementation((async (threadId, userId, clientNonce) => {
    if (++started <= n) {
      const found = await real(threadId, userId, clientNonce);
      precheckResults.push(found);
      if (precheckResults.length === n) { clearTimeout(giveUp); release(); }
      await allRead;
      return found;
    }
    if (beforeReread) await beforeReread();
    return real(threadId, userId, clientNonce);
  }) as Lookup as never);
  return { precheckResults };
}

afterEach(() => { jest.restoreAllMocks(); });

RUN('real PostgreSQL — thread reply idempotency', () => {
  const q = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    await q(`DELETE FROM thread_messages WHERE "threadId" LIKE $1`, [`${P}-%`]);
  };
  const reply = (threadId: string, userId: string, clientNonce: string | null, content = 'hello') => ({
    threadId, channelId: `${P}-ch`, serverId: `${P}-srv`, userId,
    username: userId, displayName: userId, avatarColor: '#2d9cdb',
    content, clientNonce, type: 'normal', reactions: {}, createdAt: Date.now(),
  });
  const rows = async (threadId: string) =>
    q(`SELECT _id, "userId", "clientNonce", content FROM thread_messages WHERE "threadId" = $1 ORDER BY "createdAt", _id`, [threadId]);

  beforeEach(cleanup);
  afterAll(cleanup);

  it('eight concurrent sends with one nonce store one reply; every caller gets that reply, one reports created', async () => {
    const race = raceThePrechecks(8);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => Threads.insertMessageIdempotent(reply(T1, ALICE, 'nonce-1', `attempt ${i}`))),
    );
    // Every request missed the others before inserting: seven met the index.
    expect(race.precheckResults).toEqual(Array(8).fill(null));
    const stored = await rows(T1);
    expect(stored).toHaveLength(1);
    expect(results.filter(r => r.created)).toHaveLength(1);
    for (const r of results) expect((r.message as { _id: string })._id).toBe(stored[0]._id);
    // The stored content is the winner's; later attempts do not overwrite it.
    const winner = results.find(r => r.created)!;
    expect(stored[0].content).toBe((winner.message as { content: string }).content);
  });

  it('a retry after the first send completed returns the stored reply without inserting', async () => {
    const first = await Threads.insertMessageIdempotent(reply(T1, ALICE, 'nonce-2', 'original'));
    const retry = await Threads.insertMessageIdempotent(reply(T1, ALICE, 'nonce-2', 'retry text'));
    expect(first.created).toBe(true);
    expect(retry).toEqual({ message: expect.objectContaining({ _id: (first.message as { _id: string })._id }), created: false });
    expect((await rows(T1)).map(r => r.content)).toEqual(['original']);
  });

  it('the same nonce from another sender, or in another thread, is a different reply', async () => {
    await Promise.all([
      Threads.insertMessageIdempotent(reply(T1, ALICE, 'shared-nonce')),
      Threads.insertMessageIdempotent(reply(T1, BOB, 'shared-nonce')),
      Threads.insertMessageIdempotent(reply(T2, ALICE, 'shared-nonce')),
    ]);
    expect((await rows(T1)).map(r => r.userId).sort()).toEqual([ALICE, BOB]);
    expect(await rows(T2)).toHaveLength(1);
  });

  it('replies without a nonce are never deduplicated', async () => {
    const results = await Promise.all([
      Threads.insertMessageIdempotent(reply(T1, ALICE, null)),
      Threads.insertMessageIdempotent(reply(T1, ALICE, null)),
    ]);
    expect(results.every(r => r.created)).toBe(true);
    expect(await rows(T1)).toHaveLength(2);
  });

  it('a failure that is not a uniqueness conflict is rethrown, and nothing is stored', async () => {
    const broken = { ...reply(T1, ALICE, 'nonce-3'), username: null }; // violates NOT NULL (23502)
    await expect(Threads.insertMessageIdempotent(broken)).rejects.toMatchObject({ code: '23502' });
    expect(await rows(T1)).toHaveLength(0);
  });

  it('if the winning reply is deleted before the loser can read it, the loser reports the conflict instead of answering with nothing', async () => {
    // The thread is removed while a retry is in flight: the loser's re-read
    // finds no row, and must not answer as if a message existed.
    raceThePrechecks(2, async () => { await q(`DELETE FROM thread_messages WHERE "threadId" = $1`, [T1]); });
    const settled = await Promise.allSettled([
      Threads.insertMessageIdempotent(reply(T1, ALICE, 'nonce-5', 'a')),
      Threads.insertMessageIdempotent(reply(T1, ALICE, 'nonce-5', 'b')),
    ]);
    const won = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof Threads.insertMessageIdempotent>>> => r.status === 'fulfilled');
    const lost = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(won.map(r => r.value.created)).toEqual([true]);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: '23505' });
    expect(await rows(T1)).toHaveLength(0);
  });
});

RUN('real PostgreSQL — POST /api/threads/:threadId/messages retried concurrently', () => {
  const q = async (sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> => (await db._pool.query(sql, params)).rows;
  const SRV = `${P}-srv`;
  const CH = `${P}-ch`;
  const PARENT = `${P}-parent`;
  const TR = `${P}-thread-route`;
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = { to: (room: string) => ({ emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); } }) };
  const app = () => {
    const a = express();
    a.use(express.json());
    a.set('io', io);
    a.use('/api/threads', threadsRouter);
    return a;
  };
  const cleanup = async () => {
    await q(`DELETE FROM thread_messages WHERE "threadId" = $1`, [TR]);
    await q(`DELETE FROM threads WHERE _id = $1`, [TR]);
    await q(`DELETE FROM messages WHERE _id = $1`, [PARENT]);
    await q(`DELETE FROM channels WHERE _id = $1`, [CH]);
    await q(`DELETE FROM members WHERE "serverId" = $1`, [SRV]);
    await q(`DELETE FROM servers WHERE _id = $1`, [SRV]);
    await q(`DELETE FROM users WHERE _id = $1`, [ALICE]);
  };
  const counters = async () => ({
    replies: Number((await q(`SELECT "messageCount" FROM threads WHERE _id = $1`, [TR]))[0].messageCount),
    parentThreadCount: Number((await q(`SELECT "threadCount" FROM messages WHERE _id = $1`, [PARENT]))[0].threadCount),
    stored: (await q(`SELECT _id FROM thread_messages WHERE "threadId" = $1`, [TR])).length,
  });

  beforeEach(async () => {
    await cleanup();
    emitted.length = 0;
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [ALICE]);
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', $2, 1)`, [SRV, ALICE]);
    await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt") VALUES ($1, $2, '[]', 1)`, [ALICE, SRV]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'c', 1)`, [CH, SRV]);
    await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
             VALUES ($1, $2, $3, $4, $4, $4, 'parent', 1)`, [PARENT, CH, SRV, ALICE]);
    await q(`INSERT INTO threads (_id, "channelId", "serverId", "parentMessageId", name, "createdBy", "createdAt", "lastMessageAt", "messageCount")
             VALUES ($1, $2, $3, $4, 't', $5, 1, 1, 0)`, [TR, CH, SRV, PARENT, ALICE]);
  });
  afterAll(cleanup);

  const send = (clientNonce: string, content: string) =>
    request(app()).post(`/api/threads/${TR}/messages`).send({ content, clientNonce });

  it('six concurrent retries of one reply: one stored message, every response is it, counters and the realtime event move once', async () => {
    const race = raceThePrechecks(6);
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => send('route-nonce-0001', `reply ${i}`)));
    expect(race.precheckResults).toEqual(Array(6).fill(null));
    expect(responses.map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const ids = new Set(responses.map(r => r.body._id));
    expect(ids.size).toBe(1);
    expect(await counters()).toEqual({ replies: 1, parentThreadCount: 1, stored: 1 });
    const fanout = emitted.filter(e => e.event === 'thread:message:new');
    expect(fanout).toHaveLength(1);
    expect(fanout[0]).toMatchObject({ room: `thread:${TR}`, payload: { threadId: TR, msg: { _id: [...ids][0] } } });
  });

  it('a retry after the reply was stored answers with the stored reply and changes nothing', async () => {
    const first = await send('route-nonce-0002', 'original');
    const retry = await send('route-nonce-0002', 'edited before retry');
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ _id: first.body._id, content: 'original' });
    expect(await counters()).toEqual({ replies: 1, parentThreadCount: 1, stored: 1 });
    expect(emitted.filter(e => e.event === 'thread:message:new')).toHaveLength(1);
  });

  it('two different nonces are two replies and move the counters twice', async () => {
    await Promise.all([send('route-nonce-0003', 'one'), send('route-nonce-0004', 'two')]);
    expect(await counters()).toEqual({ replies: 2, parentThreadCount: 2, stored: 2 });
    expect(emitted.filter(e => e.event === 'thread:message:new')).toHaveLength(2);
  });
});
