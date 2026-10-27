import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { requireLockedPortableOwnerStepUp } from '../lib/portableLockedOwnerStepUp';
import { deriveVerifiedPortableApprovalBinding } from '../lib/portableVerifiedApprovalBinding';
import { claimPortableImportApproval } from '../lib/portableImportApprovalLedger';
import { requireMappedDestinationGrantParity } from '../lib/portableTargetGrantParity';
import { applyApprovedPortableCommunityMapping, PortableAtomicApplyError } from '../lib/portableAtomicMappedApply';

jest.mock('../lib/portableLockedOwnerStepUp', () => ({ requireLockedPortableOwnerStepUp: jest.fn() }));
jest.mock('../lib/portableVerifiedApprovalBinding', () => ({ deriveVerifiedPortableApprovalBinding: jest.fn() }));
jest.mock('../lib/portableImportApprovalLedger', () => ({ claimPortableImportApproval: jest.fn() }));
jest.mock('../lib/portableTargetGrantParity', () => ({ requireMappedDestinationGrantParity: jest.fn() }));

const step = requireLockedPortableOwnerStepUp as jest.Mock;
const review = deriveVerifiedPortableApprovalBinding as jest.Mock;
const claim = claimPortableImportApproval as jest.Mock;
const grants = requireMappedDestinationGrantParity as jest.Mock;
const digest = (c: string) => c.repeat(64);
const structure = buildPortableCommunityStructure(
  { _id: 'source', name: 'Source' },
  [{ _id: 'sc', name: 'Imported category', position: 4, collapsed: true }],
  [{ _id: 'sch', name: 'Imported channel', type: 'text', topic: 'Imported topic',
    categoryId: 'sc', category: 'IMPORTED', order: 7, nsfw: true, slowmode: 5 }],
  [{ _id: 'sr', name: 'Imported role', color: '#abcdef', position: 5, permissions: 1 }],
  '2026-10-13T12:00:00.000Z',
);
const mapping = {
  categories: [{ sourceId: 'sc', targetId: 'tc' }],
  roles: [{ sourceId: 'sr', targetId: 'tr' }],
  channels: [{ sourceId: 'sch', targetId: 'tch' }],
};
const input = {
  targetServerId: 'dest', ownerId: 'owner', approvalToken: 'x'.repeat(43),
  stepUpGrant: 'short-lived-sign-in-grant',
  confirmedReviewFingerprint: digest('a'),
  structure, permissions: { signed: true }, attestation: { signature: 'signed' },
  expectedSourceOrigin: 'https://src.example', expectedSourceServerId: 'source',
  operatorRegistryJson: 'operator-pinned',
  mapping, now: Date.parse('2026-10-13T17:00:00.000Z'),
};
function fixture(failSQL?: string) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const released: Array<Error | undefined> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      if (failSQL && sql.includes(failSQL)) throw Error('internal secret');
      if (sql.startsWith('INSERT INTO portable_import_snapshot_consumptions')) {
        if (failSQL === 'SNAPSHOT_CONFLICT') return { rows: [] };
        return { rows: [{ source_snapshot_id: params?.[3] }] };
      }
      if (sql.startsWith('INSERT INTO audit_logs')) {
        return { rows: [{ _id: params?.[0] }] };
      }
      if (sql.startsWith('SELECT _id FROM channels')) {
        return { rows: (params?.[0] as string[]).map(_id => ({ _id })) };
      }
      if (sql.includes('AS "hasTombstone"')) {
        const expired = failSQL === 'EXPIRED_TARGET' || (failSQL === 'EXPIRE_AFTER_AUDIT' &&
          calls.some(call => call.sql.startsWith('INSERT INTO audit_logs')));
        return { rows: (params?.[0] as string[]).map(_id => ({
          _id, serverId: input.targetServerId, expiresAt: expired ? input.now - 1 : null,
          expiryVersion: expired ? 1 : 0, hasTombstone: failSQL === 'TOMBSTONED_TARGET', nowMs: input.now,
        })) };
      }
      if (sql.startsWith('UPDATE')) {
        return { rows: [{ _id: params?.[sql.includes('UPDATE channel_categories') ? 3
          : sql.includes('UPDATE roles') ? 2 : 7] }] };
      }
      return { rows: [] };
    },
    release(error?: Error) { released.push(error); },
  };
  const pool = { connect: jest.fn(async () => client) };
  return { pool, client, calls, released };
}
beforeEach(() => {
  step.mockReset(); review.mockReset(); claim.mockReset(); grants.mockReset();
  step.mockResolvedValue({ stepUpVerified: true });
  review.mockResolvedValue({
    binding: {
      reviewFingerprint: digest('a'), targetGrantDigest: digest('g'),
      targetServerId: 'dest', sourceOrigin: 'https://src.example',
      sourceServerId: 'source', sourceSnapshotId: 'source-snapshot-id-123456',
      sourceKeyFingerprint: digest('k'), structureDigest: digest('s'),
      permissionsDigest: digest('p'),
    },
    tokenIssued: false, importSupported: false,
  });
  grants.mockResolvedValue({ targetGrantDigest: digest('g') });
  claim.mockResolvedValue(undefined);
});
describe('P7 C4 internal mapped atomic category/role/channel importer', () => {
  it.each(['EXPIRED_TARGET', 'TOMBSTONED_TARGET'])('denies %s before mapped writes and leaves the approval transaction rolled back', async state => {
    const f = fixture(state);
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(f.calls.some(call => call.sql.startsWith('UPDATE'))).toBe(false);
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.some(call => call.sql === 'COMMIT')).toBe(false);
  });

  it('rolls back after the audit write if the final authoritative read says the target expired', async () => {
    const f = fixture('EXPIRE_AFTER_AUDIT');
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(f.calls.some(call => call.sql.startsWith('UPDATE channels'))).toBe(true);
    expect(f.calls.some(call => call.sql.startsWith('INSERT INTO audit_logs'))).toBe(true);
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.some(call => call.sql === 'COMMIT')).toBe(false);
    expect(f.released).toEqual([undefined]);
  });
  it.each([2, 3])('rolls apply back when credential freshness is lost at authorization phase %i', async phase => {
    step.mockReset();
    for (let index = 1; index < phase; index++) step.mockResolvedValueOnce({ stepUpVerified: true });
    step.mockRejectedValueOnce(new Error('credential aged past the import bound'));
    const f = fixture();
    const admitted = await applyApprovedPortableCommunityMapping({ ...input, pool: f.pool })
      .then(() => true, () => false);
    expect(admitted).toBe(false);
    expect(step).toHaveBeenCalledTimes(phase);
    expect(claim).toHaveBeenCalledTimes(phase === 2 ? 0 : 1);
    expect(f.calls.map(call => call.sql)).not.toContain('COMMIT');
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.filter(call => call.sql.startsWith('UPDATE'))).toHaveLength(phase === 2 ? 0 : 3);
    expect(f.released).toEqual([undefined]);
  });

  it('uses a single client, preserves role permission hierarchy, and only declares apply after commit', async () => {
    const f = fixture();
    const result = await applyApprovedPortableCommunityMapping({ ...input, pool: f.pool });
    expect(result).toMatchObject({
      applied: true, transactionCommitted: true, routeMounted: false,
      changed: { categories: 1, roles: 1, channels: 1 },
      grantsPreserved: true, identitiesPreserved: true,
    });
    expect(f.calls.map(c => c.sql)).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      expect.stringContaining('INSERT INTO portable_import_snapshot_consumptions'),
      expect.stringContaining('SELECT _id FROM channels'),
      expect.stringContaining('AS "hasTombstone"'),
      expect.stringContaining('UPDATE channel_categories'),
      expect.stringContaining('UPDATE roles'),
      expect.stringContaining('UPDATE channels'),
      expect.stringContaining('INSERT INTO audit_logs'),
      expect.stringContaining('AS "hasTombstone"'),
      'COMMIT',
    ]);
    const replay = f.calls.find(c => c.sql.startsWith('INSERT INTO portable_import_snapshot_consumptions'));
    expect(replay?.params).toEqual([
      'dest', 'https://src.example', 'source', 'source-snapshot-id-123456',
      digest('k'), digest('s'), digest('p'),
    ]);
    expect(f.calls.find(c => c.sql.includes('UPDATE roles'))?.sql).not.toContain('permissions');
    expect(f.calls.find(c => c.sql.includes('UPDATE roles'))?.sql).not.toContain('position');
    expect(f.calls.find(c => c.sql.includes('UPDATE channels'))?.params).toEqual([
      'Imported channel', 'Imported topic', 'tc', 'IMPORTED', 7, 1, 5, 'tch', 'dest', 'text',
    ]);
    expect(step).toHaveBeenCalledWith(expect.objectContaining({ client: f.client }));
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ client: f.client }));
    expect(claim).toHaveBeenCalledWith(f.client, input.approvalToken,
      expect.objectContaining({ targetGrantDigest: digest('g') }));
    expect(grants).toHaveBeenCalledWith(expect.objectContaining({ client: f.client }));
    const audited = f.calls.find(c => c.sql.startsWith('INSERT INTO audit_logs'));
    expect(audited?.params?.[3]).toBe('portable.mapped_metadata.apply');
    expect(JSON.parse(audited?.params?.[5] as string)).toEqual({
      mode: 'existing-mapped-metadata-only', categories: 1, roles: 1, channels: 1,
      grantsPreserved: true, membershipsImported: false,
    });
    const auditDetails = String(audited?.params?.[5]);
    for (const sensitive of ['owner', input.approvalToken, 'https://src.example', 'operator-pinned']) {
      expect(auditDetails).not.toContain(sensitive);
    }
    expect(f.released).toEqual([undefined]);
  });

  it.each([
    'after_claim', 'after_categories', 'after_roles', 'after_channels', 'before_commit',
  ] as const)('rolls back every write and approval CAS when %s fails', async failpoint => {
    const f = fixture();
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool, failpoint }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(f.calls[0]?.sql).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.map(c => c.sql)).not.toContain('COMMIT');
    expect(f.released).toEqual([undefined]);
  });

  it('rolls back and never returns success when the claim, grant parity or COMMIT fails', async () => {
    claim.mockRejectedValueOnce(Error('token spent'));
    const a = fixture();
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: a.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(a.calls.map(c => c.sql)).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
    grants.mockResolvedValueOnce({ targetGrantDigest: digest('f') });
    const b = fixture();
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: b.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(b.calls.at(-1)?.sql).toBe('ROLLBACK');
    const snapshotConflict = fixture('SNAPSHOT_CONFLICT');
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: snapshotConflict.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(snapshotConflict.calls.map(c => c.sql).filter(c => c.startsWith('UPDATE'))).toHaveLength(0);
    expect(snapshotConflict.calls.at(-1)?.sql).toBe('ROLLBACK');

    const missingBarrier = fixture('INSERT INTO portable_import_snapshot_consumptions');
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: missingBarrier.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(missingBarrier.calls.at(-1)?.sql).toBe('ROLLBACK');
    const auditFailure = fixture('INSERT INTO audit_logs');
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: auditFailure.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(auditFailure.calls.at(-1)?.sql).toBe('ROLLBACK');
    const c = fixture('COMMIT');
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: c.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    // A rejected COMMIT is ambiguous, even if the mock rejected before
    // the server committed. No ROLLBACK may be presumed to undo it and
    // the pool must destroy the connection rather than loan it again.
    expect(c.calls.at(-1)?.sql).toBe('COMMIT');
    expect(c.calls.map(x => x.sql)).not.toContain('ROLLBACK');
    expect(c.released).toHaveLength(1);
    expect(c.released[0]).toBeInstanceOf(PortableAtomicApplyError);
    expect(c.released[0]?.message).not.toContain('internal secret');
  });

  it('fails closed before acquiring a connection for malformed structure or mapping', async () => {
    for (const override of [
      { mapping: { ...mapping, channels: [{ sourceId: 'sch', targetId: '' }] } },
      { mapping: { ...mapping, roles: [] } },
      { structure: { ...structure, version: 2 } },
      { confirmedReviewFingerprint: 'forged' },
    ]) {
      const f = fixture();
      await expect(applyApprovedPortableCommunityMapping({ ...input, ...override, pool: f.pool }))
        .rejects.toBeInstanceOf(PortableAtomicApplyError);
      expect(f.pool.connect).not.toHaveBeenCalled();
    }
  });

  it('refuses mapping items that are not exactly {sourceId, targetId} before connecting', async () => {
    for (const channels of [
      [{ sourceId: 'sch', targetId: 'tch', permissions: 8 }],   // smuggled extra field
      [{ sourceId: 'sch' }],                                       // missing target
      [null],
      ['sch'],
    ]) {
      const f = fixture();
      await expect(applyApprovedPortableCommunityMapping({ ...input, mapping: { ...mapping, channels }, pool: f.pool }))
        .rejects.toBeInstanceOf(PortableAtomicApplyError);
      expect(f.pool.connect).not.toHaveBeenCalled();
    }
  });

  it('rolls everything back when a mapped target is not a row of the destination server', async () => {
    // A target id of ANOTHER server: `WHERE _id=$ AND "serverId"=$` matches nothing.
    const f = fixture();
    const query = f.client.query.bind(f.client);
    f.client.query = async (sql: string, params?: unknown[]) =>
      sql.includes('UPDATE channels') ? (f.calls.push({ sql, params }), { rows: [] }) : query(sql, params);
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.map(c => c.sql)).not.toContain('COMMIT');
    expect(f.calls.some(c => c.sql.startsWith('INSERT INTO audit_logs'))).toBe(false);
    expect(f.released).toEqual([undefined]);
  });

  it('refuses a step-up proof that does not explicitly verify, before any claim', async () => {
    step.mockResolvedValueOnce({ stepUpVerified: 'yes' });
    const f = fixture();
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(review).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(f.calls.map(c => c.sql)).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
  });

  it('rolls back when the audit insert does not return its own row', async () => {
    const f = fixture();
    const query = f.client.query.bind(f.client);
    f.client.query = async (sql: string, params?: unknown[]) =>
      sql.startsWith('INSERT INTO audit_logs') ? (f.calls.push({ sql, params }), { rows: [{ _id: 'someone-else' }] }) : query(sql, params);
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');
    expect(f.calls.map(c => c.sql)).not.toContain('COMMIT');
  });

  it('applies an uncategorized, non-NSFW channel with a null category and nsfw 0', async () => {
    const plain = buildPortableCommunityStructure(
      { _id: 'source', name: 'Source' }, [],
      [{ _id: 'sch', name: 'Plain channel', type: 'text', topic: '', order: 1, nsfw: false, slowmode: 0 }],
      [], '2026-10-13T12:00:00.000Z',
    );
    const f = fixture();
    const result = await applyApprovedPortableCommunityMapping({
      ...input, structure: plain, pool: f.pool,
      mapping: { categories: [], roles: [], channels: [{ sourceId: 'sch', targetId: 'tch' }] },
    });
    expect(result.changed).toEqual({ categories: 0, roles: 0, channels: 1 });
    const update = f.calls.find(c => c.sql.includes('UPDATE channels'));
    expect(update?.params?.[2]).toBeNull();      // categoryId
    expect(update?.params?.[5]).toBe(0);          // nsfw
  });

  it('never runs a query or releases a connection it could not obtain', async () => {
    const f = fixture();
    f.pool.connect.mockRejectedValueOnce(Error('pool exhausted: secret dsn'));
    const error = await applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }).catch(e => e);
    expect(error).toBeInstanceOf(PortableAtomicApplyError);
    expect(String(error)).not.toContain('secret dsn');
    expect(f.calls).toHaveLength(0);
    expect(f.released).toHaveLength(0);
  });

  it('rejects mismatched fresh review and revoked step-up before claim', async () => {
    review.mockResolvedValueOnce({
      binding: { reviewFingerprint: digest('b'), targetGrantDigest: digest('g') },
      tokenIssued: false, importSupported: false,
    });
    const f = fixture();
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(claim).not.toHaveBeenCalled();
    step.mockRejectedValueOnce(Error('revoked'));
    const g = fixture();
    await expect(applyApprovedPortableCommunityMapping({ ...input, pool: g.pool }))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(review).toHaveBeenCalledTimes(1);
  });
});
