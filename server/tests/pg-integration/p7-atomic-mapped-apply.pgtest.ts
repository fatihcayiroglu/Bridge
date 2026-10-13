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
async function reviewFingerprint() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    const verified = await deriveVerifiedPortableApprovalBinding({
      client, targetServerId: SID, ownerId: 'owner', structure, permissions,
      attestation, expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
      operatorRegistryJson, mapping, now: NOW,
    });
    await client.query('ROLLBACK');
    return verified.binding.reviewFingerprint;
  } finally { client.release(); }
}
async function approve(confirmedReviewFingerprint: string, stepUpGrant = ownerGrant()) {
  return stageOwnerConfirmedPortableApproval({
    pool, targetServerId: SID, ownerId: 'owner', stepUpGrant,
    confirmedReviewFingerprint, structure, permissions, attestation,
    expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
    operatorRegistryJson, mapping, now: NOW,
  });
}

async function destinationSnapshot() {
  const [cats, roles, channels, grants] = await Promise.all([
    pool.query('SELECT * FROM channel_categories ORDER BY _id'),
    pool.query('SELECT * FROM roles ORDER BY _id'),
    pool.query('SELECT * FROM channels ORDER BY _id'),
    pool.query('SELECT * FROM channel_permissions ORDER BY "channelId", "roleId"'),
  ]);
  return { cats: cats.rows, roles: roles.rows, channels: channels.rows, grants: grants.rows };
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
    const consumed = await pool.query(
      'SELECT count(*)::integer AS n FROM portable_import_approvals WHERE consumed_at IS NOT NULL');
    expect(consumed.rows[0].n).toBe(1);
    await expect(apply(approval.approvalToken, fingerprint))
      .rejects.toBeInstanceOf(PortableAtomicApplyError);
    expect(await destinationSnapshot()).toEqual(after);
  }, 30000);
});
