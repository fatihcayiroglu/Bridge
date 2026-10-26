import {
  CHANNEL_READ_EXPIRY_SQL, channelLiveForMessageRead, channelLiveWindowForRead,
  type ChannelReadQuery,
} from '../lib/channelReadExpiryGuard';
import { performance } from 'node:perf_hooks';

// These policy fixtures have no query latency. Delay/deadline behavior is
// covered separately with advancing monotonic time and real PostgreSQL.
beforeEach(() => jest.spyOn(performance, 'now').mockReturnValue(100));
afterEach(() => jest.restoreAllMocks());

const NOW = 1_800_000_000_000;
const base = {
  _id: 'channel-one', serverId: 'tenant-one', expiresAt: null,
  expiryVersion: '0', hasTombstone: false, nowMs: String(NOW),
};

function fixture(rows: Array<Record<string, unknown>> = [base]) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: ChannelReadQuery = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rows }; },
  };
  return { pool, calls };
}

describe('P7 D2 authoritative channel-message read preflight', () => {
  it('requires tenant-scoped database row, durable tombstone and database time', async () => {
    const { pool, calls } = fixture();
    expect(await channelLiveForMessageRead(pool, 'channel-one', 'tenant-one')).toBe(true);
    expect(calls).toEqual([{ sql: CHANNEL_READ_EXPIRY_SQL, params: ['channel-one', 'tenant-one'] }]);
    expect(CHANNEL_READ_EXPIRY_SQL).toMatch(/channel_expiry_tombstones/);
    expect(CHANNEL_READ_EXPIRY_SQL).toMatch(/clock_timestamp\(\)/);
    expect(CHANNEL_READ_EXPIRY_SQL).toMatch(/c\._id=\$1 AND c\."serverId"=\$2/);
  });

  it('accepts an active versioned channel, denies exactly at expiry', async () => {
    expect(await channelLiveForMessageRead(fixture([{ ...base, expiresAt: String(NOW + 1), expiryVersion: '1' }]).pool,
      'channel-one', 'tenant-one')).toBe(true);
    for (const expiry of [NOW - 1, NOW]) {
      expect(await channelLiveForMessageRead(fixture([{ ...base, expiresAt: String(expiry), expiryVersion: '1' }]).pool,
        'channel-one', 'tenant-one')).toBe(false);
    }
  });

  it.each([
    ['no row', []],
    ['more than one row', [base, base]],
    ['wrong tenant', [{ ...base, serverId: 'tenant-two' }]],
    ['mismatched channel', [{ ...base, _id: 'another' }]],
    ['tombstoned', [{ ...base, hasTombstone: true }]],
    ['invalid tombstone marker', [{ ...base, hasTombstone: 'false' }]],
    ['expired even if channel cache would be live', [{ ...base, expiresAt: NOW - 1, expiryVersion: 1 }]],
    ['missing expiry version', [{ ...base, expiryVersion: undefined }]],
    ['malformed clock', [{ ...base, nowMs: 'not-a-time' }]],
    ['corrupt expiry', [{ ...base, expiresAt: 'garbage', expiryVersion: 1 }]],
  ])('fails closed: %s', async (_, rows) => {
    expect(await channelLiveForMessageRead(fixture(rows as Record<string, unknown>[]).pool,
      'channel-one', 'tenant-one')).toBe(false);
  });

  it('rejects untrusted ids before query and never silently downgrades a DB failure', async () => {
    const { pool, calls } = fixture();
    expect(await channelLiveForMessageRead(pool, '', 'tenant-one')).toBe(false);
    expect(await channelLiveForMessageRead(pool, 'channel-one', '')).toBe(false);
    expect(await channelLiveForMessageRead(pool, 'a'.repeat(257), 'tenant-one')).toBe(false);
    expect(calls).toHaveLength(0);
    const unavailable: ChannelReadQuery = { query: async () => { throw new Error('db unavailable'); } };
    await expect(channelLiveForMessageRead(unavailable, 'channel-one', 'tenant-one'))
      .rejects.toThrow('db unavailable');
  });
});

describe('P7 D2 live window: how long a positive answer may be reused', () => {
  it('a permanent channel is live with no expiry window', async () => {
    expect(await channelLiveWindowForRead(fixture().pool, 'channel-one', 'tenant-one'))
      .toEqual({ live: true, remainingMs: null });
  });

  it('with no query latency, an expiring channel reports exactly expiresAt minus the DATABASE clock', async () => {
    const { pool, calls } = fixture([{ ...base, expiresAt: String(NOW + 1_234), expiryVersion: '1' }]);
    expect(await channelLiveWindowForRead(pool, 'channel-one', 'tenant-one')).toEqual({ live: true, remainingMs: 1_234 });
    expect(calls).toEqual([{ sql: CHANNEL_READ_EXPIRY_SQL, params: ['channel-one', 'tenant-one'] }]);
  });

  it.each([
    ['at expiry', [{ ...base, expiresAt: String(NOW), expiryVersion: '1' }]],
    ['past expiry', [{ ...base, expiresAt: String(NOW - 1), expiryVersion: '1' }]],
    ['tombstoned', [{ ...base, hasTombstone: true }]],
    ['another tenant', [{ ...base, serverId: 'tenant-two' }]],
    ['no row', []],
    ['an unparseable database clock', [{ ...base, nowMs: 'soon' }]],
    ['an expiry without version evidence', [{ ...base, expiresAt: String(NOW + 1), expiryVersion: '0' }]],
  ])('%s: closed, with no reuse window', async (_label, rows) => {
    expect(await channelLiveWindowForRead(fixture(rows).pool, 'channel-one', 'tenant-one'))
      .toEqual({ live: false, remainingMs: 0 });
  });

  it('rejects malformed identifiers without querying', async () => {
    const { pool, calls } = fixture();
    for (const [c, s] of [['', 'tenant-one'], ['channel-one', ''], ['x'.repeat(257), 'tenant-one']]) {
      expect(await channelLiveWindowForRead(pool, c, s)).toEqual({ live: false, remainingMs: 0 });
    }
    expect(calls).toEqual([]);
  });

  it('a database failure propagates (callers fail closed), as for the boolean read', async () => {
    const pool: ChannelReadQuery = { query: async () => { throw new Error('connection reset'); } };
    await expect(channelLiveWindowForRead(pool, 'channel-one', 'tenant-one')).rejects.toThrow('connection reset');
  });
});
