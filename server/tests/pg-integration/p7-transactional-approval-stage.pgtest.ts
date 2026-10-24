// Full signed source/target review on one real PostgreSQL transaction.
// Never skip on an unavailable PG_TEST_URL.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintStepUpGrant } from '../../lib/stepUp';
import { stageOwnerConfirmedPortableApproval, TransactionalPortableApprovalError } from '../../lib/portableTransactionalApprovalStage';
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
const sourceCats = [{ _id: 'scat', serverId: SOURCE, name: 'General', position: 0, collapsed: false }];
const sourceRoles = [{ _id: 'sr', serverId: SOURCE, name: 'Readers',
  color: '#99aab5', position: 0, permissions: 1 }];
const sourceChannels = [{ _id: 'sch', serverId: SOURCE, name: 'welcome', type: 'text',
  topic: '', categoryId: 'scat', category: 'GENERAL', order: 0, nsfw: false, slowmode: 0 }];
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
describe('real PG same-transaction step-up, signed review and one-use approval', () => {
  it('inserts durable hashed token only on COMMIT, with exact grant/topology binding', async () => {
    const confirmed = await reviewFingerprint();
    const outcome = await approve(confirmed);
    expect(outcome).toMatchObject({
      targetReviewFingerprint: confirmed, approvalRecordWritten: true,
      destinationDataWritesPerformed: false, importSupported: false,
    });
    expect(outcome.approvalToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await pool.query('SELECT token_hash,target_grant_digest,review_fingerprint,expires_at,consumed_at FROM portable_import_approvals');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].review_fingerprint).toBe(confirmed);
    expect(stored.rows[0].target_grant_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toBe(outcome.approvalToken);
    expect(stored.rows[0].consumed_at).toBeNull();

    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const checked = await deriveVerifiedPortableApprovalBinding({
        client:c,targetServerId:SID,ownerId:'owner',structure,permissions,attestation,
        expectedSourceOrigin:ORIGIN,expectedSourceServerId:SOURCE,
        operatorRegistryJson,mapping,now:NOW,
      });
      await claimPortableImportApproval(c, outcome.approvalToken, checked.binding);
      await c.query('COMMIT');
    } finally { c.release(); }
    const d = await pool.connect();
    try {
      await d.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const checked = await deriveVerifiedPortableApprovalBinding({
        client:d,targetServerId:SID,ownerId:'owner',structure,permissions,attestation,
        expectedSourceOrigin:ORIGIN,expectedSourceServerId:SOURCE,
        operatorRegistryJson,mapping,now:NOW,
      });
      await expect(claimPortableImportApproval(d, outcome.approvalToken, checked.binding))
        .rejects.toBeInstanceOf(PortableImportApprovalError);
      await d.query('ROLLBACK');
    } finally { d.release(); }
  }, 30_000);
  it('refuses changed target grants, revoked credentials and wrong owner confirmation without a token', async () => {
    const fingerprint = await reviewFingerprint();
    const start = await pool.query('SELECT count(*)::integer AS n FROM portable_import_approvals');
    await rival.query('UPDATE channel_permissions SET allow=4 WHERE "roleId"=$1', ['tr']);
    await expect(approve(fingerprint)).rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    await rival.query('UPDATE channel_permissions SET allow=1 WHERE "roleId"=$1', ['tr']);
    await rival.query('UPDATE users SET "tokenVersion"=5 WHERE _id=$1', ['owner']);
    await expect(approve(fingerprint)).rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    await rival.query('UPDATE users SET "tokenVersion"=4 WHERE _id=$1', ['owner']);
    await expect(approve('0'.repeat(64))).rejects.toBeInstanceOf(TransactionalPortableApprovalError);
    const after = await pool.query('SELECT count(*)::integer AS n FROM portable_import_approvals');
    expect(after.rows[0].n).toBe(start.rows[0].n);
  }, 30_000);
  it.each(['users', 'servers'] as const)('rejects owner proof that ages out while waiting for the locked %s row', async table => {
    const confirmed = await reviewFingerprint();
    const before = await pool.query('SELECT count(*)::integer AS n FROM portable_import_approvals');
    const blocker = await rival.connect();
    let writerPid = 0;
    const observedPool = {
      async connect() {
        const writer = await pool.connect();
        writerPid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return writer;
      },
    };
    const issued = Date.now() - 95_000;
    const credential = mintStepUpGrant({ _id: 'owner', tokenVersion: 4 }, 'password', 'account-security', issued).token;
    try {
      await blocker.query('BEGIN');
      await blocker.query(table === 'users'
        ? 'SELECT _id FROM users WHERE _id=$1 FOR UPDATE'
        : 'SELECT _id FROM servers WHERE _id=$1 FOR UPDATE',
      [table === 'users' ? 'owner' : SID]);
      // This calls the actual stager, with a real physical client and current
      // clock. Never log the token even if the old implementation returns it.
      const outcome = stageOwnerConfirmedPortableApproval({
        pool: observedPool, targetServerId: SID, ownerId: 'owner', stepUpGrant: credential,
        confirmedReviewFingerprint: confirmed, structure, permissions, attestation,
        expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
        operatorRegistryJson, mapping,
      }).then(() => ({ admitted: true }), error => ({ admitted: false, error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await rival.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [writerPid]);
        if (state.rows[0]?.wait_event_type === 'Lock') { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      // The proof was within the route's 100s bound on entry. A real lock
      // wait crosses the 120s transaction limit; no fake clock or DB mock.
      await new Promise(resolve => setTimeout(resolve, 27_000));
      expect(Date.now() - issued).toBeGreaterThan(120_000);
      await blocker.query('COMMIT');
      const result = await outcome;
      const after = await pool.query('SELECT count(*)::integer AS n FROM portable_import_approvals');
      expect({ admitted: result.admitted, newApprovals: after.rows[0].n - before.rows[0].n })
        .toEqual({ admitted: false, newApprovals: 0 });
      if ('error' in result) expect(result.error).toBeInstanceOf(TransactionalPortableApprovalError);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
    }
  });


});
