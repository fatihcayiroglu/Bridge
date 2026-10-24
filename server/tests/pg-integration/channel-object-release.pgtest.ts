/**
 * P7 D2: real PostgreSQL + real local storage proof of the expired-channel
 * object-release outbox (migration 089).
 *
 * The cleanup records the upload URLs of the rows it deletes in the SAME
 * statement; a separate leased phase deletes the objects after COMMIT with a
 * fail-closed live-reference check, retries with backoff, and terminal states.
 * Files live in a throwaway BRIDGE_UPLOAD_ROOT; the private storage provider is
 * the local adapter (S3/MinIO use the same releaser through the adapter API).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  CLAIM_OBJECT_RELEASES_SQL, OBJECT_RELEASE_MAX_ATTEMPTS, claimExpiredChannel, cleanupNextTombstone,
  releaseChannelObjects, runChannelExpiryTick, type ObjectReleaser,
} from '../../lib/channelExpiryWorker';
import { createChannelObjectReleaser } from '../../lib/channelObjectRelease';
import { hasLiveUploadReference, liveUploadReferenceKeys } from '../../lib/uploadReferenceSafety';

const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-d2-objects-'));
process.env.BRIDGE_UPLOAD_ROOT = UPLOADS;
delete process.env.PRIVATE_STORAGE_PROVIDER;

const db = require('../../db/loader').default;

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const P = 'pgt-d2-obj-' + process.pid + '-' + Date.now();
const USER = P + '-user';
let seq = 0;
const id = (label: string) => `${P}-${label}-${++seq}`;
const down089 = fs.readFileSync(path.resolve(__dirname, '../../db/migrations_pg/rollback/089_channel_object_release_outbox.down.sql'), 'utf8');

RUN('P7 D2 expired-channel object release — real PostgreSQL + local storage', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows as Array<Record<string, unknown>>;
  const releaser = () => createChannelObjectReleaser(db._pool);
  const file = (rel: string, body = 'bytes') => {
    const full = path.join(UPLOADS, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };
  const exists = (rel: string) => fs.existsSync(path.join(UPLOADS, rel));

  async function server() {
    const sid = id('srv');
    await q('INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)', [sid, USER]);
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt") VALUES ($1,$2,$3,1)', [sid + '-keep', sid, 'keep']);
    return sid;
  }
  async function channel(sid: string) {
    const cid = id('ch');
    await q('INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$3,1,$4,1)',
      [cid, sid, 'eph', Date.now() + 600_000]);
    return cid;
  }
  async function attachment(cid: string, sid: string, url: string) {
    await q(`INSERT INTO messages (_id,"channelId","serverId","userId",username,"displayName",content,type,"fileUrl","createdAt")
             VALUES ($1,$2,$3,$4,'u','U','',$5,$6,$7)`, [id('m'), cid, sid, USER, 'file', url, Date.now()]);
  }
  const expire = (cid: string) => q('UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2', [Date.now() - 1000, cid]);
  const outbox = async (cid: string) => (await q(
    'SELECT url, state, attempts, "lastError", "nextAttemptAt", "finishedAt" FROM channel_object_release_outbox WHERE "channelId"=$1 ORDER BY url', [cid]));
  /** Claims and drains only through the worker; other suites' channels may be processed too. */
  async function drain(objects?: ObjectReleaser, batchSize?: number) {
    for (let i = 0; i < 300; i++) {
      const r = await runChannelExpiryTick(db._pool, { batchSize }, objects);
      const moved = r.claimed.length + r.converged.length + r.deleted +
        (r.objects ? r.objects.released + r.objects.retained + r.objects.retried + r.objects.failed : 0);
      if (!moved) return;
    }
  }

  async function cleanup() {
    await q('DELETE FROM channel_object_release_outbox WHERE "channelId" LIKE $1', [P + '%']);
    for (const t of ['messages', 'voice_messages', 'podcast_episodes']) await q(`DELETE FROM ${t} WHERE "channelId" LIKE $1`, [P + '%']);
    await q('DELETE FROM channel_expiry_tombstones WHERE "channelId" LIKE $1', [P + '%']);
    await q('DELETE FROM channels WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM servers WHERE _id LIKE $1', [P + '%']);
    await q('DELETE FROM users WHERE _id=$1', [USER]);
  }
  beforeAll(async () => {
    await cleanup();
    await q('INSERT INTO users (_id,username,"displayName",password,"createdAt") VALUES ($1,$1,$2,$3,1)', [USER, 'U', 'x']);
  });
  afterAll(async () => {
    await cleanup();
    fs.rmSync(UPLOADS, { recursive: true, force: true });
  });

  it('queues every upload of the deleted rows and releases only objects Bridge owns and nobody else references', async () => {
    const sid = await server();
    const cid = await channel(sid);
    file('att.png'); file('vm_1.webm'); file('recordings/ep1.mp3'); file('shared.png'); file('collide.png'); file('legacy.mp3');
    await attachment(cid, sid, '/uploads/att.png');
    await attachment(cid, sid, '/uploads/shared.png');
    await attachment(sid + '-keep', sid, '/uploads/shared.png');           // a live copy elsewhere
    await attachment(cid, sid, 'https://cdn.example.com/collide.png');     // basename of a local file
    await q(`INSERT INTO voice_messages (_id,"channelId","serverId","userId","displayName",url,"createdAt") VALUES ($1,$2,$3,$4,'U',$5,1)`,
      [id('vm'), cid, sid, USER, '/uploads/vm_1.webm']);
    await q(`INSERT INTO podcast_episodes (_id,"channelId","serverId",title,"audioUrl","createdAt") VALUES ($1,$2,$3,'e',$4,1)`,
      [id('ep'), cid, sid, '/uploads/recordings/ep1.mp3']);
    await q(`INSERT INTO podcast_episodes (_id,"channelId","serverId",title,filename,"createdAt") VALUES ($1,$2,$3,'legacy',$4,1)`,
      [id('ep'), cid, sid, 'legacy.mp3']);
    await expire(cid);

    await drain(releaser());
    expect(await q('SELECT 1 FROM messages WHERE "channelId"=$1', [cid])).toHaveLength(0);
    const rows = await outbox(cid);
    expect(rows.map(r => [r.url, r.state, r.lastError])).toEqual([
      ['/uploads/att.png', 'released', null],
      ['/uploads/legacy.mp3', 'released', null],
      ['/uploads/recordings/ep1.mp3', 'released', null],
      ['/uploads/shared.png', 'retained', 'still_referenced'],
      ['/uploads/vm_1.webm', 'released', null],
      ['https://cdn.example.com/collide.png', 'retained', 'unrecognized'],
    ]);
    for (const gone of ['att.png', 'vm_1.webm', 'recordings/ep1.mp3', 'legacy.mp3']) expect(exists(gone)).toBe(false);
    expect(exists('shared.png')).toBe(true);
    expect(exists('collide.png')).toBe(true);
  });

  it('records URLs in the same statement as the delete: a bounded pass queues exactly what it removed', async () => {
    const sid = await server();
    const cid = await channel(sid);
    for (let i = 0; i < 5; i++) { file(`batch${i}.png`); await attachment(cid, sid, `/uploads/batch${i}.png`); }
    await expire(cid);
    for (let i = 0; i < 50; i++) { const c = await claimExpiredChannel(db._pool); if (c.state === 'none') break; }
    let pass: { state: string; channelId?: string } = { state: 'none' };
    for (let i = 0; i < 100; i++) { pass = await cleanupNextTombstone(db._pool, 2); if (pass.channelId === cid) break; }
    expect(pass.state).toBe('progress');
    const left = Number((await q('SELECT COUNT(*)::int AS n FROM messages WHERE "channelId"=$1', [cid]))[0]!.n);
    expect(left).toBe(3);
    expect((await outbox(cid)).map(r => r.state)).toEqual(['pending', 'pending']);
    // Nothing is deleted from storage until the post-commit phase runs.
    for (let i = 0; i < 5; i++) expect(exists(`batch${i}.png`)).toBe(true);
    await drain(releaser(), 2);
    expect((await outbox(cid)).map(r => r.state)).toEqual(Array(5).fill('released'));
    for (let i = 0; i < 5; i++) expect(exists(`batch${i}.png`)).toBe(false);
  });

  it('retries a failing store with backoff, then marks it failed for reconciliation', async () => {
    const sid = await server();
    const cid = await channel(sid);
    file('flaky.png');
    await attachment(cid, sid, '/uploads/flaky.png');
    await expire(cid);
    await drain();   // rows only, no object phase
    let calls = 0;
    const broken: ObjectReleaser = { async release() { calls += 1; throw new Error('s3 503 SlowDown'); } };
    for (let attempt = 1; attempt <= OBJECT_RELEASE_MAX_ATTEMPTS; attempt++) {
      await q('UPDATE channel_object_release_outbox SET "nextAttemptAt"=1 WHERE "channelId"=$1 AND state=$2', [cid, 'pending']);
      await releaseChannelObjects(db._pool, broken, 1000);
      const [row] = await outbox(cid);
      expect(row!.attempts).toBe(attempt);
      if (attempt < OBJECT_RELEASE_MAX_ATTEMPTS) {
        expect(row).toMatchObject({ state: 'pending', lastError: 's3 503 SlowDown' });
        expect(Number(row!.nextAttemptAt)).toBeGreaterThan(Date.now() + 20_000);
      } else {
        expect(row).toMatchObject({ state: 'failed', lastError: 's3 503 SlowDown' });
      }
    }
    expect(calls).toBe(OBJECT_RELEASE_MAX_ATTEMPTS);
    // Failed is terminal: not leased again, and the object is still there for an operator.
    await q('UPDATE channel_object_release_outbox SET "nextAttemptAt"=1 WHERE "channelId"=$1', [cid]);
    await releaseChannelObjects(db._pool, broken, 1000);
    expect(calls).toBe(OBJECT_RELEASE_MAX_ATTEMPTS);
    expect(exists('flaky.png')).toBe(true);
  });

  it('two nodes never release the same object; a crash after the delete is recovered when the lease expires', async () => {
    const sid = await server();
    const cid = await channel(sid);
    for (let i = 0; i < 6; i++) { file(`race${i}.png`); await attachment(cid, sid, `/uploads/race${i}.png`); }
    await expire(cid);
    await drain();
    const seen: string[] = [];
    const slow: ObjectReleaser = {
      async release(url) { seen.push(url); await new Promise(r => setTimeout(r, 20)); return releaser().release(url); },
    };
    await Promise.all([releaseChannelObjects(db._pool, slow, 1000), releaseChannelObjects(db._pool, slow, 1000)]);
    const mine = seen.filter(u => u.startsWith('/uploads/race'));
    expect(mine.length).toBe(6);
    expect(new Set(mine).size).toBe(6);

    // Crash: a node leases a row, deletes the object, and dies before recording it.
    const cid2 = await channel(sid);
    file('crash.png');
    await attachment(cid2, sid, '/uploads/crash.png');
    await expire(cid2);
    await drain();
    await q('UPDATE channel_object_release_outbox SET "nextAttemptAt"=1 WHERE "channelId"=$1', [cid2]);
    const client = await db._pool.connect();
    try {
      const leased = (await client.query(CLAIM_OBJECT_RELEASES_SQL, [1000])).rows.filter((r: { channelId: string }) => r.channelId === cid2);
      expect(leased).toHaveLength(1);
    } finally {
      client.release();
    }
    fs.unlinkSync(path.join(UPLOADS, 'crash.png'));
    // Still leased: nothing to do.
    expect((await releaseChannelObjects(db._pool, releaser(), 1000)).released).toBeGreaterThanOrEqual(0);
    expect((await outbox(cid2))[0]).toMatchObject({ state: 'pending', attempts: 1 });
    // The lease expires; the retry finds the object gone and finishes idempotently.
    await q('UPDATE channel_object_release_outbox SET "nextAttemptAt"=1 WHERE "channelId"=$1', [cid2]);
    await releaseChannelObjects(db._pool, releaser(), 1000);
    expect((await outbox(cid2))[0]).toMatchObject({ state: 'released', attempts: 2 });
  });

  it('reopens an object retained only because a not-yet-drained row of the same channel still pointed at it', async () => {
    const sid = await server();
    const cid = await channel(sid);
    file('dup.png');
    await attachment(cid, sid, '/uploads/dup.png');
    await attachment(cid, sid, '/uploads/dup.png');
    await expire(cid);
    for (let i = 0; i < 50; i++) { const c = await claimExpiredChannel(db._pool); if (c.state === 'none') break; }
    let pass: { state: string; channelId?: string } = { state: 'none' };
    for (let i = 0; i < 100; i++) { pass = await cleanupNextTombstone(db._pool, 1); if (pass.channelId === cid) break; }
    await releaseChannelObjects(db._pool, releaser(), 1000);
    expect((await outbox(cid))[0]).toMatchObject({ state: 'retained', lastError: 'still_referenced' });
    expect(exists('dup.png')).toBe(true);
    await drain(releaser(), 1);
    expect((await outbox(cid))[0]).toMatchObject({ state: 'released' });
    expect(exists('dup.png')).toBe(false);
  });

  it('the batched reference check answers exactly like the single-key check on every URL shape', async () => {
    const sid = await server();
    const keep = sid + '-keep';
    const values = [
      '/uploads/eq-a.png', 'uploads/eq-b.png', 'https://cdn.example/y/uploads/eq-c.png', '/uploads/xeq-d.png',
      '/uploads/eq-e.png?x=1', '/uploads/recordings/eq-f.mp3', 'https://h/uploads/recordings/eq-g.mp3',
      'uploads/recordings/eq-h.mp3', '/other/uploads/eq-i.png', '/uploads/eq-j.png/', 'https://h/a/b/uploads/eq-k.png',
    ];
    for (const v of values) await attachment(keep, sid, v);
    const keys = [
      'uploads/eq-a.png', 'uploads/eq-b.png', 'uploads/eq-c.png', 'uploads/eq-d.png', 'uploads/eq-e.png',
      'uploads/recordings/eq-f.mp3', 'uploads/recordings/eq-g.mp3', 'uploads/recordings/eq-h.mp3',
      'uploads/eq-i.png', 'uploads/eq-j.png', 'uploads/eq-k.png', 'uploads/recordings/eq-zz.mp3', 'uploads/eq-zz.png',
    ];
    const batched = await liveUploadReferenceKeys(db._pool, keys);
    for (const key of keys) {
      expect([key, batched.has(key)]).toEqual([key, await hasLiveUploadReference(db._pool, key)]);
    }
    // Sanity: both positive and negative answers are exercised.
    expect(batched.has('uploads/eq-a.png')).toBe(true);
    expect(batched.has('uploads/eq-d.png')).toBe(false);
    await expect(liveUploadReferenceKeys(db._pool, ['uploads/a/b/c/d.png'])).rejects.toThrow(/unsupported/);
    await expect(liveUploadReferenceKeys(db._pool, ['../etc/passwd'])).rejects.toThrow(/unsupported/);
    expect(await liveUploadReferenceKeys(db._pool, [])).toEqual(new Set());
  });

  it('089 down refuses while objects are pending release', async () => {
    const sid = await server();
    const cid = await channel(sid);
    file('pending.png');
    await attachment(cid, sid, '/uploads/pending.png');
    await expire(cid);
    await drain();
    expect((await outbox(cid))[0]).toMatchObject({ state: 'pending' });
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(down089)).rejects.toThrow(/Cannot roll back 089/);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await drain(releaser());
    expect(exists('pending.png')).toBe(false);
  });
});
