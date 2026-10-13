// P7 C4 — READ-ONLY, authenticated source + explicit destination mapping review.
// This is a deterministic evidence fingerprint, NOT a consent/approval token
// and not a durable database revision or a serialization lock.
import { createHash } from 'node:crypto';
import { inspectExplicitCommunityMapping } from './portableCommunityMappingReview';
import { verifyAttestationAgainstPinnedRegistry } from './portableSourceKeyring';
import type { DestinationTopology } from './portableCommunityTargetFingerprint';

export class SignedCommunityMappingReviewError extends Error {
  readonly code = 'PORTABLE_SIGNED_MAPPING_REVIEW_INVALID';
  constructor() {
    super('Signed community mapping review is unavailable');
    this.name = 'SignedCommunityMappingReviewError';
  }
}
function fail(): never { throw new SignedCommunityMappingReviewError(); }
type Link = { sourceId: string; targetId: string };
type ExplicitMapping = {
  categories: Link[];
  roles: Link[];
  channels: Link[];
};
type MappingReview = ReturnType<typeof inspectExplicitCommunityMapping>;

export function inspectSignedCommunityMappingReview(input: {
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  expectedSourceServerId: string;
  operatorRegistryJson: string;
  mapping: unknown;
  destination: DestinationTopology;
  now?: number;
}) {
  try {
    // A self-checksummed v1 pair is not authenticated: the operator's
    // independent revocable keyring must authenticate it FIRST.
    const trusted = verifyAttestationAgainstPinnedRegistry({
      structure: input.structure,
      permissions: input.permissions,
      attestation: input.attestation,
      expectedSourceOrigin: input.expectedSourceOrigin,
      expectedSourceServerId: input.expectedSourceServerId,
      operatorRegistryJson: input.operatorRegistryJson,
      now: input.now,
    });
    const mapping: MappingReview = inspectExplicitCommunityMapping(
      input.structure, input.permissions, input.mapping, input.destination,
    );
    if (trusted.sourceServerId !== mapping.sourceServerId ||
        trusted.trustedSourceOrigin !== input.expectedSourceOrigin ||
        mapping.targetServerId !== input.destination.serverId ||
        trusted.structureDigest !== mapping.sourceDigests.structure ||
        trusted.permissionsDigest !== mapping.sourceDigests.permissions ||
        !trusted.sourceSignatureValid) fail();
    const att = input.attestation as Record<string, unknown>;
    const fingerprint = att.keyFingerprint;
    const snapshot = att.snapshotId;
    const expires = att.expiresAt;
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint) ||
        typeof snapshot !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(snapshot) ||
        typeof expires !== 'string') fail();

    const links: ExplicitMapping = {
      // inspectExplicitCommunityMapping already sorts each collection and
      // rejects duplicate/missing links and cross-server destination rows.
      categories: mapping.mapping.categories,
      roles: mapping.mapping.roles,
      channels: mapping.mapping.channels,
    };
    // The versioned, domain-separated digest binds all owner-visible
    // mapping decisions to the exact signed source tuple and current target
    // fingerprint. This hash is NOT a bearer credential or DB approval.
    const reviewContext = {
      version: 1,
      sourceOrigin: input.expectedSourceOrigin,
      sourceServerId: input.expectedSourceServerId,
      sourceSnapshotId: snapshot,
      sourceKeyFingerprint: fingerprint,
      sourceAttestationExpiresAt: expires,
      structureDigest: mapping.sourceDigests.structure,
      permissionsDigest: mapping.sourceDigests.permissions,
      destinationServerId: mapping.targetServerId,
      destinationTopologyDigest: mapping.targetTopologyDigest,
      mapping: links,
      unsafeRoleMappings: mapping.counts.unsafeRoleMappings,
      unsupportedPermissionRows: mapping.counts.unsupportedPermissionRows,
    };
    const reviewFingerprint = createHash('sha256')
      .update('bridge-signed-community-mapping-review-v1\n', 'utf8')
      .update(JSON.stringify(reviewContext), 'utf8').digest('hex');
    return {
      mode: 'read-only' as const,
      sourceSignatureValid: true as const,
      sourceTrustPolicy: trusted.trustPolicy,
      trustedSourceOrigin: input.expectedSourceOrigin,
      sourceServerId: mapping.sourceServerId,
      targetServerId: mapping.targetServerId,
      sourceSnapshotId: snapshot,
      sourceKeyFingerprint: fingerprint,
      sourceDigests: mapping.sourceDigests,
      targetTopologyDigest: mapping.targetTopologyDigest,
      mapping: links,
      counts: mapping.counts,
      risks: mapping.risks,
      reviewFingerprint,
      sourceAttestationExpiresAt: expires,
      blockers: [
        // Source authenticity is proven, but remote source atomicity is NOT.
        ...mapping.blockers.filter(x => x !== 'SOURCE_AUTHENTICITY_NOT_VERIFIED'),
        'SIGNED_MAPPING_REVIEW_IS_NOT_APPROVAL',
      ],
      approvalEligible: false as const,
      mappingApproved: false as const,
      importSupported: false as const,
      writesPerformed: false as const,
      targetTopologyBound: true as const,
      transactionallyLocked: false as const,
      targetSnapshotAtomicityVerified: false as const,
    };
  } catch {
    // No distinguishable signature/mapping oracle and no partial mappings.
    return fail();
  }
}
