import {
  EXPIRED_CHANNEL_LOCK_SQL,
  withExpiredChannelRowLock,
  type ExpiryLockedTransaction,
  type ExpiryLockPool,
} from '../lib/channelExpiryLock';

const now = 1_800_000_000_000;
const validRow = {
  channelId: 'c1', serverId: 's1', expiresAt: String(now),
  expiryVersion: '1',
};

function fakePool(rows: Record<string, unknown>[]) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let released = 0;
  const tx: ExpiryLockedTransaction = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: sql === EXPIRED_CHANNEL_LOCK_SQL ? rows : [] };
    },
    release: () => { released++; },
  };
  const pool: ExpiryLockPool = { connect: async () => tx };
  return { pool, calls, releases: () => released };
}

describe('P7 D2 dormant row-locked expiry candidate selection', () => {
  it('locks only a tenant-scoped expired row and keeps callback inside transaction', async () => {
    const { pool, calls, releases } = fakePool([validRow]);
    const seen: string[] = [];
    const result = await withExpiredChannelRowLock(pool, 'c1', 's1', now,
      async (tx, candidate) => {
        seen.push('callback');
        expect(tx).toBeDefined();
        expect(candidate).toEqual({
          channelId: 'c1', serverId: 's1', expiresAt: now, expiryVersion: 1,
        });
        return 'locked';
      });
    expect(result).toEqual({ state: 'executed', value: 'locked' });
    expect(calls.map(c => c.sql)).toEqual(['BEGIN', EXPIRED_CHANNEL_LOCK_SQL, 'COMMIT']);
    expect(calls[1].values).toEqual(['c1', 's1', now]);
    expect(seen).toEqual(['callback']);
    expect(releases()).toBe(1);
    expect(EXPIRED_CHANNEL_LOCK_SQL).toMatch(/FOR UPDATE OF c SKIP LOCKED/);
    expect(EXPIRED_CHANNEL_LOCK_SQL).toContain('channel_expiry_tombstones');
    expect(EXPIRED_CHANNEL_LOCK_SQL).not.toContain('DELETE FROM');
  });

  it('never invokes callback when row is locked, active, missing, or tombstoned', async () => {
    const { pool, calls, releases } = fakePool([]);
    let invoked = false;
    expect(await withExpiredChannelRowLock(pool, 'c1', 's1', now,
      async () => { invoked = true; })).toEqual({ state: 'not_claimed' });
    expect(invoked).toBe(false);
    expect(calls.map(c => c.sql)).toEqual(['BEGIN', EXPIRED_CHANNEL_LOCK_SQL, 'ROLLBACK']);
    expect(releases()).toBe(1);
  });

  it('denies malformed input before acquiring a database client', async () => {
    let acquired = false;
    const pool: ExpiryLockPool = {
      connect: async () => {
        acquired = true;
        throw new Error('should not connect');
      },
    };
    for (const [id, server, time] of [
      ['', 's1', now], [' c1 ', 's1', now], ['c1', '', now],
      ['c1', 's1', NaN], ['c1', 's1', -1], ['c1', 's1', Infinity],
      ['c1', 's1', 'untrusted'],
    ] as Array<[unknown, unknown, unknown]>) {
      expect(await withExpiredChannelRowLock(pool, id, server, time, async () => 1))
        .toEqual({ state: 'invalid' });
    }
    expect(acquired).toBe(false);
  });

  it('rolls back and raises malformed rows instead of giving a lock grant', async () => {
    for (const row of [
      { ...validRow, channelId: 'foreign' },
      { ...validRow, serverId: 'foreign' },
      { ...validRow, expiryVersion: '0' },
      { ...validRow, expiresAt: String(now + 1) },
      { ...validRow, expiryVersion: '01' },
      { channelId: 'c1', serverId: 's1', expiresAt: String(now) },
    ]) {
      const { pool, calls, releases } = fakePool([row]);
      let invoked = false;
      await expect(withExpiredChannelRowLock(pool, 'c1', 's1', now,
        async () => { invoked = true; })).rejects.toThrow();
      expect(invoked).toBe(false);
      expect(calls.map(c => c.sql)).toEqual(['BEGIN', EXPIRED_CHANNEL_LOCK_SQL, 'ROLLBACK']);
      expect(releases()).toBe(1);
    }
  });

  it('rolls back a callback error without concealing it as success', async () => {
    const { pool, calls, releases } = fakePool([validRow]);
    await expect(withExpiredChannelRowLock(pool, 'c1', 's1', now, async () => {
      throw new Error('injected transactional failure');
    })).rejects.toThrow('injected transactional failure');
    expect(calls.map(c => c.sql)).toEqual(['BEGIN', EXPIRED_CHANNEL_LOCK_SQL, 'ROLLBACK']);
    expect(releases()).toBe(1);
  });
});
