// P7 C4: derive a non-authorizing, exact consent-ledger binding ONLY from a
// previously authenticated source and a live locked destination review.
// UNMOUNTED: no route, no token issuance, no owner step-up or apply path.
import { inspectLockedPortableImportReview } from './portableLockedImportReview';
import type { PortableApprovalBinding } from './portableImportApprovalLedger';

type Client = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
type Signed = {
  sourceOrigin: string;
  sourceServerId: string;
  snapshotId: string;
  structureDigest: string;
  permissionsDigest: string;
  expiresAt: string;
  keyFingerprint: string;
};

export class PortableVerifiedApprovalBindingError extends Error {
  readonly code = 'PORTABLE_VERIFIED_APPROVAL_BINDING_UNAVAILABLE';
  constructor() {
    super('Verified approval evidence could not be derived');
    this.name = 'PortableVerifiedApprovalBindingError';
  }
}
function refuse(): never { throw new PortableVerifiedApprovalBindingError(); }
const SHA256 = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Caller supplies its ONE existing SERIALIZABLE READ WRITE PostgreSQL client.
 * The signed source keyring must come from operator configuration, never HTTP.
 * This helper returns only data needed by a future in-transaction consent
 * stager. It neither asserts fresh account.import proof nor stages/claims
 * tokens. The caller must never use the result as an authorization decision.
 */
export async function deriveVerifiedPortableApprovalBinding(input: {
  client: Client;
  targetServerId: string;
  ownerId: string;
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  expectedSourceServerId: string;
  operatorRegistryJson: string;
  mapping: { categories: unknown; roles: unknown; channels: unknown };
  now?: number;
}): Promise<{
  mode: 'transaction-check-only';
  binding: PortableApprovalBinding;
  sourceAttestationExpiresAt: string;
  checkedChannels: number;
  checkedGrants: number;
  consentVerified: false;
  tokenIssued: false;
  writesPerformed: false;
  importSupported: false;
}> {
  try {
    // This call verifies current OWNER, pinned & revocable source signature,
    // all source/target mapping decisions, exact topology, role policy,
    // every existing mapped channel grant on the *same client*.
    const checked = await inspectLockedPortableImportReview(input);
    if (!SHA256.test(checked.verifiedReviewFingerprint) ||
        !SHA256.test(checked.targetTopologyDigest) || !SHA256.test(checked.targetGrantDigest) ||
        checked.consentIssued !== false || checked.writesPerformed !== false) refuse();

    // Source fields are read only AFTER the Ed25519 signed tuple has been
    // verified. Never populate consent evidence from unsigned caller hashes.
    const att = input.attestation as Signed;
    if (!att || typeof att !== 'object' ||
        att.sourceOrigin !== input.expectedSourceOrigin ||
        att.sourceServerId !== input.expectedSourceServerId ||
        typeof att.snapshotId !== 'string' || !SNAPSHOT.test(att.snapshotId) ||
        typeof att.keyFingerprint !== 'string' || !SHA256.test(att.keyFingerprint) ||
        typeof att.structureDigest !== 'string' || !SHA256.test(att.structureDigest) ||
        typeof att.permissionsDigest !== 'string' || !SHA256.test(att.permissionsDigest) ||
        typeof att.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(att.expiresAt)) refuse();

    const binding: PortableApprovalBinding = {
      targetServerId: input.targetServerId,
      ownerId: input.ownerId,
      reviewFingerprint: checked.verifiedReviewFingerprint,
      targetTopologyDigest: checked.targetTopologyDigest,
      targetGrantDigest: checked.targetGrantDigest,
      sourceOrigin: input.expectedSourceOrigin,
      sourceServerId: input.expectedSourceServerId,
      sourceSnapshotId: att.snapshotId,
      sourceKeyFingerprint: att.keyFingerprint,
      structureDigest: att.structureDigest,
      permissionsDigest: att.permissionsDigest,
    };
    return {
      mode: 'transaction-check-only',
      binding,
      sourceAttestationExpiresAt: att.expiresAt,
      checkedChannels: checked.checkedChannels,
      checkedGrants: checked.checkedGrants,
      consentVerified: false,
      tokenIssued: false,
      writesPerformed: false,
      importSupported: false,
    };
  } catch {
    return refuse();
  }
}
