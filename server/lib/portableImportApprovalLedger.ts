// P7 C4 — durable consent token/claim primitives only. NOT a migration API.
 // No route invokes these helpers. Caller must independently verify Ed25519 source,
 // OWNER + fresh account.import step-up, explicit mapping and full permission policy.
 // The eventual importer must revalidate all of that INSIDE the same SERIALIZABLE
 // transaction as claimPortableImportApproval and every destination write.
import { createHash, randomBytes } from 'node:crypto';
import { isCanonicalPortableSourceOrigin } from './portableSourceAttestation';

const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SNAPSHOT = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_ID = 256;
const FIELDS = [
  'targetServerId', 'ownerId', 'reviewFingerprint', 'targetTopologyDigest', 'targetGrantDigest',
  'sourceOrigin', 'sourceServerId', 'sourceSnapshotId', 'sourceKeyFingerprint',
  'structureDigest', 'permissionsDigest',
] as const;
export type PortableApprovalBinding = {
  targetServerId: string;
  ownerId: string;
  reviewFingerprint: string;
  targetTopologyDigest: string;
  targetGrantDigest: string;
  sourceOrigin: string;
  sourceServerId: string;
  sourceSnapshotId: string;
  sourceKeyFingerprint: string;
  structureDigest: string;
  permissionsDigest: string;
};
type Row = Record<string, unknown>;
export type ApprovalClient = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
  release(error?: Error): void;
};
export type ApprovalPool = { connect(): Promise<ApprovalClient> };

export class PortableImportApprovalError extends Error {
  readonly code = 'PORTABLE_IMPORT_APPROVAL_UNAVAILABLE';
  constructor() {
    super('Portable import approval unavailable');
    this.name = 'PortableImportApprovalError';
  }
}
function fail(): never { throw new PortableImportApprovalError(); }
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_ID && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
}
function binding(value: unknown): asserts value is PortableApprovalBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== FIELDS.length || keys.some(key => !(FIELDS as readonly string[]).includes(key))) fail();
  for (const field of ['targetServerId', 'ownerId', 'sourceServerId'] as const) {
    if (!id(obj[field])) fail();
  }
  for (const field of ['reviewFingerprint', 'targetTopologyDigest', 'targetGrantDigest',
    'sourceKeyFingerprint', 'structureDigest', 'permissionsDigest'] as const) {
    if (typeof obj[field] !== 'string' || !HEX64.test(obj[field])) fail();
  }
  if (!isCanonicalPortableSourceOrigin(obj.sourceOrigin) ||
    typeof obj.sourceSnapshotId !== 'string' || !SNAPSHOT.test(obj.sourceSnapshotId)) fail();
}
function hashToken(token: string): string {
  return createHash('sha256').update('bridge-portable-import-approval-v1\n')
    .update(token, 'utf8').digest('hex');
}
function args(b: PortableApprovalBinding): unknown[] {
  return [b.targetServerId, b.ownerId, b.reviewFingerprint, b.targetTopologyDigest,
    b.targetGrantDigest, b.sourceOrigin, b.sourceServerId, b.sourceSnapshotId, b.sourceKeyFingerprint,
    b.structureDigest, b.permissionsDigest];
}
function validSourceExpiry(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

/**
 * Internal staging only. NOT user consent: the caller must verify the source,
 * owner's fresh step-up, freshly locked grant digest and explicit safe mapping before ever exposing a route.
 * Uses DB clock and a <= 120s lifetime, additionally capped by signature expiry.
 * A failed COMMIT never returns a token. Never log approvalToken.
 */
export async function insertPortableImportApprovalWithinTransaction(
  client: Pick<ApprovalClient, 'query'>,
  checkedBinding: PortableApprovalBinding,
  sourceAttestationExpiresAt: string,
): Promise<{ approvalToken: string; expiresAt: string }> {
  // Internal primitive: caller MUST keep the same SERIALIZABLE client
  // for signed source, current owner, user step-up and grant verification.
  // The returned token must NEVER escape until an external COMMIT succeeds.
  binding(checkedBinding);
  if (!validSourceExpiry(sourceAttestationExpiresAt)) fail();
  const secret = randomBytes(32).toString('base64url');
  const digest = hashToken(secret);
  try {
    const sql = `INSERT INTO portable_import_approvals (
      token_hash, target_server_id, owner_id, review_fingerprint, target_topology_digest,
      target_grant_digest, source_origin, source_server_id, source_snapshot_id, source_key_fingerprint,
      structure_digest, permissions_digest, created_at, expires_at
    ) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,clock.ts,
      LEAST($13::timestamptz,clock.ts+INTERVAL '120 seconds')
    FROM (SELECT clock_timestamp() AS ts) AS clock
    WHERE $13::timestamptz > clock.ts
    RETURNING expires_at`;
    const res = await client.query(sql, [digest, ...args(checkedBinding), sourceAttestationExpiresAt]);
    if (res.rows.length !== 1 || !(res.rows[0]?.expires_at instanceof Date ||
      typeof res.rows[0]?.expires_at === 'string')) fail();
    return { approvalToken: secret, expiresAt: new Date(res.rows[0].expires_at as string | Date).toISOString() };
  } catch {
    return fail();
  }
}

/**
 * Backward-compatible internal staging. This primitive alone does NOT prove
 * credential freshness or mapping consent. No public route may call it.
 */
export async function stagePortableImportApproval(input: {
  pool: ApprovalPool;
  binding: PortableApprovalBinding;
  sourceAttestationExpiresAt: string;
}): Promise<{ approvalToken: string; expiresAt: string; importSupported: false; writesPerformed: false }> {
  binding(input.binding);
  if (!validSourceExpiry(input.sourceAttestationExpiresAt)) fail();
  let client: ApprovalClient | undefined;
  let began = false;
  let committed = false;
  let commitAttempted = false;
  let discard: Error | undefined;
  try {
    client = await input.pool.connect();
    began = true;
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const current = await client.query(
      'SELECT _id FROM servers WHERE _id=$1 AND "ownerId"=$2 FOR UPDATE',
      [input.binding.targetServerId, input.binding.ownerId]);
    if (current.rows.length !== 1) fail();
    const staged = await insertPortableImportApprovalWithinTransaction(
      client, input.binding, input.sourceAttestationExpiresAt,
    );
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    return { ...staged, importSupported: false, writesPerformed: false };
  } catch {
    if (commitAttempted && !committed) {
      // Unknown COMMIT acknowledgement: never expose the token, try a
      // misleading rollback, or recycle the physical session.
      discard = new PortableImportApprovalError();
    } else if (began && !committed && client) {
      try { await client.query('ROLLBACK'); } catch { discard = new PortableImportApprovalError(); }
    }
    return fail();
  } finally {
    if (client) client.release(discard);
  }
}

/**
 * Conditional one-use compare-and-set, for a FUTURE importer only.
 * Must run on the SAME physical PostgreSQL client inside the importer's
 * SERIALIZABLE transaction. A bare hash or review fingerprint is NEVER
 * authorization. All owner/signature/topology/permissions must be checked
 * freshly in that transaction before applying writes; a rollback restores
 * the uncommitted claim, while a committed claim cannot be replayed.
 */
export async function claimPortableImportApproval(
  client: Pick<ApprovalClient, 'query'>,
  approvalToken: string,
  checkedBinding: PortableApprovalBinding,
): Promise<void> {
  binding(checkedBinding);
  if (typeof approvalToken !== 'string' || !TOKEN.test(approvalToken) ||
    Buffer.from(approvalToken, 'base64url').length !== 32 ||
    Buffer.from(approvalToken, 'base64url').toString('base64url') !== approvalToken) fail();
  try {
    const sql = `UPDATE portable_import_approvals a
      SET consumed_at=clock_timestamp()
      WHERE a.token_hash=$1
        AND a.target_server_id=$2 AND a.owner_id=$3
        AND a.review_fingerprint=$4 AND a.target_topology_digest=$5
        AND a.target_grant_digest=$6
        AND a.source_origin=$7 AND a.source_server_id=$8
        AND a.source_snapshot_id=$9 AND a.source_key_fingerprint=$10
        AND a.structure_digest=$11 AND a.permissions_digest=$12
        AND a.consumed_at IS NULL AND a.expires_at > clock_timestamp()
        AND EXISTS (SELECT 1 FROM servers s
                    WHERE s._id=a.target_server_id AND s."ownerId"=a.owner_id)
      RETURNING a.token_hash`;
    const res = await client.query(sql, [hashToken(approvalToken), ...args(checkedBinding)]);
    if (res.rows.length !== 1) fail();
  } catch {
    return fail();
  }
}
