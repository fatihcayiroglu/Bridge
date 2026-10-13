import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { portableSourceAttestationSigningBytes, type PortableSourceAttestation } from '../lib/portableSourceAttestation';
import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import {
  inspectSignedCommunityMappingReview,
  SignedCommunityMappingReviewError,
} from '../lib/portableSignedMappingReview';

const SID = 'mapped-target';
const SOURCE = 'mapped-source';
const ORIGIN = 'https://operator-pinned-mapped-source.example';
const NOW = Date.parse('2026-10-13T08:00:00.000Z');
const AT = new Date(NOW - 60_000).toISOString();
const sourceServer = { _id: SOURCE, name: 'Source community' };
const sourceCategories = [{ _id: 'source-cat', name: 'General', position: 0 }];
const sourceRoles = [{ _id: 'source-role', serverId: SOURCE, name: 'Readers', permissions: 1, position: 0 }];
const sourceChannels = [{ _id: 'source-channel', serverId: SOURCE, name: 'welcome', type: 'text', categoryId: 'source-cat', order: 0 }];

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const structure = buildPortableCommunityStructure(sourceServer, sourceCategories, sourceChannels, sourceRoles, AT);
  const permissions = buildPortableCommunityPermissionManifest(sourceServer, sourceChannels, sourceRoles, [
    { channelId: 'source-channel', canonical: [], legacy: [] },
  ], AT);
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation',
    version: 1, sourceOrigin: ORIGIN, sourceServerId: SOURCE,
    snapshotId: 'signed-mapping-snapshot-token-123456',
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    issuedAt: AT, expiresAt: new Date(NOW + 120_000).toISOString(),
    keyFingerprint: fingerprint,
  };
  const attestation = {
    ...fields,
    signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey).toString('base64url'),
  };
  const operatorRegistryJson = JSON.stringify({
    format: 'bridge-portable-source-trust-registry', version: 1,
    keys: [{ sourceOrigin: ORIGIN, publicKeyPem,
      activeFrom: new Date(NOW - 3600_000).toISOString(),
      activeUntil: new Date(NOW + 3600_000).toISOString(),
      revoked: false }],
  });
  const destination = {
    serverId: SID,
    categories: [{ _id: 'target-cat', serverId: SID, name: 'General', position: 0 }],
    roles: [{ _id: 'target-role', serverId: SID, name: 'Readers', permissions: 1, position: 0 }],
    channels: [{ _id: 'target-channel', serverId: SID, name: 'welcome', type: 'text' }],
  };
  const mapping = {
    targetServerId: SID,
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    expectedTargetDigest: fingerprintDestinationTopology(destination),
    categories: [{ sourceId: 'source-cat', targetId: 'target-cat' }],
    roles: [{ sourceId: 'source-role', targetId: 'target-role' }],
    channels: [{ sourceId: 'source-channel', targetId: 'target-channel' }],
  };
  return {
    structure, permissions, attestation, expectedSourceOrigin: ORIGIN,
    expectedSourceServerId: SOURCE, operatorRegistryJson, destination, mapping, now: NOW,
  };
}
describe('P7 signed+mapped evidence is never a migration approval', () => {
  it('binds genuine source signature, independent key, ID links and target topology deterministically', () => {
    const f = fixture();
    const first = inspectSignedCommunityMappingReview(f);
    const again = inspectSignedCommunityMappingReview(f);
    expect(first).toMatchObject({
      mode: 'read-only', sourceSignatureValid: true,
      sourceTrustPolicy: 'operator-pinned-revocable-v1',
      sourceServerId: SOURCE, targetServerId: SID,
      sourceSnapshotId: f.attestation.snapshotId,
      sourceKeyFingerprint: f.attestation.keyFingerprint,
      targetTopologyDigest: f.mapping.expectedTargetDigest,
      counts: { unsafeRoleMappings: 0, unsupportedPermissionRows: 0 },
      approvalEligible: false, mappingApproved: false,
      importSupported: false, writesPerformed: false,
      targetTopologyBound: true, transactionallyLocked: false,
      targetSnapshotAtomicityVerified: false,
    });
    expect(first.blockers).toContain('SIGNED_MAPPING_REVIEW_IS_NOT_APPROVAL');
    expect(first.blockers).not.toContain('SOURCE_AUTHENTICITY_NOT_VERIFIED');
    expect(first.reviewFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(again.reviewFingerprint).toBe(first.reviewFingerprint);
    expect(JSON.stringify(first)).not.toContain(f.operatorRegistryJson);
    expect(first).not.toHaveProperty('approvalToken');
  });

  it('refuses forged/revoked signer and edited paired manifests instead of producing mapping evidence', () => {
    const f = fixture();
    const revoked = JSON.parse(f.operatorRegistryJson);
    revoked.keys[0].revoked = true;
    const invalid = [
      { operatorRegistryJson: JSON.stringify(revoked) },
      { operatorRegistryJson: fixture().operatorRegistryJson },
      { expectedSourceOrigin: 'https://different-source.example' },
      { expectedSourceServerId: 'another-community' },
      { attestation: { ...f.attestation, snapshotId: 'altered-signed-snapshot-123456' } },
      { structure: buildPortableCommunityStructure({ ...sourceServer, name: 'Attacker' },
        sourceCategories, sourceChannels, sourceRoles, AT) },
    ];
    for (const changed of invalid) {
      expect(() => inspectSignedCommunityMappingReview({ ...f, ...changed }))
        .toThrow(SignedCommunityMappingReviewError);
    }
  });

  it('rejects stale topology fingerprint and missing or duplicate explicit target ID mappings', () => {
    const f = fixture();
    const changed = {
      ...f.destination,
      channels: [{ ...f.destination.channels[0], topic: 'updated while reviewing' }],
    };
    expect(() => inspectSignedCommunityMappingReview({ ...f, destination: changed }))
      .toThrow(SignedCommunityMappingReviewError);
    expect(() => inspectSignedCommunityMappingReview({ ...f,
      mapping: { ...f.mapping, roles: [] },
    })).toThrow(SignedCommunityMappingReviewError);
    expect(() => inspectSignedCommunityMappingReview({ ...f,
      mapping: { ...f.mapping, categories: [
        { sourceId: 'source-cat', targetId: 'target-cat' },
        { sourceId: 'source-cat', targetId: 'target-cat' },
      ] },
    })).toThrow(SignedCommunityMappingReviewError);
  });

  it('changes review hash when target choice changes; reports permission-widening without any consent', () => {
    const f = fixture();
    const original = inspectSignedCommunityMappingReview(f);
    const widened = {
      ...f.destination,
      roles: [{ ...f.destination.roles[0], permissions: 3 }],
    };
    const changed = inspectSignedCommunityMappingReview({
      ...f, destination: widened,
      mapping: { ...f.mapping, expectedTargetDigest: fingerprintDestinationTopology(widened) },
    });
    expect(changed.reviewFingerprint).not.toBe(original.reviewFingerprint);
    expect(changed.risks.rolePermissionWidening).toHaveLength(1);
    expect(changed.blockers).toContain('TARGET_ROLE_PERMISSION_WIDENING');
    expect(changed.approvalEligible).toBe(false);
    expect(changed.writesPerformed).toBe(false);
  });

  it('never treats replay of the same review fingerprint as a single-use approval', () => {
    const f = fixture();
    const proof = inspectSignedCommunityMappingReview(f);
    const repeated = inspectSignedCommunityMappingReview(f);
    expect(repeated.reviewFingerprint).toBe(proof.reviewFingerprint);
    expect(repeated.mappingApproved).toBe(false);
    expect(repeated.approvalEligible).toBe(false);
    expect(repeated.transactionallyLocked).toBe(false);
  });
});
