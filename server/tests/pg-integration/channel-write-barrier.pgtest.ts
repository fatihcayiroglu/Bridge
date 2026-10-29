/**
 * P7 D2: real PostgreSQL proof of the channel write barrier (migration 086).
 *
 * Expiry is seeded through SQL because no public API creates ephemeral
 * channels yet. Races use separate pooled clients and explicit transactions;
 * the expiry worker is modelled by its required lock discipline
 * (SELECT ... FOR UPDATE, tombstone, graph delete, channel delete, COMMIT).
 */
import type { PoolClient } from 'pg';

const db = require('../../db/loader').default;
const { Messages, Threads } = require('../../db/repositories');
const { Announcements } = require('../../db/repositories/AnnouncementRepository');
const { isChannelWriteDenied } = require('../../lib/channelWriteBarrier');

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-wb-' + process.pid + '-' + Date.now();
const SERVER = P + '-server';
const OTHER = P + '-other-server';
const USER = P + '-user';
let seq = 0;
const id = (label: string) => `${P}-${label}-${++seq}`;

RUN('P7 D2 channel write barrier — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const count = async (channelId: string) =>
    Number((await q('SELECT COUNT(*)::int AS n FROM messages WHERE "channelId"=$1', [channelId])).rows[0].n);

  async function channel(label: string, opts: { expiresAt?: number | null; version?: number; serverId?: string } = {}) {
    const cid = id(label);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$3,1,$4,$5)',
      [cid, opts.serverId ?? SERVER, label, opts.expiresAt ?? null, opts.version ?? (opts.expiresAt ? 1 : 0)]);
    return cid;
  }
  function insertSql(client: { query: (sql: string, params: unknown[]) => Promise<unknown> }, channelId: string, serverId = SERVER, mid = id('m')) {
    return client.query(
      'INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [mid, channelId, serverId, USER, 'u', 'U', 'body', Date.now()]);
  }
  const later = () => Date.now() + 10 * 60_000;
  const earlier = () => Date.now() - 10 * 60_000;
  async function expectDenied(promise: Promise<unknown>) {
    let caught: unknown = null;
    try { await promise; } catch (err) { caught = err; }
    expect(isChannelWriteDenied(caught)).toBe(true);
  }
  async function tombstone(channelId: string, serverId = SERVER) {
    await q('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState")' +
      ' VALUES ($1,$2,$3,1,$4,$5)', [channelId, serverId, earlier(), Date.now(), 'pending']);
  }

  async function cleanup() {
    await q('DELETE FROM crosspost_log WHERE "targetChannelId" LIKE $1', [P + '%']).catch(() => undefined);
    await q('DELETE FROM thread_messages WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM threads WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM messages WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channels WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM servers WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  }

  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$2,$3,1)', [USER, 'U', 'x']);
    for (const s of [SERVER, OTHER]) await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [s, USER]);
  });
  afterAll(cleanup);

  it('is installed as ordinary (non-constraint, non-deferrable) triggers on every content table', async () => {
    const rows = (await q(`SELECT tgrelid::regclass::text AS tbl, tgconstraint <> 0 AS is_constraint, tgdeferrable
                             FROM pg_trigger WHERE tgname = 'channel_write_barrier' ORDER BY 1`)).rows;
    expect(rows).toEqual([
      { tbl: 'messages', is_constraint: false, tgdeferrable: false },
      { tbl: 'thread_messages', is_constraint: false, tgdeferrable: false },
      { tbl: 'threads', is_constraint: false, tgdeferrable: false },
      { tbl: 'voice_messages', is_constraint: false, tgdeferrable: false },
    ]);
  });

  it('allows permanent, active and legacy channel-less writes', async () => {
    const permanent = await channel('permanent');
    const active = await channel('active', { expiresAt: later() });
    await insertSql(db._pool, permanent);
    await insertSql(db._pool, active);
    await insertSql(db._pool, P + '-no-channel-row');
    expect(await count(permanent)).toBe(1);
    expect(await count(active)).toBe(1);
    expect(await count(P + '-no-channel-row')).toBe(1);
  });

  it('denies expired, tombstoned, tenant-mismatched and corrupt channels', async () => {
    const expired = await channel('expired', { expiresAt: earlier() });
    const tomb = await channel('tomb', { expiresAt: later() });
    await tombstone(tomb);
    const corrupt = await channel('corrupt', { expiresAt: later(), version: 0 });
    const foreign = await channel('foreign', { serverId: OTHER });
    const gone = P + '-deleted-with-tombstone';
    await tombstone(gone);
    for (const [cid, sid] of [[expired, SERVER], [tomb, SERVER], [corrupt, SERVER], [foreign, SERVER], [gone, SERVER]]) {
      await expectDenied(insertSql(db._pool, cid, sid));
      expect(await count(cid)).toBe(0);
    }
  });

  it('denies at the exact expiry boundary using the database clock', async () => {
    const soon = await channel('soon', { expiresAt: Date.now() + 1500 });
    await insertSql(db._pool, soon);
    await new Promise(r => setTimeout(r, 1700));
    await expectDenied(insertSql(db._pool, soon));
    expect(await count(soon)).toBe(1);
  });

  it('cannot be deferred or skipped with SET CONSTRAINTS (the #351 bypass does not apply)', async () => {
    const expired = await channel('setconstraints', { expiresAt: earlier() });
    const client: PoolClient = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await expectDenied(insertSql(client, expired));
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await expectDenied(insertSql(client, expired));
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await count(expired)).toBe(0);
  });

  it('denies idempotent ON CONFLICT replays into an expired channel', async () => {
    const cid = await channel('replay', { expiresAt: later() });
    const mid = id('replayed');
    await insertSql(db._pool, cid, SERVER, mid);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [earlier(), cid]);
    await expectDenied(q(
      'INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (_id) DO NOTHING',
      [mid, cid, SERVER, USER, 'u', 'U', 'body', Date.now()]));
  });

  it('guards content updates but leaves erasure, soft delete and DELETE possible', async () => {
    const cid = await channel('updates', { expiresAt: later() });
    const mid = id('edit');
    await insertSql(db._pool, cid, SERVER, mid);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [earlier(), cid]);
    await expectDenied(q('UPDATE messages SET content=$1 WHERE _id=$2', ['edited', mid]));
    await expectDenied(q('UPDATE messages SET reactions=$1::jsonb WHERE _id=$2', ['{"x":["u"]}', mid]));
    await expectDenied(q('UPDATE messages SET pinned=TRUE WHERE _id=$1', [mid]));
    await expectDenied(q('UPDATE messages SET "editHistory"=$1::jsonb WHERE _id=$2', ['[{"content":"x"}]', mid]));
    // Moving a row INTO an unavailable channel is a write to that channel.
    const live = await channel('move-source');
    const movable = id('movable');
    await insertSql(db._pool, live, SERVER, movable);
    await expectDenied(q('UPDATE messages SET "channelId"=$1 WHERE _id=$2', [cid, movable]));
    // Erasure-style housekeeping and the real soft-delete scrub stay possible.
    await q('UPDATE messages SET "displayName"=$1, "replyTo"=NULL WHERE _id=$2', ['Deleted user', mid]);
    await q(`UPDATE messages SET content='[Mesaj silindi]', "deletedAt"=$1, "deletedBy"=$2, embeds=NULL,
               "encryptedContent"=NULL, iv=NULL, "fileUrl"=NULL, "fileName"=NULL, "fileType"=NULL,
               "editHistory"='[]'::jsonb, transcript=NULL WHERE _id=$3`, [Date.now(), USER, mid]);
    // Once deleted, further payload edits are denied again.
    await expectDenied(q('UPDATE messages SET content=$1 WHERE _id=$2', ['resurrected', mid]));
    await q('DELETE FROM messages WHERE _id=$1', [mid]);
    expect(await count(cid)).toBe(0);
  });

  it('a soft delete or housekeeping column cannot carry other changes past the barrier', async () => {
    const cid = await channel('smuggle', { expiresAt: later() });
    const live = await channel('smuggle-live');
    const mid = id('smuggle-msg');
    const deleted = id('smuggle-deleted');
    const movable = id('smuggle-movable');
    await insertSql(db._pool, cid, SERVER, mid);
    await insertSql(db._pool, cid, SERVER, deleted);
    await insertSql(db._pool, live, SERVER, movable);
    await q(`INSERT INTO threads (_id,"channelId","serverId","parentMessageId",name,"createdBy","createdAt","lastMessageAt")
             VALUES ($1,$2,$3,$4,'t',$5,1,1)`, [id('thread'), cid, SERVER, mid, USER]);
    const threadId = (await q('SELECT _id FROM threads WHERE "channelId"=$1', [cid])).rows[0]._id;
    await q(`INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"createdAt")
             VALUES ($1,$2,$3,$4,$5,'u','U','reply',1)`, [id('reply'), threadId, cid, SERVER, USER]);
    await q(`UPDATE messages SET content='[Mesaj silindi]', "deletedAt"=$1, "deletedBy"=$2 WHERE _id=$3`,
      [Date.now(), USER, deleted]);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [earlier(), cid]);

    // Soft delete that also writes new content, reactions or a pin.
    await expectDenied(q('UPDATE messages SET "deletedAt"=$1, content=$2 WHERE _id=$3', [Date.now(), 'smuggled', mid]));
    await expectDenied(q(`UPDATE messages SET "deletedAt"=$1, reactions='{"x":["u"]}'::jsonb WHERE _id=$2`, [Date.now(), mid]));
    await expectDenied(q('UPDATE messages SET "deletedAt"=$1, pinned=TRUE WHERE _id=$2', [Date.now(), mid]));
    await expectDenied(q(`UPDATE messages SET "deletedAt"=$1, "editHistory"='[{"content":"old"}]'::jsonb WHERE _id=$2`, [Date.now(), mid]));
    // Soft delete that moves a live row into the expired channel.
    await expectDenied(q('UPDATE messages SET "deletedAt"=$1, "channelId"=$2 WHERE _id=$3', [Date.now(), cid, movable]));
    // Moving content OUT of an unavailable channel would let it escape cleanup.
    await expectDenied(q('UPDATE messages SET "channelId"=$1 WHERE _id=$2', [live, mid]));
    await expectDenied(q('UPDATE messages SET "deletedAt"=$1, "channelId"=$2 WHERE _id=$3', [Date.now(), live, mid]));
    await expectDenied(q('UPDATE thread_messages SET "channelId"=$1 WHERE "threadId"=$2', [live, threadId]));
    await expectDenied(q('UPDATE threads SET "channelId"=$1 WHERE _id=$2', [live, threadId]));
    // Undeleting a row on an unavailable channel.
    await expectDenied(q('UPDATE messages SET "deletedAt"=NULL, "deletedBy"=NULL WHERE _id=$1', [deleted]));
    // A reply snapshot is not a free-form payload slot.
    await expectDenied(q(`UPDATE messages SET "replyTo"='{"_id":"x","content":"smuggled"}'::jsonb WHERE _id=$1`, [mid]));
    // A derived vector of expired content may be cleared but never (re)written.
    const client: PoolClient = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding REAL[]');
      await client.query('SAVEPOINT s');
      await expectDenied(client.query(`UPDATE messages SET embedding='{1,2}' WHERE _id=$1`, [mid]));
      await client.query('ROLLBACK TO SAVEPOINT s');
      await client.query('UPDATE messages SET embedding=NULL WHERE _id=$1', [mid]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const rows = (await q('SELECT _id, content, "channelId", "deletedAt", pinned, reactions FROM messages WHERE _id = ANY($1)',
      [[mid, deleted, movable]])).rows;
    type Row = { _id: string; deletedAt: string | null };
    const byId = new Map<string, Row>(rows.map((r: Row) => [r._id, r]));
    expect(byId.get(mid)).toMatchObject({ content: 'body', channelId: cid, deletedAt: null, pinned: false });
    expect(byId.get(movable)).toMatchObject({ channelId: live, deletedAt: null });
    expect(byId.get(deleted)!.deletedAt).not.toBeNull();

    // Legitimate erasure paths on the same unavailable channel still work.
    await q(`UPDATE messages SET "username"='deleted', "displayName"='Deleted user', "avatarUrl"=NULL WHERE _id=$1`, [mid]);
    await q(`UPDATE messages SET content='[Mesaj silindi]', "deletedAt"=$1, "deletedBy"=$2, embeds=NULL,
               "encryptedContent"=NULL, iv=NULL, "fileUrl"=NULL, "fileName"=NULL, "fileType"=NULL,
               "editHistory"='[]'::jsonb, transcript=NULL WHERE _id=$3`, [Date.now(), USER, mid]);
    await q('UPDATE messages SET "deletedAt"=$1, "deletedBy"=$2 WHERE _id=$3', [Date.now(), 'mod', deleted]);
    await q('DELETE FROM thread_messages WHERE "threadId"=$1', [threadId]);
    await q('DELETE FROM threads WHERE _id=$1', [threadId]);
  });

  it('never offers expired or tombstoned channel content to the embedding provider', async () => {
    const { EMBEDDABLE_ROW_PREDICATE } = require('../../lib/pgvector');
    const eligible = async (mid: string) =>
      (await q(`SELECT 1 FROM messages m WHERE m._id = $1 AND ${EMBEDDABLE_ROW_PREDICATE}`, [mid])).rows.length === 1;
    await q('UPDATE servers SET "aiEnabled" = TRUE WHERE _id = $1', [SERVER]);
    const permanent = await channel('embed-permanent');
    const active = await channel('embed-active', { expiresAt: later() });
    const expiring = await channel('embed-expired', { expiresAt: later() });
    const tombed = await channel('embed-tomb', { expiresAt: later() });
    const ids = { permanent: id('e1'), active: id('e2'), expired: id('e3'), tombed: id('e4') };
    await insertSql(db._pool, permanent, SERVER, ids.permanent);
    await insertSql(db._pool, active, SERVER, ids.active);
    await insertSql(db._pool, expiring, SERVER, ids.expired);
    await insertSql(db._pool, tombed, SERVER, ids.tombed);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [earlier(), expiring]);
    await tombstone(tombed);
    expect(await eligible(ids.permanent)).toBe(true);
    expect(await eligible(ids.active)).toBe(true);
    expect(await eligible(ids.expired)).toBe(false);
    expect(await eligible(ids.tombed)).toBe(false);
  });

  it('keeps reply-snapshot erasure working on an unavailable channel', async () => {
    const cid = await channel('reply-snap', { expiresAt: later() });
    const mid = id('reply-snap-msg');
    await insertSql(db._pool, cid, SERVER, mid);
    await q(`UPDATE messages SET "replyTo"='{"_id":"p","displayName":"A","content":"q"}'::jsonb WHERE _id=$1`, [mid]);
    await q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [earlier(), cid]);
    // accountErasure.prepareAuthorErasure and deleteMessageCascade's reply flag.
    await q(`UPDATE messages SET "replyTo" = "replyTo" - 'displayName' WHERE _id=$1`, [mid]);
    await q(`UPDATE messages SET "replyTo" = jsonb_set("replyTo", '{deleted}', 'true'::jsonb) WHERE _id=$1`, [mid]);
    await q('UPDATE messages SET "replyTo" = NULL WHERE _id=$1', [mid]);
    const row = (await q('SELECT "replyTo" FROM messages WHERE _id=$1', [mid])).rows[0];
    expect(row.replyTo).toBeNull();
  });

  it('covers the real repository writers: Messages.create, threads, thread replies and crossposts', async () => {
    const expired = await channel('repos', { expiresAt: earlier() });
    await expectDenied(Messages.create({
      _id: id('repo'), channelId: expired, serverId: SERVER, userId: USER, username: 'u',
      displayName: 'U', content: 'x', createdAt: Date.now(),
    }));
    await expectDenied(Threads.insert({ channelId: expired, serverId: SERVER, name: 't', createdBy: USER, parentMessageId: id('parent') }));
    await expectDenied(Threads.insertMessage({ threadId: id('thread'), channelId: expired, serverId: SERVER, userId: USER, username: 'u', displayName: 'U', content: 'x' }));

    const source = await channel('crosspost-source');
    const sourceMessage = id('source');
    await insertSql(db._pool, source, SERVER, sourceMessage);
    await expectDenied(Announcements.persistCrosspost({
      bridgeMessageId: id('bridge'), sourceMessageId: sourceMessage, sourceChannelId: source, sourceServerId: SERVER,
      targetChannelId: expired, targetServerId: SERVER, userId: USER, username: 'u', displayName: 'U',
      avatarColor: '#000', content: 'x', createdAt: Date.now(),
    }));
    expect(await count(expired)).toBe(0);
    // The crosspost transaction rolled back as a whole: no orphan log row.
    const log = await q('SELECT COUNT(*)::int AS n FROM crosspost_log WHERE "targetChannelId"=$1', [expired]);
    expect(Number(log.rows[0].n)).toBe(0);
  });

  it('race: a writer arriving while the expiry worker holds the channel is denied after the worker commits', async () => {
    const cid = await channel('worker-first', { expiresAt: Date.now() + 60_000 });
    await insertSql(db._pool, cid);
    const worker: PoolClient = await db._pool.connect();
    const writer: PoolClient = await db._pool.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', [cid]);
      // The writer blocks on the channel row lock inside the barrier.
      const pending = insertSql(writer, cid).then(() => null, (err: unknown) => err);
      await new Promise(r => setTimeout(r, 300));
      // Tombstone, graph delete and channel delete commit together, inside the
      // worker transaction; the writer is still blocked on the row lock.
      await worker.query('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState") VALUES ($1,$2,$3,1,$4,$5)',
        [cid, SERVER, Date.now(), Date.now(), 'pending']);
      await worker.query('DELETE FROM messages WHERE "channelId"=$1', [cid]);
      await worker.query('DELETE FROM channels WHERE _id=$1', [cid]);
      await worker.query('COMMIT');
      expect(isChannelWriteDenied(await pending)).toBe(true);
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined);
      worker.release();
      writer.release();
    }
    expect(await count(cid)).toBe(0);
  });

  it('race: a writer that locked first finishes, then the worker removes what it committed (no resurrection)', async () => {
    const cid = await channel('writer-first', { expiresAt: Date.now() + 60_000 });
    const writer: PoolClient = await db._pool.connect();
    const worker: PoolClient = await db._pool.connect();
    try {
      await writer.query('BEGIN');
      await insertSql(writer, cid);
      await worker.query('BEGIN');
      await worker.query("SET LOCAL lock_timeout = '250ms'");
      // The worker cannot claim while the writer holds FOR KEY SHARE.
      await expect(worker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', [cid])).rejects.toMatchObject({ code: '55P03' });
      await worker.query('ROLLBACK');
      await writer.query('COMMIT');
      expect(await count(cid)).toBe(1);

      await worker.query('BEGIN');
      await worker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', [cid]);
      await worker.query('INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt","cleanupState") VALUES ($1,$2,$3,1,$4,$5)',
        [cid, SERVER, Date.now(), Date.now(), 'pending']);
      await worker.query('DELETE FROM messages WHERE "channelId"=$1', [cid]);
      await worker.query('DELETE FROM channels WHERE _id=$1', [cid]);
      await worker.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await worker.query('ROLLBACK').catch(() => undefined);
      writer.release();
      worker.release();
    }
    expect(await count(cid)).toBe(0);
    await expectDenied(insertSql(db._pool, cid));
  });

  it('does not contend with ordinary channel metadata updates', async () => {
    const cid = await channel('metadata');
    const writer: PoolClient = await db._pool.connect();
    try {
      await writer.query('BEGIN');
      await insertSql(writer, cid);
      const other: PoolClient = await db._pool.connect();
      try {
        await other.query('BEGIN');
        await other.query("SET LOCAL lock_timeout = '250ms'");
        await other.query('UPDATE channels SET topic=$1 WHERE _id=$2', ['new topic', cid]);
        await other.query('COMMIT');
      } finally {
        await other.query('ROLLBACK').catch(() => undefined);
        other.release();
      }
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect(await count(cid)).toBe(1);
  });
});
