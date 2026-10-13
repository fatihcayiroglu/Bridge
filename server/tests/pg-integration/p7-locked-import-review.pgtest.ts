// Full signed source/target review on one real PostgreSQL transaction.
// Never skip on an unavailable PG_TEST_URL.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { Pool } from 'pg';
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
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
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
let admin: Pool, pool: Pool, rival: Pool;
beforeAll(async () => {
  admin = new Pool({ connectionString: URL, max: 1 });
  await admin.query('CREATE SCHEMA ' + quoted);
  pool = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  rival = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  await pool.query('CREATE TABLE servers (_id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL)');
  await pool.query('CREATE TABLE channel_categories (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL, collapsed BOOLEAN NOT NULL)');
  await pool.query('CREATE TABLE roles (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, position INTEGER NOT NULL, permissions INTEGER NOT NULL)');
  await pool.query('CREATE TABLE channels (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, "categoryId" TEXT, category TEXT NOT NULL, "order" BIGINT NOT NULL, nsfw INTEGER NOT NULL, slowmode INTEGER NOT NULL)');
  await pool.query('CREATE TABLE channel_permissions ("channelId" TEXT NOT NULL, "serverId" TEXT NOT NULL, "roleId" TEXT NOT NULL, allow BIGINT NOT NULL, deny BIGINT NOT NULL)');
  await pool.query('CREATE TABLE channel_overrides ("channelId" TEXT NOT NULL)');
  await pool.query("INSERT INTO servers VALUES ('dest','owner')");
  await pool.query("INSERT INTO channel_categories VALUES ('tc','dest','General',0,FALSE)");
  await pool.query("INSERT INTO roles VALUES ('tr','dest','Readers','#99aab5',0,1)");
  await pool.query("INSERT INTO channels VALUES ('tch','dest','welcome','text','','tc','GENERAL',0,0,0)");
  await pool.query("INSERT INTO channel_permissions VALUES ('tch','dest','tr',1,0)");
}, 60_000);
afterAll(async () => {
  if (pool) await pool.end();
  if (rival) await rival.end();
  if (admin) {
    try { await admin.query('DROP SCHEMA ' + quoted + ' CASCADE'); }
    finally { await admin.end(); }
  }
}, 60_000);

function review(client: import('pg').PoolClient, ownerId = 'owner') {
  return inspectLockedPortableImportReview({
    client, targetServerId: SID, ownerId, structure, permissions, attestation,
    expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
    operatorRegistryJson, mapping, now: NOW,
  });
}
describe('P7 C4 signed mapping + owner + topology + grants one PostgreSQL client', () => {
  it('returns only non-authorizing evidence and locks existing target rows', async () => {
    const client = await pool.connect(), other = await rival.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const outcome = await review(client);
      expect(outcome).toMatchObject({ mode: 'transaction-check-only', checkedChannels: 1,
        checkedGrants: 1, consentIssued: false, importSupported: false, writesPerformed: false });
      expect(outcome.targetTopologyDigest).toBe(mapping.expectedTargetDigest);
      await other.query('BEGIN');
      await other.query("SET LOCAL lock_timeout='150ms'");
      await expect(other.query("UPDATE channels SET topic='changed' WHERE _id='tch'")).rejects.toThrow();
      await other.query('ROLLBACK');
      await client.query('COMMIT');
    } finally { client.release(); other.release(); }
  });

  it('refuses changed grants, stale topology and different owner', async () => {
    await rival.query("UPDATE channel_permissions SET allow=2 WHERE \"roleId\"='tr'");
    let client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(review(client)).rejects.toBeInstanceOf(LockedPortableReviewError);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await rival.query("UPDATE channel_permissions SET allow=1 WHERE \"roleId\"='tr'");
    await rival.query("UPDATE channels SET topic='changed' WHERE _id='tch'");
    client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(review(client)).rejects.toBeInstanceOf(LockedPortableReviewError);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await rival.query("UPDATE channels SET topic='' WHERE _id='tch'");
    client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(review(client, 'other')).rejects.toBeInstanceOf(LockedPortableReviewError);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});
