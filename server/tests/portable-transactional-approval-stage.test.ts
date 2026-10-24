import { deriveVerifiedPortableApprovalBinding } from '../lib/portableVerifiedApprovalBinding';
import { requireLockedPortableOwnerStepUp } from '../lib/portableLockedOwnerStepUp';
import {
  stageOwnerConfirmedPortableApproval, TransactionalPortableApprovalError,
} from '../lib/portableTransactionalApprovalStage';

jest.mock('../lib/portableVerifiedApprovalBinding', () => ({
  deriveVerifiedPortableApprovalBinding: jest.fn(),
}));
jest.mock('../lib/portableLockedOwnerStepUp', () => ({
  requireLockedPortableOwnerStepUp: jest.fn(),
}));
const sourceReview = deriveVerifiedPortableApprovalBinding as jest.MockedFunction<typeof deriveVerifiedPortableApprovalBinding>;
const stepUp = requireLockedPortableOwnerStepUp as jest.MockedFunction<typeof requireLockedPortableOwnerStepUp>;
const HASH = 'a'.repeat(64);
const binding = {
  targetServerId: 'target', ownerId: 'owner',
  reviewFingerprint: HASH, targetTopologyDigest: 'b'.repeat(64),
  targetGrantDigest: 'c'.repeat(64), sourceOrigin: 'https://source.example',
  sourceServerId: 'source', sourceSnapshotId: 'live-snapshot-12345678',
  sourceKeyFingerprint: 'd'.repeat(64), structureDigest: 'e'.repeat(64),
  permissionsDigest: 'f'.repeat(64),
};
const expiry = '2099-01-01T12:00:00.000Z';
const input = {
  targetServerId: 'target', ownerId: 'owner', stepUpGrant: 'test-grant',
  confirmedReviewFingerprint: HASH,
  structure: { format: 'signed-pair' },
  permissions: { format: 'paired-permissions' },
  attestation: { format: 'ed25519-signed' },
  expectedSourceOrigin: 'https://source.example', expectedSourceServerId: 'source',
  operatorRegistryJson: '{"operator-pinned":true}', mapping: {
    categories: [], roles: [], channels: [],
  },
  now: Date.parse('2026-10-13T17:00:00.000Z'),
};

function fixture(options: { failAt?: string; rollbackFails?: boolean } = {}) {
  const operations: string[] = [];
  const released: Array<Error | undefined> = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      operations.push(sql);
      if (options.failAt && sql.includes(options.failAt)) throw new Error('sensitive backend error');
      if (sql.includes('INSERT INTO portable_import_approvals')) {
        expect(params).toHaveLength(13);
        expect(params?.[5]).toBe(binding.targetGrantDigest);
        return { rows: [{ expires_at: '2026-10-13T17:02:00.000Z' }] };
      }
      if (sql === 'ROLLBACK' && options.rollbackFails) throw Error('rollback failed');
      return { rows: [] };
    },
    release(error?: Error) { released.push(error); },
  };
  const connect = jest.fn(async () => client);
  return { operations, released, client, pool: { connect }, connect };
}
const verifiedStepUp = {
    mode: 'transaction-check-only', action: 'account.import',
    stepUpVerified: true, consentVerified: false, tokenIssued: false,
    writesPerformed: false, importSupported: false,
} as const;
beforeEach(() => {
  sourceReview.mockReset();
  stepUp.mockReset();
  stepUp.mockResolvedValue(verifiedStepUp);
  sourceReview.mockResolvedValue({
    mode: 'transaction-check-only', binding,
    sourceAttestationExpiresAt: expiry,
    checkedChannels: 1, checkedGrants: 2,
    consentVerified: false, tokenIssued: false, writesPerformed: false,
    importSupported: false,
  });
});
describe('P7 unmounted verified approval staging on one physical transaction', () => {
  it.each([2, 3])('rolls approval back when credential freshness is lost at authorization phase %i', async phase => {
    stepUp.mockReset();
    for (let index = 1; index < phase; index++) stepUp.mockResolvedValueOnce(verifiedStepUp);
    stepUp.mockRejectedValueOnce(new Error('credential aged past the import bound'));
    const f = fixture();
    const admitted = await stageOwnerConfirmedPortableApproval({ ...input, pool: f.pool })
      .then(() => true, () => false);
    expect(admitted).toBe(false);
    expect(stepUp).toHaveBeenCalledTimes(phase);
    expect(f.operations).not.toContain('COMMIT');
    expect(f.operations.at(-1)).toBe('ROLLBACK');
    expect(f.operations.filter(sql => sql.includes('INSERT INTO portable_import_approvals'))).toHaveLength(phase === 2 ? 0 : 1);
    expect(f.released).toEqual([undefined]);
  });

  it('checks credentials then signed mapping before INSERT and returns token only after COMMIT', async () => {
    const f = fixture();
    const result = await stageOwnerConfirmedPortableApproval({ ...input, pool: f.pool });
    expect(result).toMatchObject({
      targetReviewFingerprint: HASH, approvalRecordWritten: true,
      destinationDataWritesPerformed: false, importSupported: false,
    });
    expect(result.approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.operations).toEqual([
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      expect.stringContaining('INSERT INTO portable_import_approvals'),
      'COMMIT',
    ]);
    expect(stepUp).toHaveBeenCalledWith(expect.objectContaining({
      client: f.client, ownerId: 'owner', stepUpGrant: 'test-grant',
    }));
    expect(sourceReview).toHaveBeenCalledWith(expect.objectContaining({ client: f.client }));
    expect(f.released).toEqual([undefined]);
  });
  it('rejects wrong confirmation before acquiring a client', async () => {
    const f = fixture();
    await expect(stageOwnerConfirmedPortableApproval({
      ...input, confirmedReviewFingerprint: '0'.repeat(64), pool: f.pool,
    })).rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    expect(f.operations).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
    expect(stepUp).toHaveBeenCalledTimes(1);
    expect(sourceReview).toHaveBeenCalledTimes(1);
    await expect(stageOwnerConfirmedPortableApproval({
      ...input, confirmedReviewFingerprint: '', pool: f.pool,
    })).rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  it('fails closed and rolls back when owner step-up or pinned source proof is unavailable', async () => {
    stepUp.mockRejectedValueOnce(new Error('step-up stolen bearer'));
    const a = fixture();
    await expect(stageOwnerConfirmedPortableApproval({ ...input, pool: a.pool }))
      .rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    expect(a.operations).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
    expect(sourceReview).not.toHaveBeenCalled();
    sourceReview.mockRejectedValueOnce(new Error('signature forged'));
    const b = fixture();
    await expect(stageOwnerConfirmedPortableApproval({ ...input, pool: b.pool }))
      .rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    expect(b.operations).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
  });
  it('hides approvalToken and destroys the uncertain connection on failed COMMIT', async () => {
    for (const failAt of ['INSERT INTO portable_import_approvals', 'COMMIT']) {
      const f = fixture({ failAt });
      await expect(stageOwnerConfirmedPortableApproval({ ...input, pool: f.pool }))
        .rejects.toMatchObject({ code: 'PORTABLE_TRANSACTIONAL_APPROVAL_UNAVAILABLE' });
      if (failAt === 'COMMIT') {
        expect(f.operations.at(-1)).toBe('COMMIT');
        expect(f.operations).not.toContain('ROLLBACK');
        expect(f.released[0]).toBeInstanceOf(TransactionalPortableApprovalError);
        expect(f.released[0]?.message).not.toContain('sensitive backend error');
      } else {
        expect(f.operations.at(-1)).toBe('ROLLBACK');
        expect(f.released[0]).toBeUndefined();
      }
      expect(f.released).toHaveLength(1);
    }
  });
  it('discards a client when rollback itself fails', async () => {
    stepUp.mockRejectedValueOnce(new Error('db lost'));
    const f = fixture({ rollbackFails: true });
    await expect(stageOwnerConfirmedPortableApproval({ ...input, pool: f.pool }))
      .rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    expect(f.released[0]).toBeInstanceOf(Error);
  });
});
