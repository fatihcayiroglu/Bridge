// P7 C4 — internal atomic apply of ALREADY MAPPED destination rows.
// UNMOUNTED: never expose to HTTP until independent deploy/recovery sign-off.
// No user, member, permission, message, role-power or hierarchy migration.
import { randomUUID } from 'node:crypto';
import { validatePortableCommunityStructure } from './portableCommunityValidation';
import { requireLockedPortableOwnerStepUp } from './portableLockedOwnerStepUp';
import { deriveVerifiedPortableApprovalBinding } from './portableVerifiedApprovalBinding';
import { claimPortableImportApproval, type ApprovalPool, type ApprovalClient } from './portableImportApprovalLedger';
import { requireMappedDestinationGrantParity } from './portableTargetGrantParity';
import { liveChannelWindowsForRead } from './channelReadExpiryGuard';
import { performance } from 'node:perf_hooks';

const HEX64 = /^[0-9a-f]{64}$/;
type Link = { sourceId: string; targetId: string };
type Stage = 'after_claim' | 'after_categories' | 'after_roles' | 'after_channels' | 'before_commit';
export class PortableAtomicApplyError extends Error {
  readonly code = 'PORTABLE_ATOMIC_APPLY_UNAVAILABLE';
  constructor() { super('Portable community apply unavailable'); this.name = 'PortableAtomicApplyError'; }
}
function refuse(): never { throw new PortableAtomicApplyError(); }
async function requireLiveTargets(client: ApprovalClient, ids: string[], serverId: string): Promise<void> {
  const windows = await liveChannelWindowsForRead(client, ids.map(channelId => ({ channelId, serverId })));
  const now = performance.now();
  for (const channelId of ids) {
    const window = windows.get(channelId);
    if (!window || (window.validUntilMs !== null && window.validUntilMs <= now)) refuse();
  }
}
function links(value: unknown, expected: readonly { sourceId: string }[], max: number): Map<string, string> {
  if (!Array.isArray(value) || value.length !== expected.length || value.length > max) refuse();
  const ids = new Set(expected.map(x => x.sourceId));
  const seen = new Set<string>(), dests = new Set<string>();
  const map = new Map<string, string>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuse();
    const fields = Object.keys(item);
    if (fields.length !== 2 || !fields.includes('sourceId') || !fields.includes('targetId')) refuse();
    const { sourceId, targetId } = item as Link;
    if (typeof sourceId !== 'string' || !ids.has(sourceId) || seen.has(sourceId) ||
        typeof targetId !== 'string' || !targetId || targetId.length > 256 ||
        targetId.trim() !== targetId || dests.has(targetId)) refuse();
    seen.add(sourceId); dests.add(targetId); map.set(sourceId, targetId);
  }
  if (seen.size !== expected.length) refuse();
  return map;
}
async function updateOne(client: ApprovalClient, sql: string, params: unknown[], targetId: string): Promise<void> {
  const result = await client.query(sql, params);
  if (!result || result.rows.length !== 1 || result.rows[0]?._id !== targetId) refuse();
}
function maybeFail(at: Stage, failpoint: Stage | undefined): void {
  if (failpoint === at) {
    // Never permit an untrusted caller to turn an internal test fault on.
    if (process.env.NODE_ENV !== 'test') refuse();
    refuse();
  }
}

export async function applyApprovedPortableCommunityMapping(input: {
  pool: ApprovalPool;
  targetServerId: string;
  ownerId: string; // authenticated server-side identity, never request ownerId
  stepUpGrant: unknown;
  approvalToken: string;
  confirmedReviewFingerprint: string;
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  expectedSourceServerId: string;
  operatorRegistryJson: string; // pinned independently from operator config
  mapping: { categories: unknown; roles: unknown; channels: unknown };
  now?: number;
  /** Deterministic integration-only rollback assertions. No HTTP wiring. */
  failpoint?: Stage;
}): Promise<{
  applied: true;
  transactionCommitted: true;
  routeMounted: false;
  changed: { categories: number; roles: number; channels: number };
  grantsPreserved: true;
  identitiesPreserved: true;
}> {
  if (typeof input.confirmedReviewFingerprint !== 'string' ||
      !HEX64.test(input.confirmedReviewFingerprint) ||
      (input.failpoint !== undefined && process.env.NODE_ENV !== 'test')) refuse();

  // Deserialize strictly before even beginning a destination write.
  let structure: ReturnType<typeof validatePortableCommunityStructure>;
  let categories: Map<string, string>, roles: Map<string, string>, channels: Map<string, string>;
  try {
    structure = validatePortableCommunityStructure(input.structure);
    categories = links(input.mapping.categories, structure.categories, 2000);
    roles = links(input.mapping.roles, structure.roles, 2000);
    channels = links(input.mapping.channels, structure.channels, 500);
  } catch { return refuse(); }

  let client: ApprovalClient | undefined;
  let began = false, committed = false;
  // A rejected COMMIT does not tell us whether PostgreSQL committed. Never
  // run a compensating ROLLBACK on that uncertain session or return it to
  // the pool: a subsequent request must acquire an independent connection.
  let commitAttempted = false;
  let discard: Error | undefined;
  try {
    client = await input.pool.connect();
    began = true;
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const proof = await requireLockedPortableOwnerStepUp({
      client, ownerId: input.ownerId, stepUpGrant: input.stepUpGrant, now: input.now,
    });
    if (proof.stepUpVerified !== true) refuse();
    const verified = await deriveVerifiedPortableApprovalBinding({
      client, targetServerId: input.targetServerId, ownerId: input.ownerId,
      structure: input.structure, permissions: input.permissions,
      attestation: input.attestation, expectedSourceOrigin: input.expectedSourceOrigin,
      expectedSourceServerId: input.expectedSourceServerId, operatorRegistryJson: input.operatorRegistryJson,
      mapping: input.mapping, now: input.now,
    });
    if (verified.binding.reviewFingerprint !== input.confirmedReviewFingerprint ||
        verified.importSupported !== false || verified.tokenIssued !== false) refuse();

    // Revalidate after every destination review lock has been acquired.
    // The entry proof cannot authorize work after an arbitrarily long wait.
    if ((await requireLockedPortableOwnerStepUp({
      client, ownerId: input.ownerId, stepUpGrant: input.stepUpGrant, now: input.now,
    })).stepUpVerified !== true) refuse();

    // CAS claim and ALL updates share the identical SERIALIZABLE connection.
    // Any error rolls back consumed_at along with every affected destination row.
    await claimPortableImportApproval(client, input.approvalToken, verified.binding);

    // An approval token is one-use, but a second *fresh* approval for the
    // same signed source snapshot must never reapply it. The composite
    // UNIQUE key is a durable cross-process barrier, and its INSERT
    // rolls back with the CAS, all mapped writes and the redacted audit.
    const bound = verified.binding;
    const snapshot = await client.query(
      'INSERT INTO portable_import_snapshot_consumptions ' +
      '(target_server_id, source_origin, source_server_id, source_snapshot_id, ' +
      'source_key_fingerprint, structure_digest, permissions_digest) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) ' +
      'ON CONFLICT (target_server_id, source_origin, source_server_id, source_snapshot_id) ' +
      'DO NOTHING RETURNING source_snapshot_id',
      [bound.targetServerId, bound.sourceOrigin, bound.sourceServerId,
        bound.sourceSnapshotId, bound.sourceKeyFingerprint,
        bound.structureDigest, bound.permissionsDigest],
    );
    if (!snapshot || snapshot.rows.length !== 1 ||
        snapshot.rows[0]?.source_snapshot_id !== bound.sourceSnapshotId) refuse();
    maybeFail('after_claim', input.failpoint);

    // Upgrade the review's shared channel locks before checking its lifetime.
    // An unchanged row can still wait behind a concurrent shared holder until
    // after expiry; evaluating a WHERE predicate before that wait is too early.
    const targetIds = [...channels.values()].sort();
    if (targetIds.length) {
      const locked = await client.query(
        'SELECT _id FROM channels WHERE _id=ANY($1::text[]) AND "serverId"=$2 ORDER BY _id FOR UPDATE',
        [targetIds, input.targetServerId],
      );
      if (locked.rows.length !== targetIds.length || locked.rows.some(row =>
        typeof row._id !== 'string' || !targetIds.includes(row._id))) refuse();
    }
    await requireLiveTargets(client, targetIds, input.targetServerId);

    for (const item of structure.categories) {
      const target = categories.get(item.sourceId);
      if (!target) refuse();
      await updateOne(client,
        'UPDATE channel_categories SET name=$1, position=$2, collapsed=$3 WHERE _id=$4 AND "serverId"=$5 RETURNING _id',
        [item.name, item.position, item.collapsed, target, input.targetServerId], target);
    }
    maybeFail('after_categories', input.failpoint);

    // Preserve destination role hierarchy and permission masks. Portability
    // of the *source* role power would be a privilege-escalation bug.
    for (const item of structure.roles) {
      const target = roles.get(item.sourceId);
      if (!target) refuse();
      await updateOne(client,
        'UPDATE roles SET name=$1, color=$2 WHERE _id=$3 AND "serverId"=$4 RETURNING _id',
        [item.name, item.color, target, input.targetServerId], target);
    }
    maybeFail('after_roles', input.failpoint);

    for (const item of structure.channels) {
      const target = channels.get(item.sourceId);
      if (!target) refuse();
      const targetCategory = item.categorySourceId === null
        ? null : categories.get(item.categorySourceId);
      if (item.categorySourceId !== null && !targetCategory) refuse();
      await updateOne(client,
        'UPDATE channels SET name=$1, topic=$2, "categoryId"=$3, category=$4, "order"=$5, nsfw=$6, slowmode=$7 WHERE _id=$8 AND "serverId"=$9 AND type=$10 RETURNING _id',
        [item.name, item.topic, targetCategory, item.legacyCategoryName, item.order,
          item.nsfw ? 1 : 0, item.slowmode, target, input.targetServerId, item.type], target);
    }
    maybeFail('after_channels', input.failpoint);

    // Check that permission grants are still the exact signed/approved set.
    const after = await requireMappedDestinationGrantParity({
      client, targetServerId: input.targetServerId, ownerId: input.ownerId,
      sourcePermissions: input.permissions, mapping: input.mapping,
    });
    if (after.targetGrantDigest !== verified.binding.targetGrantDigest) refuse();

    // The audit record is durable ONLY when the same transaction commits.
    // Its bounded detail never includes owner ID, source IDs, bearer tokens,
    // attestation, signing keys, raw grants or mapping contents.
    const auditId = 'portable-mapped-' + randomUUID();
    const detail = JSON.stringify({
      mode: 'existing-mapped-metadata-only',
      categories: structure.categories.length,
      roles: structure.roles.length,
      channels: structure.channels.length,
      grantsPreserved: true,
      membershipsImported: false,
    });
    const audit = await client.query(
      'INSERT INTO audit_logs (_id, "serverId", "actorId", action, target, detail, "createdAt") ' +
      'VALUES ($1,$2,$3,$4,$5,$6,(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint) RETURNING _id',
      [auditId, input.targetServerId, input.ownerId,
        'portable.mapped_metadata.apply', input.targetServerId, detail],
    );
    if (!audit || audit.rows.length !== 1 || audit.rows[0]?._id !== auditId) refuse();
    maybeFail('before_commit', input.failpoint);
    // Metadata/FK/index/audit writes may themselves wait. Expiry rolls back
    // every mapped update, consumed approval and replay/audit row together.
    await requireLiveTargets(client, targetIds, input.targetServerId);
    // A write/constraint wait can age the proof too. Rejection rolls back the
    // claim, snapshot barrier, mapped rows and audit on this same client.
    if ((await requireLockedPortableOwnerStepUp({
      client, ownerId: input.ownerId, stepUpGrant: input.stepUpGrant, now: input.now,
    })).stepUpVerified !== true) refuse();
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    return {
      applied: true, transactionCommitted: true, routeMounted: false,
      changed: { categories: structure.categories.length, roles: structure.roles.length,
        channels: structure.channels.length },
      grantsPreserved: true, identitiesPreserved: true,
    };
  } catch {
    if (commitAttempted && !committed) {
      // COMMIT might have taken effect even if its acknowledgement was lost.
      // node-postgres release(error) destroys this client instead of reusing
      // an unknown transaction/protocol state. Do not expose error contents.
      discard = new PortableAtomicApplyError();
    } else if (began && !committed && client) {
      try { await client.query('ROLLBACK'); }
      catch { discard = new PortableAtomicApplyError(); }
    }
    return refuse();
  } finally {
    if (client) client.release(discard);
  }
}
