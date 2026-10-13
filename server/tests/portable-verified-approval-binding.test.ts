import { inspectLockedPortableImportReview } from '../lib/portableLockedImportReview';
import {
  deriveVerifiedPortableApprovalBinding,
  PortableVerifiedApprovalBindingError,
} from '../lib/portableVerifiedApprovalBinding';

jest.mock('../lib/portableLockedImportReview', () => ({
  inspectLockedPortableImportReview: jest.fn(),
}));
const verify = inspectLockedPortableImportReview as jest.MockedFunction<typeof inspectLockedPortableImportReview>;
const hash = (c: string) => c.repeat(64);
const input = {
  client: { query: jest.fn() },
  targetServerId: 'target-community',
  ownerId: 'owner-account',
  structure: { signed: 'structure' },
  permissions: { signed: 'permission-rows' },
  attestation: {
    sourceOrigin: 'https://source.example', sourceServerId: 'source-community',
    snapshotId: 'secure-source-snapshot-1234',
    structureDigest: hash('d'), permissionsDigest: hash('e'),
    keyFingerprint: hash('c'), expiresAt: '2026-10-13T18:00:00.000Z',
  },
  expectedSourceOrigin: 'https://source.example',
  expectedSourceServerId: 'source-community',
  operatorRegistryJson: '{"operator":"pinned"}',
  mapping: { categories: [], roles: [], channels: [] },
  now: Date.parse('2026-10-13T17:00:00.000Z'),
};
const reviewed = {
  mode: 'transaction-check-only' as const,
  verifiedReviewFingerprint: hash('a'),
  targetTopologyDigest: hash('b'),
  targetGrantDigest: hash('f'),
  checkedChannels: 1, checkedGrants: 2,
  consentSupported: false as const, consentIssued: false as const,
  importSupported: false as const, writesPerformed: false as const,
};
beforeEach(() => {
  verify.mockReset();
  verify.mockResolvedValue(reviewed);
});

describe('P7 C4 grant-bound ledger tuple only after locked signed review', () => {
  it('derives every ledger field exclusively from the locked review and signed proof', async () => {
    const result = await deriveVerifiedPortableApprovalBinding(input);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(input);
    expect(result).toEqual({
      mode: 'transaction-check-only',
      binding: {
        targetServerId: input.targetServerId,
        ownerId: input.ownerId,
        reviewFingerprint: reviewed.verifiedReviewFingerprint,
        targetTopologyDigest: reviewed.targetTopologyDigest,
        targetGrantDigest: reviewed.targetGrantDigest,
        sourceOrigin: input.expectedSourceOrigin,
        sourceServerId: input.expectedSourceServerId,
        sourceSnapshotId: input.attestation.snapshotId,
        sourceKeyFingerprint: input.attestation.keyFingerprint,
        structureDigest: input.attestation.structureDigest,
        permissionsDigest: input.attestation.permissionsDigest,
      },
      sourceAttestationExpiresAt: input.attestation.expiresAt,
      checkedChannels: 1,
      checkedGrants: 2,
      consentVerified: false,
      tokenIssued: false,
      writesPerformed: false,
      importSupported: false,
    });
    expect(input.client.query).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(input.operatorRegistryJson);
    expect(JSON.stringify(result)).not.toContain('approvalToken');
  });

  it('does not emit partially trusted fields when source verification or destination locks fail', async () => {
    verify.mockRejectedValue(new Error('forged source signature private internal details'));
    await expect(deriveVerifiedPortableApprovalBinding(input))
      .rejects.toMatchObject({
        code: 'PORTABLE_VERIFIED_APPROVAL_BINDING_UNAVAILABLE',
        message: 'Verified approval evidence could not be derived',
      });
  });

  it('refuses source identity substitution after the locked review', async () => {
    const mutated = [
      { ...input.attestation, sourceOrigin: 'https://other.example' },
      { ...input.attestation, sourceServerId: 'other-source' },
      { ...input.attestation, snapshotId: 'too-short' },
      { ...input.attestation, structureDigest: 'abcd' },
      { ...input.attestation, permissionsDigest: 'invalid' },
      { ...input.attestation, keyFingerprint: 'f'.repeat(63) },
      { ...input.attestation, expiresAt: 'not-an-expiry' },
    ];
    for (const attestation of mutated) {
      await expect(deriveVerifiedPortableApprovalBinding({ ...input, attestation }))
        .rejects.toBeInstanceOf(PortableVerifiedApprovalBindingError);
    }
  });

  it('refuses malformed locked fingerprints without inventing a safe digest', async () => {
    for (const field of ['verifiedReviewFingerprint', 'targetTopologyDigest', 'targetGrantDigest'] as const) {
      verify.mockResolvedValueOnce({ ...reviewed, [field]: 'bad-hash' });
      await expect(deriveVerifiedPortableApprovalBinding(input))
        .rejects.toBeInstanceOf(PortableVerifiedApprovalBindingError);
    }
    expect(verify).toHaveBeenCalledTimes(3);
  });
});
