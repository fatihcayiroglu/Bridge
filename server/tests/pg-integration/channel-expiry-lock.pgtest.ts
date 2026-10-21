/** P7 D2: real PostgreSQL multi-connection SKIP LOCKED evidence.
 * Candidate preflight only: NO production expiry worker or user-facing API.
 */
import { Pool } from 'pg';
import { withExpiredChannelRowLock } from '../../lib/channelExpiryLock';

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const now = 1_800_000_000_000;

RUN('P7 D2 locked expiry candidate — real PostgreSQL', () => {
  const pool = new Pool({ connectionString: PG_TEST_URL, max: 4 });

  afterAll(async () => { await pool.end(); });

  async function withFixture(test: (server: string, channel: string) => Promise<void>) {
    const id = 'pgt-d2-lock-' + process.pid + '-' + Date.now() +
      '-' + Math.random().toString(36).slice(2, 10);
    const channel = id + '-channel';
    const sibling = id + '-sibling';
    await pool.query(
      'INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)',
      [id, 'pgt-d2-lock-owner'],
    );
    try {
      await pool.query(
        'INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$3,$1,1,$4,1),($2,$3,$2,1,NULL,0)',
        [channel, sibling, id, String(now)],
      );
      await test(id, channel);
    } finally {
      // All changes are test-only on disposable PG_TEST_URL. No lingering
      // tombstone or channel fixture even if an assertion fails.
      await pool.query('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [channel]);
      await pool.query('DELETE FROM channels WHERE "serverId"=$1', [id]);
      await pool.query('DELETE FROM servers WHERE _id=$1', [id]);
    }
  }

  it('two workers cannot simultaneously select the same expired row', async () => {
    await withFixture(async (server, channel) => {
      let entered!: () => void;
      let resume!: () => void;
      const firstLocked = new Promise<void>(resolve => { entered = resolve; });
      const holdFirst = new Promise<void>(resolve => { resume = resolve; });
      const first = withExpiredChannelRowLock(pool, channel, server, now,
        async (tx, candidate) => {
          entered();
          await holdFirst;
          // A permitted extension updates the expiry while the row is
          // exclusively locked; a future worker must recheck version.
          await tx.query(
            'UPDATE channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2 AND "serverId"=$3',
            [String(now + 10_000), channel, server],
          );
          return candidate.expiryVersion;
        });
      await firstLocked;
      try {
        let secondInvoked = false;
        const second = await withExpiredChannelRowLock(pool, channel, server, now,
          async () => { secondInvoked = true; });
        expect(second).toEqual({ state: 'not_claimed' });
        expect(secondInvoked).toBe(false);
      } finally {
        resume();
      }
      expect(await first).toEqual({ state: 'executed', value: 1 });
      // After commit the record is no longer expired, even though the lock
      // is gone. It must not be reclaimed using the stale version.
      expect(await withExpiredChannelRowLock(pool, channel, server, now,
        async () => 'unexpected')).toEqual({ state: 'not_claimed' });
      expect((await pool.query(
        'SELECT "expiryVersion","expiresAt" FROM channels WHERE _id=$1', [channel],
      )).rows).toEqual([{ expiryVersion: '2', expiresAt: String(now + 10_000) }]);
    });
  });

  it('callback failure rolls back tombstone and leaves row available for a later claim', async () => {
    await withFixture(async (server, channel) => {
      await expect(withExpiredChannelRowLock(pool, channel, server, now, async tx => {
        await tx.query(
          'INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,$3,1,$4)',
          [channel, server, String(now), String(now + 1)],
        );
        throw new Error('injected crash before commit');
      })).rejects.toThrow('injected crash before commit');
      expect((await pool.query(
        'SELECT "channelId" FROM channel_expiry_tombstones WHERE "channelId"=$1', [channel],
      )).rows).toHaveLength(0);
      expect(await withExpiredChannelRowLock(pool, channel, server, now,
        async (_tx, candidate) => candidate.expiryVersion))
        .toEqual({ state: 'executed', value: 1 });
    });
  });

  it('rejects foreign server and a previously tombstoned channel', async () => {
    await withFixture(async (server, channel) => {
      expect(await withExpiredChannelRowLock(pool, channel, 'foreign-server', now,
        async () => 'unexpected')).toEqual({ state: 'not_claimed' });
      await pool.query(
        'INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,$3,1,$4)',
        [channel, server, String(now), String(now + 1)],
      );
      expect(await withExpiredChannelRowLock(pool, channel, server, now,
        async () => 'unexpected')).toEqual({ state: 'not_claimed' });
    });
  });
});
