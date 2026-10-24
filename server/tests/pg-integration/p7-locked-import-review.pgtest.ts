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
  await pool.query('CREATE TABLE channels (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, topic TEXT NOT NULL, "categoryId" TEXT, category TEXT NOT NULL, "order" BIGINT NOT NULL, nsfw INTEGER NOT NULL, slowmode INTEGER NOT NULL, "expiresAt" BIGINT, "expiryVersion" INTEGER NOT NULL DEFAULT 0)');
  await pool.query('CREATE TABLE channel_expiry_tombstones ("channelId" TEXT PRIMARY KEY)');
  await pool.query('CREATE TABLE channel_permissions ("channelId" TEXT NOT NULL, "serverId" TEXT NOT NULL, "roleId" TEXT NOT NULL, allow BIGINT NOT NULL, deny BIGINT NOT NULL)');
  await pool.query('CREATE TABLE channel_overrides ("channelId" TEXT NOT NULL)');
  await pool.query("INSERT INTO servers VALUES ('dest','owner')");
  await pool.query("INSERT INTO channel_categories VALUES ('tc','dest','General',0,FALSE)");
  await pool.query("INSERT INTO roles VALUES ('tr','dest','Readers','#99aab5',0,1)");
  await pool.query("INSERT INTO channels VALUES ('tch','dest','welcome','text','','tc','GENERAL',0,0,0,NULL,0)");
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

function review(client: Parameters<typeof inspectLockedPortableImportReview>[0]['client'], ownerId = 'owner') {
  return inspectLockedPortableImportReview({
    client, targetServerId: SID, ownerId, structure, permissions, attestation,
    expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
    operatorRegistryJson, mapping, now: NOW,
  });
}
describe('P7 C4 signed mapping + owner + topology + grants one PostgreSQL client', () => {
  it('accepts a valid active channel before its database deadline', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('UPDATE channels SET "expiryVersion"=1, "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+60000 WHERE _id=$1', ['tch']);
      await expect(review(client)).resolves.toMatchObject({ checkedChannels: 1, writesPerformed: false });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('does not let unrelated unavailable channels block a live permanent mapping', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query("INSERT INTO channels VALUES ('expired-unmapped','dest','expired','text','','tc','GENERAL',1,0,0,1,1), ('tombstoned-unmapped','dest','gone','text','','tc','GENERAL',2,0,0,NULL,0)");
      await client.query('INSERT INTO channel_expiry_tombstones ("channelId") VALUES ($1)', ['tombstoned-unmapped']);
      await expect(review(client)).resolves.toMatchObject({
        checkedChannels: 1, targetTopologyDigest: mapping.expectedTargetDigest, writesPerformed: false,
      });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it.each(['deadline', 'tombstone'])('refuses a mapped target made unavailable by %s', async reason => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      if (reason === 'deadline') {
        await client.query('UPDATE channels SET "expiryVersion"=1, "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1 WHERE _id=$1', ['tch']);
      } else {
        await client.query('INSERT INTO channel_expiry_tombstones ("channelId") VALUES ($1)', ['tch']);
      }
      await expect(review(client)).rejects.toBeInstanceOf(LockedPortableReviewError);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it.each(['channel-row', 'grant-row'])('rechecks database expiry after waiting for %s', async point => {
    await pool.query('UPDATE channels SET "expiryVersion"=1, "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+1000 WHERE _id=$1', ['tch']);
    const client = await pool.connect(), blocker = await rival.connect();
    let pending: Promise<{ error?: unknown; value?: unknown }> | undefined;
    try {
      const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
      await blocker.query('BEGIN');
      if (point === 'channel-row') await blocker.query('SELECT _id FROM channels WHERE _id=$1 FOR UPDATE', ['tch']);
      else await blocker.query('SELECT "channelId" FROM channel_permissions WHERE "channelId"=$1 FOR UPDATE', ['tch']);
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      pending = review(client).then(value => ({ value }), error => ({ error }));
      let waited = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const observed = await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting', [pid]);
        if (observed.rows[0].waiting === true) { waited = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waited).toBe(true);
      await blocker.query('SELECT pg_sleep(GREATEST(0, (SELECT "expiresAt" FROM channels WHERE _id=$1)/1000.0-EXTRACT(EPOCH FROM clock_timestamp())+0.02)::double precision)', ['tch']);
      const elapsed = await blocker.query('SELECT "expiresAt" <= FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT AS expired FROM channels WHERE _id=$1', ['tch']);
      expect(elapsed.rows[0].expired).toBe(true);
      await blocker.query('COMMIT');
      const result = await pending;
      expect(result.error).toBeInstanceOf(LockedPortableReviewError);
    } finally {
      await blocker.query('ROLLBACK');
      if (pending) await pending;
      await client.query('ROLLBACK');
      client.release(); blocker.release();
      await pool.query('UPDATE channels SET "expiresAt"=NULL WHERE _id=$1', ['tch']);
    }
  });

  it('refuses a lifetime sampled as live when its real PostgreSQL response is delivered after expiry', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query('UPDATE channels SET "expiryVersion"=1, "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+1000 WHERE _id=$1', ['tch']);
      let delayed = false;
      const delayedClient = { async query(sql: string, params?: unknown[]) {
        const result = await client.query<Record<string, unknown>>(sql, params);
        if (sql.includes('AS "hasTombstone"')) {
          const row = result.rows[0];
          expect(row).toBeDefined();
          if (!row) throw new Error('Missing real channel metadata');
          expect(BigInt(String(row.expiresAt)) > BigInt(String(row.nowMs))).toBe(true);
          await client.query('SELECT pg_sleep(GREATEST(0, (SELECT "expiresAt" FROM channels WHERE _id=$1)/1000.0-EXTRACT(EPOCH FROM clock_timestamp())+0.02)::double precision)', ['tch']);
          delayed = true;
        }
        return { rows: result.rows };
      } };
      await expect(review(delayedClient)).rejects.toBeInstanceOf(LockedPortableReviewError);
      expect(delayed).toBe(true);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

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
