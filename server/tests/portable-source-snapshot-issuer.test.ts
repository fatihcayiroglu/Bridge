import { generateKeyPairSync } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { issueAtomicPortableSourceAttestation, PortableSourceSnapshotError } from '../lib/portableSourceSnapshotIssuer';
import { verifyPortableSourceAttestation } from '../lib/portableSourceAttestation';
import { CHANNEL_BATCH_READ_EXPIRY_SQL } from '../lib/channelReadExpiryGuard';

const SID = 'source-community';
const OWNER = 'source-owner';
const ORIGIN = 'https://source.example';
const NOW = Date.parse('2026-10-12T20:00:00.000Z');

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const signingPrivateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const trustedSourcePublicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rows: Record<string, Array<Record<string, unknown>>> = {
    servers: [{ _id: SID, ownerId: OWNER, name: 'Community', description: '', icon: '' }],
    channel_categories: [{ _id: 'cat', name: 'General', position: 0, collapsed: false }],
    channels: [{ _id: 'channel', serverId: SID, name: 'chat', type: 'text',
      topic: '', categoryId: 'cat', category: '', order: '0', position: 0, nsfw: 0, slowmode: 0,
      expiresAt: null, expiryVersion: 0, hasTombstone: false, nowMs: NOW }],
    roles: [{ _id: 'role', serverId: SID, name: 'Members', color: '',
      position: 0, permissions: 1 }],
    channel_permissions: [{ channelId: 'channel', serverId: SID, roleId: 'role', allow: 1, deny: 0 }],
    channel_overrides: [{ channelId: 'channel' }],
  };
  const queries: Array<{ sql: string; params?: unknown[] }> = [];
  let released = 0;
  const releaseErrors: Array<Error | undefined> = [];
  let connections = 0;
  let failTable = '';
  let failCommit = false;
  let commitCount = 0;
  let failedCommit = 0;
  let lifecycleReads = 0;
  let expireAtFinalRead = false;
  let failFinalRead = false;
  let finalCommitHook: (() => void) | undefined;
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql === 'COMMIT') {
        commitCount++;
        if (commitCount === failedCommit || failCommit) throw Error('private COMMIT response lost');
        if (commitCount === 2) finalCommitHook?.();
      }
      if (sql.startsWith('BEGIN') || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql === CHANNEL_BATCH_READ_EXPIRY_SQL) {
        lifecycleReads++;
        if (lifecycleReads === 2 && failFinalRead) throw Error('private lifecycle SQL error');
        return { rows: rows.channels.map(row => lifecycleReads === 2 && expireAtFinalRead
          ? { ...row, expiresAt: NOW - 1, expiryVersion: 1 } : { ...row }) };
      }
      const match = /\b(?:FROM|JOIN) (servers|channel_categories|channels|roles|channel_permissions|channel_overrides)\b/.exec(sql);
      if (!match) throw new Error('unexpected SQL (no fixture table)');
      const key = sql.includes('FROM channel_overrides') ? 'channel_overrides' : match[1];
      if (key === failTable) throw new Error('private SQL error including secret');
      return { rows: rows[key].map(row => ({ ...row })) };
    },
    release(error?: Error) { released++; releaseErrors.push(error); },
  };
  const pool = { async connect() { connections++; return client; } };
  const issue = (override: Record<string, unknown> = {}) => issueAtomicPortableSourceAttestation({
    pool, sourceServerId: SID, ownerUserId: OWNER, sourceOrigin: ORIGIN,
    signingPrivateKeyPem, now: NOW, ...override,
  });
  return {
    issue, rows, queries, pool, signingPrivateKeyPem, trustedSourcePublicKeyPem,
    released: () => released, connections: () => connections,
    releaseErrors,
    failCommit() { failCommit = true; },
    failSecondCommit() { failedCommit = 2; },
    expireAtFinalRead() { expireAtFinalRead = true; },
    failFinalRead() { failFinalRead = true; },
    onFinalCommit(hook: () => void) { finalCommitHook = hook; },
    failOn(table: string) { failTable = table; },
  };
}

describe('P7 C4 source graph snapshot and fresh lifecycle admission (NO import)', () => {
  it('reads both validated manifests on one readonly PG snapshot, commits before signature, verifies independently', async () => {
    const f = fixture();
    const result = await f.issue();
    const sql = f.queries.map(q => q.sql);
    expect(f.connections()).toBe(1);
    expect(f.released()).toBe(1);
    expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(sql.at(-1)).toBe('COMMIT');
    expect(sql).not.toContain('ROLLBACK');
    expect(sql.filter(s => s.startsWith('BEGIN'))).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
    ]);
    expect(sql.filter(s => s === 'COMMIT')).toHaveLength(2);
    expect(sql).toHaveLength(12);
    expect(sql.filter(s => /^SELECT/.test(s))).toHaveLength(8);
    const lifecycleQueries = f.queries.filter(q => q.sql === CHANNEL_BATCH_READ_EXPIRY_SQL);
    expect(lifecycleQueries).toHaveLength(2);
    expect(lifecycleQueries.map(q => q.params)).toEqual([[['channel']], [['channel']]]);
    for (const q of f.queries.filter(q => /^SELECT/.test(q.sql) && q.sql !== CHANNEL_BATCH_READ_EXPIRY_SQL)) {
      expect(q.params).toEqual([SID]);
      expect(q.sql).toContain('LIMIT');
      expect(q.sql).not.toMatch(/\bINSERT\b|\bUPDATE\b|\bDELETE\b/);
    }
    // Neither member identifiers nor legacy target IDs are selected/exported.
    expect(sql.join(' ')).not.toContain('"targetId"');
    expect(sql.join(' ')).not.toContain('"userId"');
    expect(result.structure.exportedAt).toBe(new Date(NOW).toISOString());
    expect(result.permissions.exportedAt).toBe(result.structure.exportedAt);
    expect(result.structure.channels[0].order).toBe(0); // PG bigint string normalized safely
    expect(result).toMatchObject({
      mode: 'read-only', importSupported: false, writesPerformed: false,
      mappingApproved: false, sourceReadIsolation: 'single-client-repeatable-read',
      remotelyVerifiedAtomicity: false,
      attestation: { sourceServerId: SID, sourceOrigin: ORIGIN },
    });
    const verify = verifyPortableSourceAttestation({
      structure: result.structure, permissions: result.permissions, attestation: result.attestation,
      expectedSourceOrigin: ORIGIN, trustedSourcePublicKeyPem: f.trustedSourcePublicKeyPem,
      now: NOW,
    });
    expect(verify).toMatchObject({ sourceSignatureValid: true, importSupported: false });
    expect(JSON.stringify(result)).not.toContain(f.signingPrivateKeyPem);
  });

  it('does not sign an ambiguous COMMIT and destroys the pooled source session', async () => {
    const f = fixture();
    f.failCommit();
    await expect(f.issue()).rejects.toBeInstanceOf(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('COMMIT');
    expect(f.queries.map(q => q.sql)).not.toContain('ROLLBACK');
    expect(f.released()).toBe(1);
    expect(f.releaseErrors).toHaveLength(1);
    expect(f.releaseErrors[0]).toBeInstanceOf(PortableSourceSnapshotError);
    expect(f.releaseErrors[0]?.message).not.toContain('private');
  });

  it('excludes expired, tombstoned and corrupt channels from both signed manifests', async () => {
    const f = fixture();
    for (const [id, lifecycle] of [
      ['expired', { expiresAt: NOW - 1, expiryVersion: 1 }],
      ['tombstoned', { hasTombstone: true }],
      ['corrupt', { expiresAt: NOW + 60000, expiryVersion: 0 }],
    ] as const) {
      f.rows.channels.push({ ...f.rows.channels[0], _id: id, name: id, topic: id + '-private-topic', ...lifecycle });
      f.rows.channel_permissions.push({ channelId: id, serverId: SID, roleId: 'role', allow: 1, deny: 0 });
    }
    const result = await f.issue();
    expect(result.structure.channels.map(channel => channel.name)).toEqual(['chat']);
    expect(result.permissions.channels.map(channel => channel.channelSourceId)).toEqual(['channel']);
    expect(JSON.stringify(result)).not.toMatch(/expired-private-topic|tombstoned-private-topic|corrupt-private-topic/);
  });

  it('refuses a channel expiring after its graph snapshot instead of signing stale metadata', async () => {
    const f = fixture();
    f.expireAtFinalRead();
    await expect(f.issue()).rejects.toBeInstanceOf(PortableSourceSnapshotError);
    expect(f.queries.filter(q => q.sql === 'COMMIT')).toHaveLength(1);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.released()).toBe(1);
  });

  it('fails closed when fresh lifecycle verification fails after the graph commits', async () => {
    const f = fixture();
    f.failFinalRead();
    await expect(f.issue()).rejects.toThrow('Portable source snapshot cannot be issued safely');
    expect(f.queries.filter(q => q.sql === 'COMMIT')).toHaveLength(1);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.releaseErrors).toEqual([undefined]);
  });

  it('discards the session when the fresh lifecycle transaction has an uncertain COMMIT', async () => {
    const f = fixture();
    f.failSecondCommit();
    await expect(f.issue()).rejects.toBeInstanceOf(PortableSourceSnapshotError);
    expect(f.queries.filter(q => q.sql === 'COMMIT')).toHaveLength(2);
    expect(f.queries.map(q => q.sql)).not.toContain('ROLLBACK');
    expect(f.releaseErrors[0]).toBeInstanceOf(PortableSourceSnapshotError);
    expect(f.released()).toBe(1);
  });

  it('generates unique snapshot tokens without reusing the signed tuple', async () => {
    const f = fixture();
    const [one, two] = [await f.issue(), await f.issue()];
    expect(one.attestation.snapshotId).not.toBe(two.attestation.snapshotId);
    expect(one.attestation.structureDigest).toBe(two.attestation.structureDigest);
    expect(one.attestation.permissionsDigest).toBe(two.attestation.permissionsDigest);
    expect(f.connections()).toBe(2);
    expect(f.released()).toBe(2);
  });

  it('does not issue an indefinitely stalled snapshot using a frozen wall clock', async () => {
    let elapsed = 0;
    const clock = jest.spyOn(performance, 'now').mockImplementation(() => elapsed);
    try {
      const f = fixture();
      f.onFinalCommit(() => { elapsed = 5 * 60_000; });
      await expect(f.issue()).rejects.toBeInstanceOf(PortableSourceSnapshotError);
      expect(f.queries.filter(q => q.sql === 'COMMIT')).toHaveLength(2);
      expect(f.queries.map(q => q.sql)).not.toContain('ROLLBACK');
      expect(f.releaseErrors).toEqual([undefined]);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    ['unauthorized owner', (f: ReturnType<typeof fixture>) => ({ ownerUserId: 'not-owner' })],
    ['untrusted source origin', (f: ReturnType<typeof fixture>) => ({ sourceOrigin: 'http://source.example' })],
    ['RSA signing key', (f: ReturnType<typeof fixture>) => ({
      signingPrivateKeyPem: generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
        .export({ type: 'pkcs8', format: 'pem' }).toString(),
    })],
  ])('fails closed for %s', async (_label, change) => {
    const f = fixture();
    await expect(f.issue(change(f))).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.some(q => q.sql === 'COMMIT')).toBe(false);
    expect(f.released()).toBe(f.connections());
  });

  it('rolls back on incomplete permissions and does not issue a signed partial snapshot', async () => {
    const f = fixture();
    f.rows.channel_permissions.push({ channelId: 'foreign', serverId: SID, roleId: 'role', allow: 1, deny: 0 });
    await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.released()).toBe(1);
  });

  it('rejects an orphan canonical permission row that claims the source server but has no channel', async () => {
    const f = fixture();
    f.rows.channel_permissions[0].channelId = 'removed-channel';
    await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.queries.some(q => q.sql.includes('p."serverId"=$1 OR p."channelId" IN'))).toBe(true);
  });

  it('rejects a channel permission row with a foreign serverId, even when the channel belongs to source', async () => {
    const f = fixture();
    f.rows.channel_permissions[0].serverId = 'another-server';
    await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('preserves enabled PostgreSQL NSFW integer rather than silently exporting false', async () => {
    const f = fixture();
    f.rows.channels[0].nsfw = 1;
    const result = await f.issue();
    expect(result.structure.channels[0].nsfw).toBe(true);
    expect(f.queries.at(-1)?.sql).toBe('COMMIT');
  });

  it.each([2, -1, null, '1', 'invalid'])(
    'rejects malformed PostgreSQL NSFW bit (%s) before source COMMIT',
    async (mask) => {
      const f = fixture();
      f.rows.channels[0].nsfw = mask;
      await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
      expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
    },
  );

  it('rejects unsafe bigint coercion and never signs rounded channel positions', async () => {
    const f = fixture();
    f.rows.channels[0].order = '9007199254740993';
    await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('rolls back on query failure and never leaks backend errors or signs', async () => {
    const f = fixture();
    f.failOn('channel_permissions');
    try {
      await f.issue();
      throw new Error('expected source issuance rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PortableSourceSnapshotError);
      expect(String(err)).not.toContain('private SQL error');
    }
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.released()).toBe(1);
  });

  it('denies over-limit source reads instead of silently truncating data', async () => {
    const f = fixture();
    f.rows.channels = Array.from({ length: 501 }, (_, i) =>
      ({ ...f.rows.channels[0], _id: `channel-${i}` }));
    await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
  });

  it('detects mismatched source manifest role references inside one snapshot', async () => {
    const f = fixture();
    f.rows.channel_permissions[0].roleId = 'other-role';
    await expect(f.issue()).rejects.toThrow(PortableSourceSnapshotError);
    expect(f.queries.at(-1)?.sql).toBe('ROLLBACK');
  });
});
