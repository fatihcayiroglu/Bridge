// P7 C4 — internal, unmounted approval staging with one physical client.
// No route invokes this service; no category/role/channel import is enabled.
// The future route MUST derive ownerId from auth and show mapping choices.
import {
  insertPortableImportApprovalWithinTransaction,
  type ApprovalPool, type ApprovalClient,
} from './portableImportApprovalLedger';
import { deriveVerifiedPortableApprovalBinding } from './portableVerifiedApprovalBinding';
import { requireLockedPortableOwnerStepUp } from './portableLockedOwnerStepUp';

const FINGERPRINT = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 1152 * 1024;

export class TransactionalPortableApprovalError extends Error {
  readonly code = 'PORTABLE_TRANSACTIONAL_APPROVAL_UNAVAILABLE';
  constructor() {
    super('Portable community approval could not be recorded');
    this.name = 'TransactionalPortableApprovalError';
  }
}
function refuse(): never { throw new TransactionalPortableApprovalError(); }

/**
 * Only a route with authenticated owner identity, explicit signed-mapping
 * presentation, fresh x-bridge-step-up and confirmedReviewFingerprint may
 * invoke this. The operator-pinned registry is never accepted from HTTP.
 *
 * One SERIALIZABLE transaction:
 *  - credential proof against current locked users row,
 *  - signed source + exact target topology/grants + OWNER row,
 *  - exact explicit review fingerprint confirmation,
 *  - 120s one-use hashed approval insertion,
 *  - COMMIT before revealing capability.
 *
 * This is NOT the importer. On-commit topology changes remain unimplemented.
 */
export async function stageOwnerConfirmedPortableApproval(input: {
  pool: ApprovalPool;
  targetServerId: string;
  ownerId: string;
  stepUpGrant: unknown;
  confirmedReviewFingerprint: unknown;
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  expectedSourceServerId: string;
  operatorRegistryJson: string;
  mapping: { categories: unknown; roles: unknown; channels: unknown };
  now?: number;
}): Promise<{
  approvalToken: string;
  expiresAt: string;
  targetReviewFingerprint: string;
  approvalRecordWritten: true;
  destinationDataWritesPerformed: false;
  importSupported: false;
}> {
  const confirmed = input.confirmedReviewFingerprint;
  if (typeof confirmed !== 'string' || !FINGERPRINT.test(confirmed)) refuse();
  // Bounds on all untrusted document data before connecting, not on secrets.
  try {
    if (Buffer.byteLength(JSON.stringify({
      structure: input.structure, permissions: input.permissions,
      attestation: input.attestation, mapping: input.mapping,
    }), 'utf8') > MAX_BODY_BYTES) refuse();
  } catch { return refuse(); }

  let client: ApprovalClient | undefined;
  let inTransaction = false;
  let committed = false;
  let commitAttempted = false;
  let discard: Error | undefined;
  try {
    client = await input.pool.connect();
    inTransaction = true;
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');

    const proof = await requireLockedPortableOwnerStepUp({
      client, ownerId: input.ownerId,
      stepUpGrant: input.stepUpGrant, now: input.now,
    });
    if (proof.stepUpVerified !== true || proof.consentVerified !== false) refuse();

    const checked = await deriveVerifiedPortableApprovalBinding({
      client, targetServerId: input.targetServerId,
      ownerId: input.ownerId,
      structure: input.structure, permissions: input.permissions,
      attestation: input.attestation,
      expectedSourceOrigin: input.expectedSourceOrigin,
      expectedSourceServerId: input.expectedSourceServerId,
      operatorRegistryJson: input.operatorRegistryJson,
      mapping: input.mapping, now: input.now,
    });
    if (checked.binding.reviewFingerprint !== confirmed ||
        checked.tokenIssued !== false || checked.importSupported !== false) refuse();

    // The destination/topology/grant locks above may have outlived the
    // credential proof checked on entry. Reuse the same locked verifier.
    if ((await requireLockedPortableOwnerStepUp({
      client, ownerId: input.ownerId, stepUpGrant: input.stepUpGrant, now: input.now,
    })).stepUpVerified !== true) refuse();

    // This is the SAME client used by both security validators above.
    const staged = await insertPortableImportApprovalWithinTransaction(
      client, checked.binding, checked.sourceAttestationExpiresAt,
    );
    if ((await requireLockedPortableOwnerStepUp({
      client, ownerId: input.ownerId, stepUpGrant: input.stepUpGrant, now: input.now,
    })).stepUpVerified !== true) refuse();
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    return {
      ...staged,
      targetReviewFingerprint: checked.binding.reviewFingerprint,
      approvalRecordWritten: true,
      destinationDataWritesPerformed: false,
      importSupported: false,
    };
  } catch {
    if (commitAttempted && !committed) {
      // COMMIT might have succeeded despite a lost acknowledgement. Neither
      // a second ROLLBACK nor a healthy pool release can make this safe.
      // Return no approval token and discard this physical connection.
      discard = new TransactionalPortableApprovalError();
    } else if (inTransaction && !committed && client) {
      try { await client.query('ROLLBACK'); } catch {
        discard = new TransactionalPortableApprovalError();
      }
    }
    return refuse();
  } finally {
    if (client) client.release(discard);
  }
}
