/**
 * P7 D2: real PostgreSQL proof of the channel expiry worker.
 * Expiry is seeded through SQL (no public expiry API yet).
 */
import type { PoolClient } from 'pg';
import { claimExpiredChannel, cleanupNextTombstone, runChannelExpiryTick } from '../../lib/channelExpiryWorker';

const db = require('../../db/loader').default;
const { channelLiveForMessageRead } = require('../../lib/channelReadExpiryGuard');
const { isChannelWriteDenied } = require('../../lib/channelWriteBarrier');

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-ew-' + process.pid + '-' + Date.now();
const USER = P + '-user';
let seq = 0;
const id = (label: string) => `${P}-${label}-${++seq}`;

RUN('P7 D2 channel expiry worker — real PostgreSQL', () => {
  const q = (sql: string, params: unknown[] = []) => db._pool.query(sql, params);
  const n = async (sql: string, params: unknown[]) => Number((await q(sql, params)).rows[0].n);
  const past = () => Date.now() - 60_000;

  async function server() {
    const sid = id('srv');
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [sid, USER]);
    return sid;
  }
  /** An expiring channel is seeded LIVE (the write barrier refuses content for an expired one); tests expire it later. */
  async function channel(serverId: string, expiring: unknown = null) {
    const cid = id('ch');
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$3,1,$4,$5)',
      [cid, serverId, 'c', expiring === null ? null : Date.now() + 600_000, expiring === null ? 0 : 1]);
    return cid;
  }
  async function content(channelId: string, serverId: string, messages = 3) {
    for (let i = 0; i < messages; i++) {
      await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id('m'), channelId, serverId, USER, 'u', 'U', 'x', Date.now()]);
    }
    const tid = id('t');
    await q('INSERT INTO threads (_id,"channelId","serverId","parentMessageId",name,"createdBy","createdAt","lastMessageAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$7)',
      [tid, channelId, serverId, id('p'), 't', USER, Date.now()]);
    await q('INSERT INTO thread_messages (_id,"threadId","channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id('tm'), tid, channelId, serverId, USER, 'u', 'U', 'x', Date.now()]);
    await q('INSERT INTO notifications (_id,"userId",type,"serverId","channelId","messageId",read,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,FALSE,$7)',
      [id('n'), USER, 'mention', serverId, channelId, id('m'), Date.now()]);
    await q('INSERT INTO saved_messages (_id,"userId","destinationType","destinationId","messageId","createdAt") VALUES ($1,$2,$3,$4,$5,$6)',
      [id('s'), USER, 'channel', channelId, id('sm'), Date.now()]);
  }
  const expire = (cid: string) => q('UPDATE channels SET "expiresAt"=$1 WHERE _id=$2', [past(), cid]);
  async function remaining(cid: string) {
    return {
      messages: await n('SELECT COUNT(*)::int AS n FROM messages WHERE "channelId"=$1', [cid]),
      threads: await n('SELECT COUNT(*)::int AS n FROM threads WHERE "channelId"=$1', [cid]),
      threadMessages: await n('SELECT COUNT(*)::int AS n FROM thread_messages WHERE "channelId"=$1', [cid]),
      notifications: await n('SELECT COUNT(*)::int AS n FROM notifications WHERE "channelId"=$1', [cid]),
      saved: await n(`SELECT COUNT(*)::int AS n FROM saved_messages WHERE "destinationType"='channel' AND "destinationId"=$1`, [cid]),
      channel: await n('SELECT COUNT(*)::int AS n FROM channels WHERE _id=$1', [cid]),
    };
  }
  const tombstone = async (cid: string) => (await q('SELECT "cleanupState" FROM channel_expiry_tombstones WHERE "channelId"=$1', [cid])).rows[0]?.cleanupState ?? null;
  /** Claim until the given channels are claimed; other suites' rows may also be claimed. */
  async function drain(limits = {}) {
    for (let i = 0; i < 200; i++) {
      const r = await runChannelExpiryTick(db._pool, limits);
      if (!r.claimed.length && !r.converged.length && !r.deleted) return;
    }
  }

  async function cleanup() {
    for (const t of ['saved_messages']) await q(`DELETE FROM ${t} WHERE "userId"=$1`, [USER]);
    for (const t of ['thread_messages', 'threads', 'messages', 'notifications']) {
      await q(`DELETE FROM ${t} WHERE "channelId" LIKE $1`, [P + '%']);
    }
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channels WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM servers WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  }
  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$2,$3,1)', [USER, 'U', 'x']);
  });
  afterAll(cleanup);

  it('claims an expired channel, denies reads and writes at once, then converges its graph', async () => {
    const sid = await server();
    const keep = await channel(sid);
    const doomed = await channel(sid, past());
    await content(keep, sid);
    await content(doomed, sid);
    await expire(doomed);

    const claim = await claimExpiredChannel(db._pool);
    expect(claim.state).toBe('claimed');
    await drain();  // in case another expired channel came first
    expect(await tombstone(doomed)).toBe('converged');
    expect(await remaining(doomed)).toEqual({ messages: 0, threads: 0, threadMessages: 0, notifications: 0, saved: 0, channel: 0 });
    expect(await remaining(keep)).toEqual({ messages: 3, threads: 1, threadMessages: 1, notifications: 1, saved: 1, channel: 1 });

    expect(await channelLiveForMessageRead(db._pool, doomed, sid)).toBe(false);
    let err: unknown = null;
    await q('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [id('late'), doomed, sid, USER, 'u', 'U', 'x', Date.now()]).catch((e: unknown) => { err = e; });
    expect(isChannelWriteDenied(err)).toBe(true);
  });

  it('never claims a server\'s last live channel', async () => {
    const lonely = await server();
    const only = await channel(lonely, past());
    await expire(only);
    const both = await server();
    const a = await channel(both, past());
    const b = await channel(both, past());
    await expire(a); await expire(b);
    await drain();
    for (const cid of [only, a, b]) {
      expect(await tombstone(cid)).toBeNull();
      expect((await remaining(cid)).channel).toBe(1);
    }
  });

  it('four concurrent workers claim each expired channel exactly once', async () => {
    const sid = await server();
    await channel(sid);  // the survivor
    const doomed: string[] = [];
    for (let i = 0; i < 12; i++) { const c = await channel(sid, past()); await content(c, sid, 2); doomed.push(c); }
    for (const c of doomed) await expire(c);
    const reports = await Promise.all([0, 1, 2, 3].map(() => runChannelExpiryTick(db._pool, { maxClaims: 20 })));
    const mine = reports.flatMap(r => r.claimed).filter(c => doomed.includes(c));
    expect(new Set(mine).size).toBe(mine.length);
    await drain();
    for (const c of doomed) {
      expect(await tombstone(c)).toBe('converged');
      expect(await remaining(c)).toEqual({ messages: 0, threads: 0, threadMessages: 0, notifications: 0, saved: 0, channel: 0 });
    }
    expect(await n('SELECT COUNT(*)::int AS n FROM channel_expiry_tombstones WHERE "channelId" = ANY($1::text[])', [doomed])).toBe(12);
  });

  it('skips a channel while a writer holds it, then removes what the writer committed', async () => {
    const sid = await server();
    await channel(sid);
    const busy = await channel(sid, past());
    const writer: PoolClient = await db._pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query('INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,"createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id('inflight'), busy, sid, USER, 'u', 'U', 'x', Date.now()]);
      await expire(busy);
      await drain();
      expect(await tombstone(busy)).toBeNull();  // SKIP LOCKED: not claimed while the writer holds it
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect((await remaining(busy)).messages).toBe(1);
    await drain();
    expect(await tombstone(busy)).toBe('converged');
    expect((await remaining(busy)).messages).toBe(0);
  });

  it('recovers after a crash mid-cleanup and deletes in bounded batches', async () => {
    const sid = await server();
    await channel(sid);
    const big = await channel(sid, past());
    await content(big, sid, 7);
    await expire(big);
    for (let i = 0; i < 50; i++) { const c = await claimExpiredChannel(db._pool); if (c.state === 'none') break; }
    expect(await tombstone(big)).toBe('pending');
    // Find this tombstone's turn, then run exactly one pass with batch size 2.
    let first: { state: string; deleted?: number } = { state: 'none' };
    for (let i = 0; i < 100; i++) {
      first = await cleanupNextTombstone(db._pool, 2);
      if (first.state === 'none' || (first as { channelId?: string }).channelId === big) break;
    }
    expect(first.state).toBe('progress');
    expect((await remaining(big)).messages).toBe(5);  // 7 - 2: bounded
    // "Crash": nothing in memory survives; a later tick resumes from the durable tombstone.
    await drain({ batchSize: 2 });
    expect(await tombstone(big)).toBe('converged');
    expect(await remaining(big)).toEqual({ messages: 0, threads: 0, threadMessages: 0, notifications: 0, saved: 0, channel: 0 });
    // Idempotent: a converged tombstone is not processed again.
    const again = await runChannelExpiryTick(db._pool);
    expect(again.converged).not.toContain(big);
  });

  it('leaves permanent and not-yet-expired channels untouched', async () => {
    const sid = await server();
    const permanent = await channel(sid);
    const later = await channel(sid, past());  // seeded live; never expired below
    await content(permanent, sid, 1);
    await drain();
    expect(await tombstone(permanent)).toBeNull();
    expect(await tombstone(later)).toBeNull();
    expect((await remaining(permanent)).messages).toBe(1);
  });
});
