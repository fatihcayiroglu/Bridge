import '../helpers/realRedisFixture';

/** Real PostgreSQL + HTTP evidence for thread/forum parent-channel expiry. */
jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: unknown; headers: Record<string, unknown> }, _res: unknown, next: () => void) => {
    const caller = req.headers['x-test-user'];
    req.user = { id: typeof caller === 'string' ? caller : OWNER };
    next();
  },
}));

import express from 'express';
import request from 'supertest';

const db = require('../../db/loader').default;
const threadsRouter = require('../../routes/threads');
const RUN = process.env.PG_TEST_URL ? describe : describe.skip;
const STEM = 'pgt-d2-thread-read-' + process.pid + '-' + Date.now();
const OWNER = STEM + '-owner';
const OTHER_OWNER = STEM + '-other-owner';
const SERVER = STEM + '-server';
const OTHER_SERVER = STEM + '-other-server';
const CHANNEL = STEM + '-channel';
const THREAD = STEM + '-thread';
const REPLY = STEM + '-reply';
const PARENT = STEM + '-parent';
const NEW_PARENT = STEM + '-new-parent';
const NONCE = STEM + '-stored-nonce';
const TITLE = 'private forum title ' + STEM;
const PREVIEW = 'private forum preview ' + STEM;
const BODY = 'private thread reply ' + STEM;
const PARENT_BODY = 'private parent body ' + STEM;

RUN('P7 D2 thread/forum reads — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);

  /**
   * A thread row whose server disagrees with its channel can no longer be
   * written (the D2 write barrier refuses tenant_mismatch). This models a row
   * that predates the barrier: the trigger is disabled only inside this one
   * transaction (ACCESS EXCLUSIVE; no other session ever sees it disabled).
   */
  async function legacyThreadServer(serverId: string, threadId: string): Promise<void> {
    const legacy = await db._pool.connect();
    try {
      await legacy.query('BEGIN');
      await legacy.query('ALTER TABLE threads DISABLE TRIGGER channel_write_barrier');
      await legacy.query('UPDATE threads SET "serverId"=$1 WHERE _id=$2', [serverId, threadId]);
      await legacy.query('ALTER TABLE threads ENABLE TRIGGER channel_write_barrier');
      await legacy.query('COMMIT');
    } catch (err) {
      await legacy.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      legacy.release();
    }
  }
  const app = express();
  app.use(express.json());
  app.use('/api/threads', threadsRouter);
  const paths = [
    '/api/threads/' + THREAD,
    '/api/threads/' + THREAD + '/messages',
    '/api/threads/channel/' + CHANNEL,
  ];

  async function cleanup() {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM thread_messages WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM threads WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM messages WHERE "channelId"=$1', [CHANNEL]);
    await q('DELETE FROM channels WHERE _id=$1', [CHANNEL]);
    await q('DELETE FROM members WHERE "serverId" IN ($1,$2)', [SERVER, OTHER_SERVER]);
    await q('DELETE FROM servers WHERE _id IN ($1,$2)', [SERVER, OTHER_SERVER]);
    await q('DELETE FROM users WHERE _id IN ($1,$2)', [OWNER, OTHER_OWNER]);
  }

  async function expectContentVisible() {
    const detail = await request(app).get(paths[0]);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ _id: THREAD, name: TITLE, firstMessage: PREVIEW });
    const messages = await request(app).get(paths[1]);
    expect(messages.status).toBe(200);
    expect(messages.body).toEqual(expect.arrayContaining([expect.objectContaining({ _id: REPLY, content: BODY })]));
    const listing = await request(app).get(paths[2]);
    expect(listing.status).toBe(200);
    expect(listing.body).toEqual(expect.arrayContaining([expect.objectContaining({ _id: THREAD, name: TITLE, firstMessage: PREVIEW })]));
  }

  async function expectContentDenied(status: number) {
    for (const path of paths) {
      const blocked = await request(app).get(path);
      expect({ path, status: blocked.status }).toEqual({ path, status });
      for (const secret of [TITLE, PREVIEW, BODY]) expect(JSON.stringify(blocked.body)).not.toContain(secret);
    }
  }

  beforeAll(async () => {
    await cleanup();
    for (const user of [OWNER, OTHER_OWNER]) {
      await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$2,$3,$4,1)',
        [user, user, 'Thread Owner', 'irrelevant']);
    }
    for (const [server, owner] of [[SERVER, OWNER], [OTHER_SERVER, OTHER_OWNER]]) {
      await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$2,$3,1)',
        [server, 'thread-expiry-server', owner]);
      await q('INSERT INTO members ("userId","serverId",roles,"joinedAt") VALUES ($1,$2,$3::jsonb,1)',
        [owner, server, '[]']);
    }
    await q('INSERT INTO channels (_id,"serverId",name,type,"createdAt") VALUES ($1,$2,$3,$4,1)',
      [CHANNEL, SERVER, 'expiry-forum', 'forum']);
    for (const parent of [PARENT, NEW_PARENT]) {
      await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt")' +
        ' VALUES ($1,$2,$3,$4,$5,$6,$7,1)', [parent, CHANNEL, SERVER, OWNER, OWNER, 'Thread Owner', PARENT_BODY]);
    }
    await q('INSERT INTO threads (_id,"channelId","serverId","parentMessageId",name,"firstMessage","createdBy","createdAt","lastMessageAt","messageCount")' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,1,1,1)', [THREAD, CHANNEL, SERVER, PARENT, TITLE, PREVIEW, OWNER]);
    await q('INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"clientNonce","createdAt")' +
      ' VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1)', [REPLY, THREAD, CHANNEL, SERVER, OWNER, OWNER, 'Thread Owner', BODY, NONCE]);
  });
  beforeEach(async () => {
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [CHANNEL]);
    await q('UPDATE channels SET "expiresAt"=NULL,"expiryVersion"=0 WHERE _id=$1', [CHANNEL]);
    // A legacy tenant-mismatched row is frozen by the barrier (OLD is checked too), so the
    // tenant case's corruption is undone the same way it was made.
    await legacyThreadServer(SERVER, THREAD);
    await q('DELETE FROM thread_messages WHERE "channelId"=$1 AND _id<>$2', [CHANNEL, REPLY]);
    await q('DELETE FROM threads WHERE "channelId"=$1 AND _id<>$2', [CHANNEL, THREAD]);
  });
  afterAll(cleanup);

  it('preserves permanent-channel titles, previews and replies', expectContentVisible);

  it('preserves a new parent thread and its canonical duplicate response', async () => {
    const created = await request(app).post('/api/threads').send({ parentMessageId: NEW_PARENT });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      channelId: CHANNEL, serverId: SERVER, parentMessageId: NEW_PARENT, name: PARENT_BODY.slice(0, 50),
    });
    const duplicate = await request(app).post('/api/threads').send({ parentMessageId: NEW_PARENT });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.thread).toMatchObject({ _id: created.body._id, channelId: CHANNEL, serverId: SERVER, parentMessageId: NEW_PARENT });
    const stored = await q('SELECT COUNT(*)::int AS total FROM threads WHERE "parentMessageId"=$1', [NEW_PARENT]);
    expect(stored.rows[0].total).toBe(1);
  });

  it('denies every thread/forum read once PostgreSQL marks the parent channel expired', async () => {
    await expectContentVisible();
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2', [Date.now() - 1000, CHANNEL]);
    await expectContentDenied(404);
  });

  it('denies every thread/forum read when a durable tombstone exists for a future-dated channel', async () => {
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() + 120_000, CHANNEL]);
    await expectContentVisible();
    await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")' +
      ' VALUES ($1,$2,$3,1,$4,$5)', [CHANNEL, SERVER, Date.now() - 1000, Date.now(), 'pending']);
    await expectContentDenied(404);
  });

  it('verifies canonical channel tenant even when the thread names a different server', async () => {
    await expectContentVisible();
    await legacyThreadServer(OTHER_SERVER, THREAD);
    for (const path of paths.slice(0, 2)) {
      // This caller owns the server recorded on the stale thread. That
      // permission cannot authorize a channel owned by the canonical tenant.
      const blocked = await request(app).get(path).set('X-Test-User', OTHER_OWNER);
      expect({ path, status: blocked.status }).toEqual({ path, status: 404 });
      for (const secret of [TITLE, PREVIEW, BODY]) expect(JSON.stringify(blocked.body)).not.toContain(secret);
    }
    const listing = await request(app).get(paths[2]).set('X-Test-User', OTHER_OWNER);
    expect(listing.status).toBe(403);
    expect(JSON.stringify(listing.body)).not.toContain(TITLE);
    const duplicate = await request(app).post('/api/threads').send({ parentMessageId: PARENT });
    expect(duplicate.status).toBe(404);
    for (const secret of [TITLE, PREVIEW]) expect(JSON.stringify(duplicate.body)).not.toContain(secret);
  });

  it.each(['expired', 'tombstoned'])('denies stored-content POST replays and fresh creation when the parent is %s', async lifecycle => {
    const duplicate = await request(app).post('/api/threads').send({ parentMessageId: PARENT });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.thread).toMatchObject({ _id: THREAD, name: TITLE, firstMessage: PREVIEW });
    const replay = await request(app).post('/api/threads/' + THREAD + '/messages')
      .send({ content: 'ignored retry body', clientNonce: NONCE });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ _id: REPLY, content: BODY });
    const forumBody = { channelId: CHANNEL, name: 'New forum title ' + STEM, firstMessage: 'New forum preview ' + STEM };
    const forum = await request(app).post('/api/threads').send(forumBody);
    expect(forum.status).toBe(201);
    expect(forum.body.thread).toMatchObject({ name: forumBody.name, firstMessage: forumBody.firstMessage });

    const counts = async () => (await q('SELECT' +
      ' (SELECT COUNT(*)::int FROM threads WHERE "channelId"=$1) AS threads,' +
      ' (SELECT COUNT(*)::int FROM thread_messages WHERE "channelId"=$1) AS replies', [CHANNEL])).rows[0];
    const before = await counts();
    expect(before).toEqual({ threads: 2, replies: 2 });
    if (lifecycle === 'expired') {
      await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=1 WHERE _id=$2', [Date.now() - 1000, CHANNEL]);
    } else {
      await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() + 120_000, CHANNEL]);
      await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")' +
        ' VALUES ($1,$2,$3,1,$4,$5)', [CHANNEL, SERVER, Date.now() - 1000, Date.now(), 'pending']);
    }

    const attempts = [
      { path: '/api/threads', body: { parentMessageId: PARENT } },
      { path: '/api/threads', body: { parentMessageId: NEW_PARENT } },
      { path: '/api/threads', body: forumBody },
      { path: '/api/threads/' + THREAD + '/messages', body: { content: 'ignored retry body', clientNonce: NONCE } },
      { path: '/api/threads/' + THREAD + '/messages', body: { content: 'new reply', clientNonce: NONCE + '-fresh' } },
    ];
    for (const { path, body } of attempts) {
      const blocked = await request(app).post(path).send(body);
      expect({ path, status: blocked.status }).toEqual({ path, status: 404 });
      for (const secret of [TITLE, PREVIEW, BODY, PARENT_BODY, forumBody.name, forumBody.firstMessage]) {
        expect(JSON.stringify(blocked.body)).not.toContain(secret);
      }
    }
    expect(await counts()).toEqual(before);
  });
});
