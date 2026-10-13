import { createHash } from 'node:crypto';
import {
  stagePortableImportApproval, claimPortableImportApproval, PortableImportApprovalError,
  type PortableApprovalBinding, type ApprovalClient,
} from '../lib/portableImportApprovalLedger';

const HEX = 'a'.repeat(64);
const binding: PortableApprovalBinding = {
  targetServerId: 'target', ownerId: 'owner',
  reviewFingerprint: 'b'.repeat(64), targetTopologyDigest: 'c'.repeat(64),
  targetGrantDigest: 'f'.repeat(64),
  sourceOrigin: 'https://source.example', sourceServerId: 'source',
  sourceSnapshotId: 'signed-source-snapshot-2026',
  sourceKeyFingerprint: 'd'.repeat(64),
  structureDigest: 'e'.repeat(64), permissionsDigest: HEX,
};
const expiry = () => new Date(Date.now() + 60_000).toISOString();

function fixture() {
  const statements: Array<{ sql: string; params?: unknown[] }> = [];
  let owner = true;
  let staging = true;
  let claiming = true;
  let commitFailure = false;
  let rollbackFailure = false;
  const release = jest.fn();
  const client: ApprovalClient = {
    release,
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.startsWith('SELECT _id FROM servers')) return { rows: owner ? [{ _id: binding.targetServerId }] : [] };
      if (sql.startsWith('INSERT INTO portable_import_approvals')) {
        return { rows: staging ? [{ expires_at: new Date(Date.now() + 60_000) }] : [] };
      }
      if (sql.startsWith('UPDATE portable_import_approvals')) {
        return { rows: claiming ? [{ token_hash: 'not-the-token' }] : [] };
      }
      if (sql === 'COMMIT' && commitFailure) throw new Error('secret COMMIT failure');
      if (sql === 'ROLLBACK' && rollbackFailure) throw new Error('secret ROLLBACK failure');
      return { rows: [] };
    },
  };
  const connect = jest.fn(async () => client);
  return {
    client, statements, release, connect, pool: { connect },
    denyOwner: () => { owner = false; },
    denyInsert: () => { staging = false; },
    denyClaim: () => { claiming = false; },
    failCommit: () => { commitFailure = true; },
    failRollback: () => { rollbackFailure = true; },
  };
}
describe('P7 C4 approval ledger — no route, no import permission', () => {
  it('stages only on SERIALIZABLE client, DB-checked owner and bounded source expiry', async () => {
    const f = fixture();
    const out = await stagePortableImportApproval({
      pool: f.pool, binding, sourceAttestationExpiresAt: expiry(),
    });
    expect(out).toMatchObject({ importSupported: false, writesPerformed: false });
    expect(out.approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.statements[0]?.sql).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
    expect(f.statements[1]?.sql).toContain('FOR UPDATE');
    const insert = f.statements.find(x => x.sql.startsWith('INSERT INTO'));
    expect(insert?.sql).toContain('LEAST(');
    expect(insert?.sql).toContain('target_grant_digest');
    expect(insert?.params?.[5]).toBe(binding.targetGrantDigest);
    expect(insert?.sql).toContain('120 seconds');
    expect(insert?.params?.[0]).toBe(createHash('sha256')
      .update('bridge-portable-import-approval-v1\n')
      .update(out.approvalToken).digest('hex'));
    expect(JSON.stringify(f.statements)).not.toContain(out.approvalToken);
    expect(f.statements.at(-1)?.sql).toBe('COMMIT');
    expect(f.release).toHaveBeenCalledWith(undefined);
  });

  it('strictly rejects malformed/missing/mutated binding without hitting DB', async () => {
    for (const invalid of [
      { ...binding, reviewFingerprint: 'deadbeef' },
      { ...binding, targetGrantDigest: 'not-a-hex-digest' },
      { ...binding, targetGrantDigest: undefined },
      { ...binding, targetGrantDigest: null },
      { ...binding, sourceOrigin: 'http://source.example' },
      { ...binding, sourceOrigin: 'https://source.example/path' },
      { ...binding, sourceSnapshotId: 'short' },
      { ...binding, ownerId: '  ' },
      { ...binding, ownerId: 'owner\n' },
      { ...binding, extra: 'anything' },
    ]) {
      const f = fixture();
      await expect(stagePortableImportApproval({
        pool: f.pool, binding: invalid, sourceAttestationExpiresAt: expiry(),
      })).rejects.toBeInstanceOf(PortableImportApprovalError);
      expect(f.connect).not.toHaveBeenCalled();
    }
    for (const bad of ['2026-10-13', 'not-a-date', '2026-02-30T00:00:00.000Z']) {
      const f = fixture();
      await expect(stagePortableImportApproval({
        pool: f.pool, binding, sourceAttestationExpiresAt: bad,
      })).rejects.toBeInstanceOf(PortableImportApprovalError);
      expect(f.connect).not.toHaveBeenCalled();
    }
  });

  it('fails closed and ROLLBACKs when OWNER row absent or insert is refused', async () => {
    for (const which of ['owner', 'insert']) {
      const f = fixture();
      if (which === 'owner') f.denyOwner(); else f.denyInsert();
      await expect(stagePortableImportApproval({
        pool: f.pool, binding, sourceAttestationExpiresAt: expiry(),
      })).rejects.toBeInstanceOf(PortableImportApprovalError);
      expect(f.statements.at(-1)?.sql).toBe('ROLLBACK');
      expect(f.statements.some(x => x.sql === 'COMMIT')).toBe(false);
      expect(f.release).toHaveBeenCalled();
    }
  });

  it('does not return token on failed COMMIT, and quarantines client after failed rollback', async () => {
    const f = fixture(); f.failCommit(); f.failRollback();
    await expect(stagePortableImportApproval({
      pool: f.pool, binding, sourceAttestationExpiresAt: expiry(),
    })).rejects.toBeInstanceOf(PortableImportApprovalError);
    expect(f.statements.map(x => x.sql).slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(f.release).toHaveBeenCalledWith(expect.any(Error));
  });

  it('claims via exact binding, DB time, unconsumed CAS and current owner; rejects replay', async () => {
    const f = fixture();
    const { approvalToken } = await stagePortableImportApproval({
      pool: f.pool, binding, sourceAttestationExpiresAt: expiry(),
    });
    await claimPortableImportApproval(f.client, approvalToken, binding);
    const update = f.statements.find(x => x.sql.startsWith('UPDATE portable_import_approvals'));
    expect(update?.sql).toContain('consumed_at IS NULL');
    expect(update?.sql).toContain('a.target_grant_digest=$6');
    expect(update?.sql).toContain('expires_at > clock_timestamp()');
    expect(update?.sql).toContain('EXISTS (SELECT 1 FROM servers s');
    expect(update?.params).toEqual([
      createHash('sha256').update('bridge-portable-import-approval-v1\n').update(approvalToken).digest('hex'),
      ...[binding.targetServerId, binding.ownerId, binding.reviewFingerprint,
        binding.targetTopologyDigest, binding.targetGrantDigest, binding.sourceOrigin, binding.sourceServerId,
        binding.sourceSnapshotId, binding.sourceKeyFingerprint,
        binding.structureDigest, binding.permissionsDigest],
    ]);
    f.denyClaim();
    await expect(claimPortableImportApproval(f.client, approvalToken, binding))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
  });

  it('rejects tampered token/target before claim and never leaks DB exception', async () => {
    const f = fixture();
    const { approvalToken } = await stagePortableImportApproval({
      pool: f.pool, binding, sourceAttestationExpiresAt: expiry(),
    });
    const count = f.statements.length;
    for (const bad of ['x', approvalToken + 'x', '']) {
      await expect(claimPortableImportApproval(f.client, bad, binding))
        .rejects.toBeInstanceOf(PortableImportApprovalError);
    }
    await expect(claimPortableImportApproval(f.client, approvalToken,
      { ...binding, targetTopologyDigest: 'z'.repeat(64) }))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
    expect(f.statements).toHaveLength(count);
    const originalQuery = f.client.query;
    f.client.query = async () => { throw new Error('private database details'); };
    await expect(claimPortableImportApproval(f.client, approvalToken, binding))
      .rejects.toMatchObject({ code: 'PORTABLE_IMPORT_APPROVAL_UNAVAILABLE',
        message: 'Portable import approval unavailable' });
    f.client.query = originalQuery;
  });
});
