/** P7 D2: actual PostgreSQL row-lock and expiry clock evidence. */
import { Pool } from 'pg';
import { withLiveChannelWriteLock } from '../../lib/channelWriteLock';

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;

RUN('P7 D2 live-channel write barrier — real PostgreSQL', () => {
  const pool = new Pool({ connectionString: PG_TEST_URL, max: 4 });
  afterAll(async () => { await pool.end(); });

  async function fixture(run: (serverId: string, channelId: string) => Promise<void>) {
    const serverId = 'pgt-d2-write-' + process.pid + '-' + Date.now() +
      '-' + Math.random().toString(36).slice(2, 10);
    const channelId = serverId + '-channel';
    await pool.query(
      'INSERT INTO servers (_id,name,"ownerId","createdAt") VALUES ($1,$1,$2,1)',
      [serverId, 'pgt-d2-write-owner'],
    );
    try {
      await pool.query(
        'INSERT INTO channels (_id,"serverId",name,"createdAt","expiresAt","expiryVersion") VALUES ($1,$2,$1,1,$3,1)',
        [channelId, serverId, String(Date.now() + 120_000)],
      );
      await run(serverId, channelId);
    } finally {
      await pool.query('DELETE FROM channel_expiry_tombstones WHERE "channelId"=$1', [channelId]);
      await pool.query('DELETE FROM channels WHERE _id=$1', [channelId]);
      await pool.query('DELETE FROM servers WHERE _id=$1', [serverId]);
    }
  }

  it('a callback update commits on one locked transaction; expired rows refuse it', async () => {
    await fixture(async (serverId, channelId) => {
      const result = await withLiveChannelWriteLock(pool, channelId, serverId, async (tx) => {
        await tx.query('UPDATE channels SET name=$1 WHERE _id=$2', ['committed-name', channelId]);
        return 17;
      });
      expect(result).toEqual({ state: 'committed', value: 17 });
      const renamed = await pool.query('SELECT name FROM channels WHERE _id=$1', [channelId]);
      expect(renamed.rows[0].name).toBe('committed-name');

      await pool.query(
        'UPDATE channels SET "expiresAt"=$1 WHERE _id=$2',
        [String(Date.now() - 1000), channelId],
      );
      const callback = jest.fn(async () => 18);
      const denied = await withLiveChannelWriteLock(pool, channelId, serverId, callback);
      expect(denied).toEqual({ state: 'denied', reason: 'expired' });
      expect(callback).not.toHaveBeenCalled();
    });
  });

  it('the row lock blocks concurrent expiry updates while a callback is active', async () => {
    await fixture(async (serverId, channelId) => {
      let entered!: () => void;
      let release!: () => void;
      const inside = new Promise<void>(resolve => { entered = resolve; });
      const hold = new Promise<void>(resolve => { release = resolve; });
      const writer = withLiveChannelWriteLock(pool, channelId, serverId, async () => {
        entered();
        await hold;
        return 'written';
      });

      try {
        await inside;
        const competitor = await pool.connect();
        try {
          await competitor.query("SET lock_timeout = '250ms'");
          await expect(competitor.query(
            'UPDATE channels SET "expiryVersion"=2 WHERE _id=$1', [channelId],
          )).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await competitor.query('RESET lock_timeout');
          competitor.release();
        }
      } finally {
        release();
      }
      expect(await writer).toEqual({ state: 'committed', value: 'written' });
    });
  });

  it('callback failure rolls back its own writes and frees the row lock', async () => {
    await fixture(async (serverId, channelId) => {
      await expect(withLiveChannelWriteLock(pool, channelId, serverId, async (tx) => {
        await tx.query('UPDATE channels SET name=$1 WHERE _id=$2', ['should-rollback', channelId]);
        throw new Error('intentional failed write');
      })).rejects.toThrow('intentional failed write');
      const record = await pool.query('SELECT name FROM channels WHERE _id=$1', [channelId]);
      expect(record.rows[0].name).toBe(channelId);
    });
  });

  it('a durable tombstone denies even when a leftover channel row is otherwise live', async () => {
    await fixture(async (serverId, channelId) => {
      const now = Date.now();
      await pool.query(
        'INSERT INTO channel_expiry_tombstones ("channelId","serverId","expiredAt","expiryVersion","recordedAt") VALUES ($1,$2,$3,2,$4)',
        [channelId, serverId, String(now - 1), String(now)],
      );
      const callback = jest.fn(async () => 1);
      expect(await withLiveChannelWriteLock(pool, channelId, serverId, callback))
        .toEqual({ state: 'denied', reason: 'tombstoned' });
      expect(callback).not.toHaveBeenCalled();
    });
  });
});
