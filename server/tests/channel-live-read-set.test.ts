/**
 * P7 D2: batch channel expiry check used by search, saved and inbox.
 * PostgreSQL behaviour is proven in pg-integration/search-saved-inbox-expiry;
 * this suite pins the decision rules with a scripted query result.
 */
import { CHANNEL_BATCH_READ_EXPIRY_SQL, liveChannelIdsForRead } from '../lib/channelReadExpiryGuard';

const NOW = 1_800_000_000_000;

type Row = Record<string, unknown>;
function pool(rows: Row[] | ((ids: string[]) => Row[])) {
  const calls: Array<{ sql: string; ids: string[] }> = [];
  return {
    calls,
    async query(sql: string, params: unknown[]) {
      const ids = params[0] as string[];
      calls.push({ sql, ids });
      const all = typeof rows === 'function' ? rows(ids) : rows;
      return { rows: all.filter(row => ids.includes(String(row._id))) };
    },
  };
}
const row = (id: string, serverId: string, extra: Row = {}): Row =>
  ({ _id: id, serverId, expiresAt: null, expiryVersion: '0', hasTombstone: false, nowMs: String(NOW), ...extra });

describe('liveChannelIdsForRead', () => {
  it('keeps permanent and active channels and drops expired, tombstoned and missing ones', async () => {
    const p = pool([
      row('permanent', 's1'),
      row('active', 's1', { expiresAt: String(NOW + 60_000), expiryVersion: '1' }),
      row('expired', 's1', { expiresAt: String(NOW - 1), expiryVersion: '1' }),
      row('boundary', 's1', { expiresAt: String(NOW), expiryVersion: '1' }),
      row('tombstoned', 's1', { hasTombstone: true }),
    ]);
    const live = await liveChannelIdsForRead(p, ['permanent', 'active', 'expired', 'boundary', 'tombstoned', 'missing']
      .map(channelId => ({ channelId, serverId: 's1' })));
    expect([...live].sort()).toEqual(['active', 'permanent']);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].sql).toBe(CHANNEL_BATCH_READ_EXPIRY_SQL);
  });

  it('requires the row to belong to the server the caller expects', async () => {
    const p = pool([row('c1', 'real-server')]);
    expect([...await liveChannelIdsForRead(p, [{ channelId: 'c1', serverId: 'claimed-server' }])]).toEqual([]);
    expect([...await liveChannelIdsForRead(p, [{ channelId: 'c1', serverId: 'real-server' }])]).toEqual(['c1']);
  });

  it('excludes a channel whose pairs disagree on the server instead of choosing one', async () => {
    const p = pool([row('c1', 's1')]);
    const live = await liveChannelIdsForRead(p, [
      { channelId: 'c1', serverId: 's1' }, { channelId: 'c1', serverId: 's2' },
    ]);
    expect(live.size).toBe(0);
    expect(p.calls).toHaveLength(0);
  });

  it.each([
    ['expiry without a version', { expiresAt: String(NOW + 60_000), expiryVersion: '0' }],
    ['negative version', { expiryVersion: '-1' }],
    ['non-numeric expiry', { expiresAt: 'soon', expiryVersion: '1' }],
    ['tombstone flag not a boolean', { hasTombstone: 'false' }],
    ['unreadable database clock', { nowMs: 'not-a-clock' }],
  ])('fails closed on %s', async (_label, extra) => {
    const live = await liveChannelIdsForRead(pool([row('c1', 's1', extra)]), [{ channelId: 'c1', serverId: 's1' }]);
    expect(live.size).toBe(0);
  });

  it('skips malformed pairs without querying for them', async () => {
    const p = pool([row('ok', 's1')]);
    const live = await liveChannelIdsForRead(p, [
      { channelId: '', serverId: 's1' }, { channelId: 'x'.repeat(257), serverId: 's1' },
      { channelId: 7, serverId: 's1' }, { channelId: 'ok', serverId: null }, { channelId: 'ok', serverId: 's1' },
    ]);
    expect([...live]).toEqual(['ok']);
    expect(p.calls[0].ids).toEqual(['ok']);
  });

  it('chunks large lists so one statement never carries more than 500 ids', async () => {
    const ids = Array.from({ length: 1201 }, (_, i) => 'c' + i);
    const p = pool(batch => batch.map(id => row(id, 's1')));
    const live = await liveChannelIdsForRead(p, ids.map(channelId => ({ channelId, serverId: 's1' })));
    expect(live.size).toBe(1201);
    expect(p.calls.map(call => call.ids.length)).toEqual([500, 500, 201]);
  });

  it('propagates database failures so callers fail closed', async () => {
    const failing = { query: async () => { throw new Error('connection reset'); } };
    await expect(liveChannelIdsForRead(failing, [{ channelId: 'c1', serverId: 's1' }])).rejects.toThrow('connection reset');
    await expect(liveChannelIdsForRead({ query: async () => ({ rows: undefined as unknown as Row[] }) },
      [{ channelId: 'c1', serverId: 's1' }])).rejects.toThrow();
  });

  it('does not query at all for an empty list', async () => {
    const p = pool([]);
    expect((await liveChannelIdsForRead(p, [])).size).toBe(0);
    expect(p.calls).toHaveLength(0);
  });
});

describe('liveChannelSet unit-test fallback', () => {
  const { liveChannelSet } = require('../lib/channelLiveReadSet');

  it('classifies the record the caller holds and fails closed on its expiry metadata', async () => {
    const live: Set<string> = await liveChannelSet([
      { channelId: 'legacy', serverId: 's1' },
      { channelId: 'expired', serverId: 's1', channel: { _id: 'expired', serverId: 's1', expiresAt: 1, expiryVersion: 1 } },
      { channelId: 'other-tenant', serverId: 's1', channel: { _id: 'other-tenant', serverId: 's2' } },
    ]);
    expect([...live]).toEqual(['legacy']);
  });
});

describe('route helpers', () => {
  const live = require('../lib/channelLiveReadSet');

  it('channelRecordIsLive classifies the loaded record and rejects incomplete ones', async () => {
    expect(await live.channelRecordIsLive({ _id: 'c1', serverId: 's1' })).toBe(true);
    expect(await live.channelRecordIsLive({ _id: 'c1', serverId: 's1', expiresAt: 1, expiryVersion: 1 })).toBe(false);
    expect(await live.channelRecordIsLive({ _id: 'c1', serverId: '' })).toBe(false);
    expect(await live.channelRecordIsLive({ _id: undefined, serverId: 's1' })).toBe(false);
  });

  it('fails closed outside tests when no PostgreSQL pool exists', async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(live.channelRecordIsLive({ _id: 'c1', serverId: 's1' })).rejects.toBeInstanceOf(live.ChannelAvailabilityUnverifiable);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it('channelAvailabilityErrors answers 503 only for an unverifiable check', () => {
    const res = () => {
      const r = { headersSent: false, code: 0, body: undefined as unknown,
        status(code: number) { r.code = code; return { json: (body: unknown) => { r.body = body; } }; } };
      return r;
    };
    const next = jest.fn();
    const r1 = res();
    live.channelAvailabilityErrors(new live.ChannelAvailabilityUnverifiable(), {}, r1, next);
    expect(r1.code).toBe(503);
    expect(next).not.toHaveBeenCalled();
    const other = new Error('boom');
    live.channelAvailabilityErrors(other, {}, res(), next);
    expect(next).toHaveBeenLastCalledWith(other);
    const sent = Object.assign(res(), { headersSent: true });
    const err = new live.ChannelAvailabilityUnverifiable();
    live.channelAvailabilityErrors(err, {}, sent, next);
    expect(next).toHaveBeenLastCalledWith(err);
    expect(sent.code).toBe(0);
  });
});
