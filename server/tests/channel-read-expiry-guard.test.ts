import {
  CHANNEL_READ_EXPIRY_SQL, channelLiveForMessageRead,
  type ChannelReadQuery,
} from '../lib/channelReadExpiryGuard';

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
