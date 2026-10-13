// Full signed source/target review on one real PostgreSQL transaction.
// Never skip on an unavailable PG_TEST_URL.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintStepUpGrant } from '../../lib/stepUp';
import { stageOwnerConfirmedPortableApproval } from '../../lib/portableTransactionalApprovalStage';
import { applyApprovedPortableCommunityMapping, PortableAtomicApplyError } from '../../lib/portableAtomicMappedApply';
import { deriveVerifiedPortableApprovalBinding } from '../../lib/portableVerifiedApprovalBinding';
import { claimPortableImportApproval, PortableImportApprovalError } from '../../lib/portableImportApprovalLedger';
import { buildPortableCommunityStructure } from '../../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../../lib/portableCommunityPermissions';
import { fingerprintDestinationTopology } from '../../lib/portableCommunityTargetFingerprint';
import { portableSourceAttestationSigningBytes, type PortableSourceAttestation } from '../../lib/portableSourceAttestation';
import { inspectLockedPortableImportReview, LockedPortableReviewError } from '../../lib/portableLockedImportReview';

const URL = process.env.PG_TEST_URL;
if (!URL) throw new Error('PG_TEST_URL required for P7 locked source/target review');
const schema = 'p7locked_' + randomBytes(8).toString('hex');
const quoted = '"' + schema + '"';
const SID = 'dest';
const SOURCE = 'src';
const ORIGIN = 'https://locked-db-source.example';
const NOW = Date.now();
const AT = new Date(NOW - 60_000).toISOString();

const sourceServer = { _id: SOURCE, name: 'Source' };
const sourceCats = [{ _id: 'scat', serverId: SOURCE, name: 'Imported category', position: 4, collapsed: true }];
const sourceRoles = [{ _id: 'sr', serverId: SOURCE, name: 'Imported role',
  color: '#abcdef', position: 4, permissions: 1 }];
const sourceChannels = [{ _id: 'sch', serverId: SOURCE, name: 'imported-welcome', type: 'text',
  topic: 'Imported topic', categoryId: 'scat', category: 'IMPORTED', order: 7, nsfw: true, slowmode: 5 }];
const structure = buildPortableCommunityStructure(sourceServer, sourceCats, sourceChannels, sourceRoles, AT);
const permissions = buildPortableCommunityPermissionManifest(
  sourceServer, sourceChannels, sourceRoles, [{
    channelId: 'sch', canonical: [{ channelId: 'sch', roleId: 'sr', allow: 1, deny: 0 }],
    legacy: [],
  }], AT,
);
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const fingerprint = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
const fields: Omit<PortableSourceAttestation, 'signature'> = {
  format: 'bridge-portable-community-source-attestation', version: 1,
  sourceOrigin: ORIGIN, sourceServerId: SOURCE, snapshotId: 'locked-pg-snapshot-123456',
  structureDigest: structure.integrity.digest, permissionsDigest: permissions.integrity.digest,
  issuedAt: AT, expiresAt: new Date(NOW + 120_000).toISOString(), keyFingerprint: fingerprint,
};
const attestation = { ...fields, signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey).toString('base64url') };
const operatorRegistryJson = JSON.stringify({
  format: 'bridge-portable-source-trust-registry', version: 1,
  keys: [{ sourceOrigin: ORIGIN, publicKeyPem, activeFrom: new Date(NOW - 3600_000).toISOString(),
    activeUntil: new Date(NOW + 3600_000).toISOString(), revoked: false }],
});
const topology = {
  serverId: SID,
  categories: [{ _id: 'tc', serverId: SID, name: 'General', position: 0, collapsed: false }],
  roles: [{ _id: 'tr', serverId: SID, name: 'Readers', color: '#99aab5', position: 0, permissions: 1 }],
  channels: [{ _id: 'tch', serverId: SID, name: 'welcome', type: 'text',
    topic: '', categoryId: 'tc', category: 'GENERAL', order: 0, nsfw: false, slowmode: 0 }],
};
const mapping = {
  targetServerId: SID, structureDigest: structure.integrity.digest,
  permissionsDigest: permissions.integrity.digest,
  expectedTargetDigest: fingerprintDestinationTopology(topology),
  categories: [{ sourceId: 'scat', targetId: 'tc' }],
  roles: [{ sourceId: 'sr', targetId: 'tr' }],
  channels: [{ sourceId: 'sch', targetId: 'tch' }],
};
const savedStepupSecret = process.env.STEP_UP_SECRET;
let admin: Pool, pool: Pool, rival: Pool;
beforeAll(async () => {
  process.env.STEP_UP_SECRET = 'p7-portable-stage-pg-test-only';
  admin = new Pool({ connectionString: URL, max: 1 });
  await admin.query('CREATE SCHEMA ' + quoted);
  pool = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  rival = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  await pool.query('CREATE TABLE servers (_id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL)');
  await pool.query('CREATE TABLE users (_id TEXT PRIMARY KEY, "tokenVersion" INTEGER NOT NULL, "twoFactorEnabled" BOOLEAN NOT NULL)');
  await pool.query('CREATE TABLE channel_categories (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, collapsed BOOLEAN NOT NULL)');
  await pool.query('CREATE TABLE roles (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL, permissions INTEGER NOT NULL)');
  await pool.query('CREATE TABLE channels (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, "categoryId" TEXT, category TEXT NOT NULL, "order" BIGINT NOT NULL, nsfw INTEGER NOT NULL, slowmode INTEGER NOT NULL)');
  await pool.query('CREATE TABLE channel_permissions ("channelId" TEXT NOT NULL, "serverId" TEXT NOT NULL, "roleId" TEXT NOT NULL, allow BIGINT NOT NULL, deny BIGINT NOT NULL)');
  await pool.query('CREATE TABLE channel_overrides ("channelId" TEXT NOT NULL)');
  await pool.query('CREATE TABLE audit_logs (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, "actorId" TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, "createdAt" BIGINT NOT NULL)');
  await pool.query("INSERT INTO servers VALUES ('dest','owner')");
  await pool.query("INSERT INTO users VALUES ('owner',4,FALSE)");
  await pool.query("INSERT INTO channel_categories VALUES ('tc','dest','General',0,FALSE)");
  await pool.query("INSERT INTO roles VALUES ('tr','dest','Readers','#99aab5',0,1)");
  await pool.query("INSERT INTO channels VALUES ('tch','dest','welcome','text','','tc','GENERAL',0,0,0)");
  await pool.query("INSERT INTO channel_permissions VALUES ('tch','dest','tr',1,0)");
  await pool.query(readFileSync(join(__dirname,
    '../../db/migrations_pg/081_portable_import_approval_ledger.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname,
    '../../db/migrations_pg/082_portable_import_approval_grant_binding.sql'), 'utf8'));
  await pool.query(readFileSync(join(__dirname,
    '../../db/migrations_pg/083_portable_import_snapshot_replay_barrier.sql'), 'utf8'));
}, 60_000);
afterAll(async () => {
  if (pool) await pool.end();
  if (rival) await rival.end();
  if (admin) {
    try { await admin.query('DROP SCHEMA ' + quoted + ' CASCADE'); }
    finally { await admin.end(); }
  }
  if (savedStepupSecret === undefined) delete process.env.STEP_UP_SECRET;
  else process.env.STEP_UP_SECRET = savedStepupSecret;
}, 60_000);

function review(client: import('pg').PoolClient, ownerId = 'owner') {
  return inspectLockedPortableImportReview({
    client, targetServerId: SID, ownerId, structure, permissions, attestation,
    expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
    operatorRegistryJson, mapping, now: NOW,
  });
}

function ownerGrant() {
  return mintStepUpGrant({ _id: 'owner', tokenVersion: 4 }, 'password', 'account-security', NOW).token;
}
async function reviewFingerprint(
  signed = attestation, reviewedStructure = structure, reviewedMapping = mapping,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const verified = await deriveVerifiedPortableApprovalBinding({
      client, targetServerId: SID, ownerId: 'owner', structure: reviewedStructure, permissions,
      attestation: signed, expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
      operatorRegistryJson, mapping: reviewedMapping, now: NOW,
    });
    await client.query('ROLLBACK');
    return verified.binding.reviewFingerprint;
  } finally { client.release(); }
}
async function approve(
  confirmedReviewFingerprint: string, stepUpGrant = ownerGrant(),
  signed = attestation, reviewedStructure = structure, reviewedMapping = mapping,
) {
  return stageOwnerConfirmedPortableApproval({
    pool, targetServerId: SID, ownerId: 'owner', stepUpGrant,
    confirmedReviewFingerprint, structure: reviewedStructure, permissions, attestation: signed,
    expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
    operatorRegistryJson, mapping: reviewedMapping, now: NOW,
  });
}

async function destinationSnapshot() {
  const [cats, roles, channels, grants, audit, snapshots] = await Promise.all([
    pool.query('SELECT * FROM channel_categories ORDER BY _id'),
    pool.query('SELECT * FROM roles ORDER BY _id'),
    pool.query('SELECT * FROM channels ORDER BY _id'),
    pool.query('SELECT * FROM channel_permissions ORDER BY "channelId", "roleId"'),
    pool.query('SELECT * FROM audit_logs ORDER BY _id'),
    pool.query('SELECT * FROM portable_import_snapshot_consumptions ORDER BY source_snapshot_id'),
  ]);
  return { cats: cats.rows, roles: roles.rows, channels: channels.rows,
    grants: grants.rows, audit: audit.rows, snapshots: snapshots.rows };
}
function apply(approvalToken: string, confirmedReviewFingerprint: string,
  failpoint?: 'after_claim' | 'after_categories' | 'after_roles' | 'after_channels' | 'before_commit') {
  return applyApprovedPortableCommunityMapping({
    pool, approvalToken, confirmedReviewFingerprint,
    ownerId: 'owner', targetServerId: SID, stepUpGrant: ownerGrant(),
    structure, permissions, attestation,
    expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
    mapping, operatorRegistryJson, now: NOW, failpoint,
  });
}
describe('P7 C4 actual SERIALIZABLE category/role/channel atomic apply', () => {
  it('rolls back every failpoint with no partial categories, roles, channels or consumed token', async () => {
    const expected = await destinationSnapshot();
    const fingerprint = await reviewFingerprint();
    for (const failure of [
      'after_claim', 'after_categories', 'after_roles', 'after_channels', 'before_commit',
    ] as const) {
      const approval = await approve(fingerprint);
      const before = await pool.query(
        'SELECT token_hash, consumed_at FROM portable_import_approvals ORDER BY token_hash');
      await expect(apply(approval.approvalToken, fingerprint, failure))
        .rejects.toBeInstanceOf(PortableAtomicApplyError);
      const after = await pool.query(
        'SELECT token_hash, consumed_at FROM portable_import_approvals ORDER BY token_hash');
      expect(after.rows).toEqual(before.rows);
      expect(await destinationSnapshot()).toEqual(expected);
    }
  }, 60000);

  it('refuses changed target grants, revoked credential version and altered topology before any write', async () => {
    const fingerprint = await reviewFingerprint();
    const approval = await approve(fingerprint);
    const initial = await destinationSnapshot();
    await rival.query('UPDATE channel_permissions SET allow=4 WHERE "roleId"=$1', ['tr']);
    await expect(apply(approval.approvalToken, fingerprint))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    await rival.query('UPDATE channel_permissions SET allow=1 WHERE "roleId"=$1', ['tr']);
    await rival.query('UPDATE users SET "tokenVersion"=5 WHERE _id=$1', ['owner']);
    await expect(apply(approval.approvalToken, fingerprint))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    await rival.query('UPDATE users SET "tokenVersion"=4 WHERE _id=$1', ['owner']);
    await rival.query("UPDATE channels SET topic='changed' WHERE _id='tch'");
    await expect(apply(approval.approvalToken, fingerprint))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    await rival.query("UPDATE channels SET topic='' WHERE _id='tch'");
    expect(await destinationSnapshot()).toEqual(initial);
  }, 30000);

  it('recovers from rollback, commits all mapped metadata once and refuses replay', async () => {
    const fingerprint = await reviewFingerprint();
    const approval = await approve(fingerprint);
    // This second, independently minted valid token is NOT sufficient to
    // replay a source snapshot after the first apply commits.
    const secondApproval = await approve(fingerprint);
    const before = await destinationSnapshot();
    await expect(apply(approval.approvalToken, fingerprint, 'after_channels'))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(await destinationSnapshot()).toEqual(before);
    const result = await apply(approval.approvalToken, fingerprint);
    expect(result).toMatchObject({
      applied: true, transactionCommitted: true, routeMounted: false,
      changed: { categories: 1, roles: 1, channels: 1 },
      grantsPreserved: true, identitiesPreserved: true,
    });
    const after = await destinationSnapshot();
    expect(after.cats[0]).toMatchObject({
      _id: 'tc', name: 'Imported category', position: 4, collapsed: true,
    });
    expect(after.roles[0]).toMatchObject({
      _id: 'tr', name: 'Imported role', color: '#abcdef', position: 0, permissions: 1,
    });
    expect(after.channels[0]).toMatchObject({
      _id: 'tch', name: 'imported-welcome', topic: 'Imported topic',
      categoryId: 'tc', category: 'IMPORTED', nsfw: 1, slowmode: 5, order: 7,
    });
    expect(after.grants).toEqual(before.grants);
    expect(before.audit).toHaveLength(0);
    expect(after.audit).toHaveLength(1);
    expect(before.snapshots).toHaveLength(0);
    expect(after.snapshots).toHaveLength(1);
    expect(after.snapshots[0]).toMatchObject({
      target_server_id: SID, source_origin: ORIGIN,
      source_server_id: SOURCE, source_snapshot_id: fields.snapshotId,
      source_key_fingerprint: fields.keyFingerprint,
      structure_digest: structure.integrity.digest,
      permissions_digest: permissions.integrity.digest,
    });
    expect(after.audit[0]).toMatchObject({
      serverId: SID, actorId: 'owner', action: 'portable.mapped_metadata.apply',
      target: SID,
    });
    expect(JSON.parse(after.audit[0]!.detail)).toEqual({
      mode: 'existing-mapped-metadata-only', categories: 1, roles: 1,
      channels: 1, grantsPreserved: true, membershipsImported: false,
    });
    expect(after.audit[0]!.detail).not.toContain(approval.approvalToken);
    expect(after.audit[0]!.detail).not.toContain('owner');
    expect(after.audit[0]!.detail).not.toContain(ORIGIN);
    const consumed = await pool.query(
      'SELECT count(*)::integer AS n FROM portable_import_approvals WHERE consumed_at IS NOT NULL');
    expect(consumed.rows[0].n).toBe(1);
    await expect(apply(approval.approvalToken, fingerprint))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    await expect(apply(secondApproval.approvalToken, fingerprint))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(await destinationSnapshot()).toEqual(after);

    // Prove the ledger barrier independently of stale topology: a brand
    // new token cannot bypass the durable UNIQUE signed-snapshot tuple.
    const replay = await rival.query(
      'INSERT INTO portable_import_snapshot_consumptions ' +
      '(target_server_id, source_origin, source_server_id, source_snapshot_id, ' +
      'source_key_fingerprint, structure_digest, permissions_digest) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7) ' +
      'ON CONFLICT (target_server_id, source_origin, source_server_id, source_snapshot_id) ' +
      'DO NOTHING RETURNING source_snapshot_id',
      [SID, ORIGIN, SOURCE, fields.snapshotId, fields.keyFingerprint,
        structure.integrity.digest, permissions.integrity.digest],
    );
    expect(replay.rows).toHaveLength(0);
    expect(await destinationSnapshot()).toEqual(after);
  }, 30000);

  it('proves server deletion transactionally cascades the replay barrier and approval ledger', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const before = await client.query(
        'SELECT count(*)::integer AS n FROM portable_import_snapshot_consumptions WHERE target_server_id=$1',
        [SID],
      );
      expect(before.rows[0].n).toBe(1);
      await client.query('DELETE FROM servers WHERE _id=$1', [SID]);
      const replay = await client.query(
        'SELECT count(*)::integer AS n FROM portable_import_snapshot_consumptions WHERE target_server_id=$1',
        [SID],
      );
      const approvals = await client.query(
        'SELECT count(*)::integer AS n FROM portable_import_approvals WHERE target_server_id=$1',
        [SID],
      );
      expect(replay.rows[0].n).toBe(0);
      expect(approvals.rows[0].n).toBe(0);
      await client.query('ROLLBACK');
      const restored = await pool.query(
        'SELECT count(*)::integer AS n FROM portable_import_snapshot_consumptions WHERE target_server_id=$1',
        [SID],
      );
      expect(restored.rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }, 30000);
}
  it('fails closed after a lost COMMIT acknowledgement while a fresh connection proves durable apply', async () => {
    // Previous test committed snapshot #1. A distinct, signed snapshot changes
    // the category label, so a lost ACK cannot be mistaken for a no-op.
    const currentTarget = {
      serverId: SID,
      categories: [{ ...topology.categories[0], name: 'Imported category', position: 4, collapsed: true }],
      roles: [{ ...topology.roles[0], name: 'Imported role', color: '#abcdef' }],
      channels: [{ ...topology.channels[0], name: 'imported-welcome',
        topic: 'Imported topic', category: 'IMPORTED', order: 7, nsfw: true, slowmode: 5 }],
    };
    const nextStructure = buildPortableCommunityStructure(
      sourceServer, [{ ...sourceCats[0], name: 'Recovered after COMMIT ambiguity' }],
      sourceChannels, sourceRoles, AT,
    );
    const signedFields = {
      ...fields, snapshotId: 'locked-pg-lost-ack-12345678',
      structureDigest: nextStructure.integrity.digest,
    };
    const signed = {
      ...signedFields,
      signature: sign(null, portableSourceAttestationSigningBytes(signedFields), privateKey).toString('base64url'),
    };
    const nextMapping = {
      ...mapping, structureDigest: nextStructure.integrity.digest,
      expectedTargetDigest: fingerprintDestinationTopology(currentTarget),
    };
    const confirmed = await reviewFingerprint(signed, nextStructure, nextMapping);
    const approval = await approve(confirmed, ownerGrant(), signed, nextStructure, nextMapping);
    const baseline = await destinationSnapshot();
    expect(baseline.snapshots).toHaveLength(1);
    expect(baseline.audit).toHaveLength(1);

    let databaseCommitCompleted = false;
    const lostAcknowledgementPool = {
      connect: async () => {
        const client = await pool.connect();
        return {
          query: async (sql: string, params?: unknown[]) => {
            // PostgreSQL actually receives and executes COMMIT. Only the
            // acknowledgement delivered to our importer is lost.
            const result = await client.query(sql, params);
            if (sql === 'COMMIT') {
              databaseCommitCompleted = true;
              throw new Error('simulated response loss after PostgreSQL COMMIT');
            }
            return result;
          },
          release: (error?: Error) => client.release(error),
        };
      },
    };
    const input = {
      approvalToken: approval.approvalToken, confirmedReviewFingerprint: confirmed,
      ownerId: 'owner', targetServerId: SID, stepUpGrant: ownerGrant(),
      structure: nextStructure, permissions, attestation: signed,
      expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
      mapping: nextMapping, operatorRegistryJson, now: NOW,
    };
    // No 200/success may escape when the COMMIT acknowledgement is unknown.
    await expect(applyApprovedPortableCommunityMapping({
      ...input, pool: lostAcknowledgementPool,
    })).rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(databaseCommitCompleted).toBe(true);

    // A brand-new pool/session observes durable results; this is not an
    // independent deployed Bridge process or a real TLS failure injection.
    const fresh = new Pool({ connectionString: URL, max: 1, options: '-c search_path=' + schema });
    try {
      const category = await fresh.query('SELECT name FROM channel_categories WHERE _id=$1', ['tc']);
      expect(category.rows[0]?.name).toBe('Recovered after COMMIT ambiguity');
      const consumed = await fresh.query(
        'SELECT count(*)::integer AS n FROM portable_import_approvals ' +
        'WHERE source_snapshot_id=$1 AND consumed_at IS NOT NULL', [signedFields.snapshotId],
      );
      expect(consumed.rows[0]?.n).toBe(1);
      const reservation = await fresh.query(
        'SELECT source_key_fingerprint, structure_digest, permissions_digest ' +
        'FROM portable_import_snapshot_consumptions ' +
        'WHERE target_server_id=$1 AND source_origin=$2 AND source_server_id=$3 AND source_snapshot_id=$4',
        [SID, ORIGIN, SOURCE, signedFields.snapshotId],
      );
      expect(reservation.rows).toEqual([{
        source_key_fingerprint: fields.keyFingerprint,
        structure_digest: nextStructure.integrity.digest,
        permissions_digest: permissions.integrity.digest,
      }]);
      const audit = await fresh.query(
        "SELECT count(*)::integer AS n FROM audit_logs WHERE action='portable.mapped_metadata.apply'",
      );
      expect(audit.rows[0]?.n).toBe(2);

      // The original token is consumed and the signed snapshot remains
      // reserved. No second apply or audit event is allowed after reconnect.
      await expect(applyApprovedPortableCommunityMapping({ ...input, pool: fresh }))
        .rejects.toBeInstanceOf(PortableAtomicApplyError);
      const after = await fresh.query(
        'SELECT count(*)::integer AS n FROM audit_logs WHERE action=$1',
        ['portable.mapped_metadata.apply'],
      );
      expect(after.rows[0]?.n).toBe(2);
      const conflict = await fresh.query(
        'INSERT INTO portable_import_snapshot_consumptions ' +
        '(target_server_id, source_origin, source_server_id, source_snapshot_id, ' +
        'source_key_fingerprint, structure_digest, permissions_digest) ' +
        'VALUES ($1,$2,$3,$4,$5,$6,$7) ' +
        'ON CONFLICT (target_server_id, source_origin, source_server_id, source_snapshot_id) ' +
        'DO NOTHING RETURNING source_snapshot_id',
        [SID, ORIGIN, SOURCE, signedFields.snapshotId, fields.keyFingerprint,
          nextStructure.integrity.digest, permissions.integrity.digest],
      );
      expect(conflict.rows).toHaveLength(0);
    } finally {
      await fresh.end();
    }
  }, 30000);
});
