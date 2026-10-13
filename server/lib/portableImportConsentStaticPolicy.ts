// P7 C4 — extra fail-closed STATIC safety analysis of signed mapping evidence.
// This is NOT owner consent, an authorization token, a fresh destination SQL
// snapshot, permission-grant parity or permission to stage/apply an import.
import { inspectSignedCommunityMappingReview } from './portableSignedMappingReview';
import { validatePortableCommunityStructure } from './portableCommunityValidation';
import { validatePortableCommunityPermissionManifest } from './portableCommunityPermissionsValidation';
import type { DestinationTopology } from './portableCommunityTargetFingerprint';
import { parsePermissionMask } from './permissionMaskInvariant';

// Keep in sync with canonical PERMS.MANAGE_ROLES and PERMS.ADMINISTRATOR;
// tests assert exact parity. Importing the live permissions service would
// couple this pure offline check to repositories and request state.
const PRIVILEGED_MASK = (1 << 2) | (1 << 30);

// These blockers are ALWAYS expected until an actual transactional importer
// exists. Unknown blockers fail closed rather than accidentally allowing new
// unsafe conditions added by future changes to the mapping validator.
const STRUCTURAL_ONLY_BLOCKERS = new Set([
  'IMPORT_NOT_IMPLEMENTED',
  'CROSS_FILE_SNAPSHOT_ATOMICITY_NOT_VERIFIED',
  'TARGET_TOPOLOGY_CONCURRENT_CHANGE_NOT_PREVENTED',
  'OWNER_MAPPING_APPROVAL_NOT_DURABLY_RECORDED',
  'TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED',
  'SIGNED_MAPPING_REVIEW_IS_NOT_APPROVAL',
]);
type Reason =
  | 'MAPPING_REVIEW_UNVERIFIED'
  | 'MAPPING_REVIEW_BLOCKED'
  | 'UNSUPPORTED_SOURCE_GRANTS'
  | 'ROLE_PRIVILEGE_WIDENING'
  | 'SOURCE_PRIVILEGED_ROLE_BITS'
  | 'SOURCE_PRIVILEGED_CHANNEL_GRANTS';

export type StaticConsentPolicyResult = {
  mode: 'read-only';
  staticChecksPassed: boolean;
  reasons: Reason[];
  verifiedReviewFingerprint: string | null;
  targetTopologyDigest: string | null;
  consentSupported: false;
  consentIssued: false;
  writesPerformed: false;
  importSupported: false;
  liveTargetPermissionGrantsVerified: false;
  destinationRevisionLocked: false;
  approvalReusable: false;
};

export function inspectStaticPortableImportConsentPolicy(input: {
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  expectedSourceServerId: string;
  operatorRegistryJson: string;
  mapping: unknown;
  destination: DestinationTopology;
  now?: number;
}): StaticConsentPolicyResult {
  const reasons = new Set<Reason>();
  let reviewFingerprint: string | null = null;
  let topologyDigest: string | null = null;
  try {
    // Reverify source Ed25519 signature against operator-pinned, revocable
    // keys and re-check the complete explicit target topology mapping.
    const review = inspectSignedCommunityMappingReview(input);
    reviewFingerprint = review.reviewFingerprint;
    topologyDigest = review.targetTopologyDigest;
    if (review.blockers.some(x => !STRUCTURAL_ONLY_BLOCKERS.has(x)) ||
        review.counts.unsafeRoleMappings !== 0) {
      reasons.add('MAPPING_REVIEW_BLOCKED');
    }
    if (review.counts.unsafeRoleMappings !== 0) reasons.add('ROLE_PRIVILEGE_WIDENING');
    if (review.counts.unsupportedPermissionRows !== 0) reasons.add('UNSUPPORTED_SOURCE_GRANTS');

    const structure = validatePortableCommunityStructure(input.structure);
    const permissions = validatePortableCommunityPermissionManifest(input.permissions);
    if (structure.roles.some(role =>
      (parsePermissionMask(role.permissions, 'source role mask') & PRIVILEGED_MASK) !== 0)) {
      reasons.add('SOURCE_PRIVILEGED_ROLE_BITS');
    }
    if (permissions.channels.some(channel => channel.overrides.some(grant =>
      ((parsePermissionMask(grant.allow, 'channel allow') |
         parsePermissionMask(grant.deny, 'channel deny')) & PRIVILEGED_MASK) !== 0))) {
      reasons.add('SOURCE_PRIVILEGED_CHANNEL_GRANTS');
    }
  } catch {
    // Generic invalid result: do not expose signature-verification,
    // key-revocation, mapping or topology oracle details.
    reasons.clear();
    reasons.add('MAPPING_REVIEW_UNVERIFIED');
    reviewFingerprint = null;
    topologyDigest = null;
  }
  return {
    mode: 'read-only',
    staticChecksPassed: reasons.size === 0,
    reasons: [...reasons].sort(),
    verifiedReviewFingerprint: reviewFingerprint,
    targetTopologyDigest: topologyDigest,
    consentSupported: false,
    consentIssued: false,
    writesPerformed: false,
    importSupported: false,
    liveTargetPermissionGrantsVerified: false,
    destinationRevisionLocked: false,
    approvalReusable: false,
  };
}
