import {
  CHANNEL_WRITE_CLOCK_SQL, CHANNEL_WRITE_LOCK_SQL, CHANNEL_WRITE_TOMBSTONE_SQL,
  withLiveChannelWriteLock, type ChannelWritePool, type ChannelWriteTransaction,
} from '../lib/channelWriteLock';

const NOW = 1_800_000_000_000;
const active = {
  channelId: 'channel1', serverId: 'server1',
  expiresAt: String(NOW + 60_000), expiryVersion: '1',
};
const permanent = { ...active, expiresAt: null, expiryVersion: '0' };
const tombstone = {
  channelId: 'channel1', serverId: 'server1',
  expiredAt: String(NOW - 1), expiryVersion: '2',
  recordedAt: String(NOW), cleanupState: 'pending',
};

function fixture(opts: {
  row?: Record<string, unknown> | null;
  afterRow?: Record<string, unknown> | null;
  tombstone?: Record<string, unknown> | null;
  clocks?: unknown[];
  failAt?: string;
} = {}) {
  const queries: string[] = [];
  let connections = 0;
  let releases = 0;
  let lockReads = 0;
  const clocks = [...(opts.clocks ?? [String(NOW), String(NOW)])];
  const pool: ChannelWritePool = {
    connect: async () => {
      connections++;
      return {
        query: async (sql, values) => {
          queries.push(sql);
          if (sql === opts.failAt) throw new Error('postgres unavailable');
          if (sql === CHANNEL_WRITE_LOCK_SQL) {
            expect(values).toEqual(['channel1', 'server1']);
            lockReads++;
            const row = lockReads > 1 && 'afterRow' in opts ? opts.afterRow : opts.row;
            return { rows: row === null ? [] : [row ?? active] };
          }
          if (sql === CHANNEL_WRITE_CLOCK_SQL) return { rows: [{ nowMs: clocks.shift() }] };
          if (sql === CHANNEL_WRITE_TOMBSTONE_SQL) {
            expect(values).toEqual(['channel1', 'server1']);
            return { rows: opts.tombstone ? [opts.tombstone] : [] };
          }
          return { rows: [] };
        },
        release: () => { releases++; },
      };
    },
  };
  return { pool, queries, connections: () => connections, releases: () => releases };
}

describe('P7 D2 dormant transaction-scoped live-channel write barrier', () => {
  it('holds a tenant-scoped row lock for a DB-only callback and two server-clock reads', async () => {
    const { pool, queries, releases } = fixture();
    const run = await withLiveChannelWriteLock(pool, 'channel1', 'server1', async (tx) => {
      await tx.query('INSERT TEST WRITE');
      return 'saved';
    });
    expect(run).toEqual({ state: 'committed', value: 'saved' });
    expect(queries).toEqual([
      'BEGIN', CHANNEL_WRITE_LOCK_SQL, CHANNEL_WRITE_CLOCK_SQL,
      CHANNEL_WRITE_TOMBSTONE_SQL, 'INSERT TEST WRITE',
      CHANNEL_WRITE_LOCK_SQL, CHANNEL_WRITE_CLOCK_SQL, CHANNEL_WRITE_TOMBSTONE_SQL, 'COMMIT',
    ]);
    expect(CHANNEL_WRITE_LOCK_SQL).toMatch(/FOR SHARE/);
    expect(CHANNEL_WRITE_LOCK_SQL).toContain('"serverId"=$2');
    expect(CHANNEL_WRITE_TOMBSTONE_SQL).toContain('"serverId"=$2');
    expect(CHANNEL_WRITE_CLOCK_SQL).toContain('clock_timestamp()');
    expect(releases()).toBe(1);
  });

  it('permits a migrated permanent channel only after a negative tombstone read', async () => {
    const { pool } = fixture({ row: permanent });
    expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', async () => 42))
      .toEqual({ state: 'committed', value: 42 });
  });

  it('denies expired rows, equality with the server clock, and an existing tombstone', async () => {
    for (const opts of [
      { row: { ...active, expiresAt: String(NOW - 1) }, denial: 'expired' },
      { row: { ...active, expiresAt: String(NOW) }, denial: 'expired' },
      { row: permanent, tombstone, denial: 'tombstoned' },
    ]) {
      const { pool, queries } = fixture(opts);
      const write = jest.fn(async () => 'unreachable');
      expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', write))
        .toEqual({ state: 'denied', reason: opts.denial });
      expect(write).not.toHaveBeenCalled();
      expect(queries.at(-1)).toBe('ROLLBACK');
    }
  });

  it('denies missing channels and never discloses a cross-tenant writer grant', async () => {
    const { pool } = fixture({ row: null });
    const write = jest.fn(async () => 1);
    expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', write))
      .toEqual({ state: 'denied', reason: 'missing' });
    expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { ...active, expiresAt: '01' },
    { ...active, expiryVersion: '01' },
    { ...active, expiryVersion: 0 },
    { ...active, serverId: 'other-tenant' },
    { ...active, channelId: 'other-channel' },
    { ...active, expiresAt: undefined },
  ])('rejects corrupt or mismatched locked channel metadata %#', async (row) => {
    const { pool } = fixture({ row });
    expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', async () => 1))
      .toEqual({ state: 'denied', reason: 'invalid' });
  });

  it('denies corrupt PostgreSQL time before invoking the callback', async () => {
    const { pool } = fixture({ clocks: ['1e3'] });
    const write = jest.fn(async () => 1);
    expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', write))
      .toEqual({ state: 'denied', reason: 'invalid' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rolls back the callback write if server time reaches expiry before COMMIT', async () => {
    const { pool, queries } = fixture({
      row: { ...active, expiresAt: String(NOW + 1) },
      clocks: [String(NOW), String(NOW + 1)],
    });
    const write = jest.fn(async (tx: ChannelWriteTransaction) => {
      await tx.query('INSERT TEST WRITE');
      return 'not committed';
    });
    expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', write))
      .toEqual({ state: 'denied', reason: 'expired' });
    expect(write).toHaveBeenCalledTimes(1);
    expect(queries).toContain('INSERT TEST WRITE');
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });

  it('rechecks modified expiry metadata after a database callback', async () => {
    const { pool, queries } = fixture({
      row: active,
      afterRow: { ...active, expiresAt: String(NOW - 1), expiryVersion: '2' },
    });
    expect(await withLiveChannelWriteLock(pool, 'channel1', 'server1', async () => 'uncommitted'))
      .toEqual({ state: 'denied', reason: 'expired' });
    expect(queries.filter(sql => sql === CHANNEL_WRITE_LOCK_SQL)).toHaveLength(2);
    expect(queries).not.toContain('COMMIT');
    expect(queries.at(-1)).toBe('ROLLBACK');
  });

  it('rolls back and releases the client if the callback throws', async () => {
    const { pool, queries, releases } = fixture();
    await expect(withLiveChannelWriteLock(pool, 'channel1', 'server1', async () => {
      throw new Error('db write failed');
    })).rejects.toThrow('db write failed');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(releases()).toBe(1);
  });

  it('propagates PostgreSQL failures, never changing them to an allow decision', async () => {
    const { pool, queries, releases } = fixture({ failAt: CHANNEL_WRITE_TOMBSTONE_SQL });
    await expect(withLiveChannelWriteLock(pool, 'channel1', 'server1', async () => 1))
      .rejects.toThrow('postgres unavailable');
    expect(queries.at(-1)).toBe('ROLLBACK');
    expect(releases()).toBe(1);
  });

  it('does not acquire a connection for malformed identifiers', async () => {
    const { pool, connections } = fixture();
    expect(await withLiveChannelWriteLock(pool, ' channel1 ', 'server1', async () => 1))
      .toEqual({ state: 'denied', reason: 'invalid' });
    expect(connections()).toBe(0);
  });
});
