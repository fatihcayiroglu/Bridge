import {
  CHANNEL_EXPIRY_EVIDENCE_SQL,
  readAndClassifyChannelExpiry,
  type ExpiryEvidenceReader,
} from '../lib/channelExpiryEvidence';

const now = 1_800_000_000_000;
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channelId: 'c1', ownerServerId: 's1', expiresAt: null, expiryVersion: '0',
    tombstoneChannelId: null, tombstoneServerId: null,
    tombstoneExpiredAt: null, tombstoneExpiryVersion: null,
    tombstoneRecordedAt: null, tombstoneCleanupState: null,
    ...overrides,
  };
}
function reader(value: Record<string, unknown>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db: ExpiryEvidenceReader = {
    query: async (sql, params) => { calls.push({ sql, params }); return { rows: [value] }; },
  };
  return { db, calls };
}

describe('P7 D2 atomic expiry/tombstone evidence reader (NOT wired to routes)', () => {
  it('uses one parameterized statement, verifying the negative tombstone lookup', async () => {
    const { db, calls } = reader(row());
    expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', now))
      .toEqual({ state: 'permanent', accessible: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual(['c1', 's1']);
    expect(calls[0].sql).toBe(CHANNEL_EXPIRY_EVIDENCE_SQL);
    expect(calls[0].sql).toContain('LEFT JOIN channel_expiry_tombstones');
    expect(calls[0].sql).toContain('needle.channel_id');
    expect(calls[0].sql).toContain('needle.server_id');
  });

  it('never interpolates user-controlled channel or server identifiers', async () => {
    const { db, calls } = reader(row({ channelId: "c'; DELETE FROM users; --" }));
    expect(await readAndClassifyChannelExpiry(db, "c'; DELETE FROM users; --", 's1', now))
      .toEqual({ state: 'permanent', accessible: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).not.toContain('DELETE FROM users');
    expect(calls[0].params[0]).toBe("c'; DELETE FROM users; --");
  });

  it('reads expiry equality as expired, never as active', async () => {
    const { db } = reader(row({ expiresAt: String(now), expiryVersion: '1' }));
    expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', now))
      .toEqual({ state: 'expired', accessible: false });
  });

  it('denies a durable tombstone regardless of clock rollback', async () => {
    const { db } = reader(row({
      tombstoneChannelId: 'c1', tombstoneServerId: 's1',
      tombstoneExpiredAt: String(now - 1), tombstoneExpiryVersion: '2',
      tombstoneRecordedAt: String(now), tombstoneCleanupState: 'converged',
    }));
    for (const time of [now - 1000, now, now + 1000])
      expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', time))
        .toEqual({ state: 'tombstoned', accessible: false });
  });

  it('denies missing channel, malformed row, wrong tenant and inconsistent tombstones', async () => {
    for (const overrides of [
      { channelId: null, ownerServerId: null },
      { channelId: 'other' },
      { ownerServerId: 's2' },
      { expiryVersion: '01' },
      { tombstoneChannelId: 'c1', tombstoneServerId: 's2' },
      { tombstoneChannelId: 'c1', tombstoneServerId: 's1', tombstoneExpiredAt: '0',
        tombstoneExpiryVersion: '1', tombstoneRecordedAt: '1', tombstoneCleanupState: 'pending' },
    ]) {
      const { db } = reader(row(overrides));
      expect((await readAndClassifyChannelExpiry(db, 'c1', 's1', now)).accessible).toBe(false);
    }
  });

  it('treats every omitted projection alias as unverified, never as tombstone absence', async () => {
    for (const field of Object.keys(row())) {
      const incomplete = row();
      delete incomplete[field];
      const { db } = reader(incomplete);
      expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', now))
        .toEqual({ state: 'unverified', accessible: false });
    }
  });

  it('rejects contradictory LEFT JOIN null evidence instead of granting permanent access', async () => {
    for (const overrides of [
      { tombstoneChannelId: null, tombstoneServerId: 's1' },
      { tombstoneChannelId: null, tombstoneExpiredAt: String(now) },
      { tombstoneChannelId: null, tombstoneExpiryVersion: '1' },
      { tombstoneChannelId: null, tombstoneRecordedAt: String(now) },
      { tombstoneChannelId: null, tombstoneCleanupState: 'pending' },
      { channelId: null, ownerServerId: 's1' },
      { channelId: null, expiresAt: String(now + 1) },
      { channelId: null, expiryVersion: '1' },
    ]) {
      const { db } = reader(row(overrides));
      expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', now))
        .toEqual({ state: 'invalid', accessible: false });
    }
  });

  it('still recognizes a complete tombstone after channel deletion', async () => {
    const { db } = reader(row({
      channelId: null, ownerServerId: null, expiresAt: null, expiryVersion: null,
      tombstoneChannelId: 'c1', tombstoneServerId: 's1',
      tombstoneExpiredAt: String(now - 1), tombstoneExpiryVersion: '2',
      tombstoneRecordedAt: String(now), tombstoneCleanupState: 'pending',
    }));
    expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', now - 1000))
      .toEqual({ state: 'tombstoned', accessible: false });
  });

  it('database failure and unavailable evidence return unverified instead of access', async () => {
    for (const db of [
      { query: async () => { throw new Error('database offline'); } },
      { query: async () => ({ rows: [] }) },
      { query: async () => ({ rows: [row(), row()] }) },
      { query: async () => ({ rows: null as unknown as Record<string, unknown>[] }) },
    ] satisfies ExpiryEvidenceReader[]) {
      expect(await readAndClassifyChannelExpiry(db, 'c1', 's1', now))
        .toEqual({ state: 'unverified', accessible: false });
    }
  });

  it('invalid identity and untrusted clock never query database', async () => {
    let calls = 0;
    const db: ExpiryEvidenceReader = {
      query: async () => { calls++; return { rows: [row()] }; },
    };
    for (const [channel, server, time] of [
      ['', 's1', now], [' c1 ', 's1', now], ['c1', '', now],
      ['c1', 's1', NaN], ['c1', 's1', -1], ['c1', 's1', Infinity],
      ['c1', 's1', 'untrusted'],
    ] as Array<[unknown, unknown, unknown]>) {
      expect(await readAndClassifyChannelExpiry(db, channel, server, time))
        .toEqual({ state: 'invalid', accessible: false });
    }
    expect(calls).toBe(0);
  });
});
