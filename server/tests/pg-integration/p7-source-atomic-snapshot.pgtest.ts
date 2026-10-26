// REAL PostgreSQL evidence for P7 C4. The ordinary Jest mock cannot prove
// MVCC repeatable-read behaviour while another session commits changes.
// This file runs in npm run test:pg (PG_TEST_URL REQUIRED; no skips).
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { Pool } from 'pg';
import { issueAtomicPortableSourceAttestation, PortableSourceSnapshotError } from '../../lib/portableSourceSnapshotIssuer';
import { verifyPortableSourceAttestation } from '../../lib/portableSourceAttestation';
import { CHANNEL_BATCH_READ_EXPIRY_SQL } from '../../lib/channelReadExpiryGuard';

const URL = process.env.PG_TEST_URL;
if (!URL) throw new Error('PG_TEST_URL required for live source snapshot test');
const schema = 'p7source_' + randomBytes(7).toString('hex');
const quoted = '"' + schema + '"'; // safe: name is a fixed prefix plus hex
const sid = 'source';
const owner = 'owner';
const now = Date.parse('2026-10-12T21:30:00.000Z');
const origin = 'https://source.example';

let admin: Pool;
let reader: Pool;
let writer: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: URL, max: 2 });
  await admin.query('CREATE SCHEMA ' + quoted);
  // Isolated private test tables, never modify the application's production
  // schema or rows in the one-use CI database.
  await admin.query(`CREATE TABLE ${quoted}.servers
    (_id TEXT PRIMARY KEY, "ownerId" TEXT, name TEXT, description TEXT, icon TEXT)`);
  await admin.query(`CREATE TABLE ${quoted}.channel_categories
    (_id TEXT PRIMARY KEY, "serverId" TEXT, name TEXT, position INTEGER, collapsed BOOLEAN)`);
  await admin.query(`CREATE TABLE ${quoted}.channels
    (_id TEXT PRIMARY KEY, "serverId" TEXT, name TEXT, type TEXT, topic TEXT, "categoryId" TEXT,
     category TEXT, "order" BIGINT, position INTEGER, nsfw INTEGER, slowmode INTEGER,
     "expiresAt" BIGINT, "expiryVersion" BIGINT NOT NULL DEFAULT 0)`);
  await admin.query(`CREATE TABLE ${quoted}.channel_expiry_tombstones
    ("channelId" TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, "expiredAt" BIGINT NOT NULL,
     "expiryVersion" BIGINT NOT NULL, "recordedAt" BIGINT NOT NULL, "cleanupState" TEXT NOT NULL)`);
  await admin.query(`CREATE TABLE ${quoted}.roles
    (_id TEXT PRIMARY KEY, "serverId" TEXT, name TEXT, color TEXT, position INTEGER, permissions INTEGER)`);
  await admin.query(`CREATE TABLE ${quoted}.channel_permissions
    (_id TEXT PRIMARY KEY, "channelId" TEXT, "serverId" TEXT, "roleId" TEXT, allow INTEGER, deny INTEGER)`);
  await admin.query(`CREATE TABLE ${quoted}.channel_overrides
    (_id TEXT PRIMARY KEY, "channelId" TEXT)`);

  reader = new Pool({ connectionString: URL, max: 1, options: '-c search_path=' + schema });
  writer = new Pool({ connectionString: URL, max: 1, options: '-c search_path=' + schema });
  await writer.query('INSERT INTO servers VALUES ($1,$2,$3,$4,$5)',
    [sid, owner, 'Original community', '', '']);
  await writer.query('INSERT INTO channel_categories VALUES ($1,$2,$3,$4,$5)',
    ['cat', sid, 'General', 0, false]);
  await writer.query('INSERT INTO channels (_id,"serverId",name,type,topic,"categoryId",category,"order",position,nsfw,slowmode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    ['channel', sid, 'chat', 'text', 'Original topic', 'cat', '', 0, 0, 0, 0]);
  await writer.query('INSERT INTO roles VALUES ($1,$2,$3,$4,$5,$6)',
    ['role', sid, 'Original role', '', 0, 1]);
  await writer.query('INSERT INTO channel_permissions VALUES ($1,$2,$3,$4,$5,$6)',
    ['perm', 'channel', sid, 'role', 1, 0]);
}, 60_000);

beforeEach(async () => {
  await writer.query('DELETE FROM channel_expiry_tombstones');
  await writer.query('DELETE FROM channel_permissions WHERE _id<>$1', ['perm']);
  await writer.query('DELETE FROM channels WHERE _id<>$1', ['channel']);
  await writer.query('UPDATE channels SET topic=$1,"expiresAt"=NULL,"expiryVersion"=0 WHERE _id=$2', ['Original topic', 'channel']);
  await writer.query('UPDATE roles SET name=$1 WHERE _id=$2', ['Original role', 'role']);
  await writer.query('UPDATE channel_permissions SET allow=1');
});

afterAll(async () => {
  await Promise.all([reader?.end(), writer?.end()].filter(Boolean));
  if (admin) {
    try { await admin.query('DROP SCHEMA ' + quoted + ' CASCADE'); }
    finally { await admin.end(); }
  }
}, 60_000);

it('excludes unavailable channel metadata and grants while preserving permanent and active channels', async () => {
  for (const [id, expiry, version] of [
    ['expired', -2000, 1], ['corrupt', 600000, 0], ['active', 600000, 1], ['tombstoned', null, 0],
  ] as const) {
    await writer.query(`INSERT INTO channels (_id,"serverId",name,type,topic,"order",position,nsfw,slowmode,"expiresAt","expiryVersion")
      VALUES ($1,$2,$1,'text',$3,1,1,0,0,
        CASE WHEN $4::bigint IS NULL THEN NULL ELSE FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+$4::bigint END,$5)`,
    [id, sid, 'private-topic-' + id, expiry, version]);
    await writer.query('INSERT INTO channel_permissions VALUES ($1,$2,$3,$4,1,0)', ['perm-' + id, id, sid, 'role']);
  }
  await writer.query(`INSERT INTO channel_expiry_tombstones VALUES
    ('tombstoned',$1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-2000,1,
      FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,'pending')`, [sid]);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const result = await issueAtomicPortableSourceAttestation({
    pool: reader, sourceServerId: sid, ownerUserId: owner, sourceOrigin: origin,
    signingPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now,
  });
  expect(result.structure.channels.map(channel => channel.name).sort()).toEqual(['active', 'chat']);
  expect(result.permissions.channels.map(channel => channel.channelSourceId).sort()).toEqual(['active', 'channel']);
  expect(JSON.stringify(result)).not.toMatch(/private-topic-(?:expired|corrupt|tombstoned)/);
  expect(verifyPortableSourceAttestation({
    structure: result.structure, permissions: result.permissions, attestation: result.attestation,
    expectedSourceOrigin: origin, trustedSourcePublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), now,
  })).toMatchObject({ sourceSignatureValid: true });
});

it('does not sign metadata that expires while the final COMMIT response is delayed', async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  let commits = 0;
  let lifecycleReads = 0;
  let remainingAtFinalCheck = 0;
  const pool = {
    async connect() {
      const c = await reader.connect();
      return {
        async query(statement: string, params?: unknown[]) {
          const result = await c.query(statement, params);
          if (statement === 'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY') {
            await writer.query(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT+2000,
              "expiryVersion"=1 WHERE _id='channel'`);
          }
          if (statement === CHANNEL_BATCH_READ_EXPIRY_SQL && ++lifecycleReads === 2) {
            remainingAtFinalCheck = Number(result.rows[0]?.expiresAt) - Number(result.rows[0]?.nowMs);
          }
          if (statement === 'COMMIT' && ++commits === 2) await writer.query('SELECT pg_sleep(2.2)');
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        release(error?: Error) { c.release(error); },
      };
    },
  };
  await expect(issueAtomicPortableSourceAttestation({
    pool, sourceServerId: sid, ownerUserId: owner, sourceOrigin: origin,
    signingPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now,
  })).rejects.toBeInstanceOf(PortableSourceSnapshotError);
  expect(lifecycleReads).toBe(2);
  expect(remainingAtFinalCheck).toBeGreaterThan(0);
  expect(commits).toBe(2);
  expect((await writer.query(`SELECT "expiresAt" < FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT AS expired
    FROM channels WHERE _id='channel'`)).rows[0].expired).toBe(true);
});

it.each(['expiry', 'tombstone'] as const)('refuses a %s committed by another session after the RR snapshot', async kind => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const statements: string[] = [];
  let changed = false;
  let lifecycleReads = 0;
  const pool = {
    async connect() {
      const c = await reader.connect();
      return {
        async query(statement: string, params?: unknown[]) {
          statements.push(statement);
          if (statement === CHANNEL_BATCH_READ_EXPIRY_SQL) lifecycleReads++;
          const result = await c.query(statement, params);
          if (!changed && statement.includes('FROM servers WHERE')) {
            changed = true;
            if (kind === 'expiry') {
              await writer.query(`UPDATE channels SET "expiresAt"=FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-1000,
                "expiryVersion"=1 WHERE _id='channel'`);
            } else {
              // A durable tombstone must also deny an accidentally recreated
              // permanent row. The source RR snapshot cannot see this commit.
              await writer.query(`INSERT INTO channel_expiry_tombstones VALUES
                ('channel',$1,FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT-2000,1,
                  FLOOR(EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT,'pending')`, [sid]);
            }
          }
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        release(error?: Error) { c.release(error); },
      };
    },
  };
  await expect(issueAtomicPortableSourceAttestation({
    pool, sourceServerId: sid, ownerUserId: owner, sourceOrigin: origin,
    signingPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), now,
  })).rejects.toBeInstanceOf(PortableSourceSnapshotError);
  expect(changed).toBe(true);
  expect(lifecycleReads).toBe(2);
  expect(statements.filter(statement => statement === 'COMMIT')).toHaveLength(1);
  expect(statements).toContain('BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY');
  expect(statements.at(-1)).toBe('ROLLBACK');
});

it('signed structure + permissions remain one PG MVCC snapshot during concurrent commits', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  let didMutate = false;
  const sql: string[] = [];
  const pool = {
    async connect() {
      const c = await reader.connect();
      return {
        async query(statement: string, params?: unknown[]) {
          sql.push(statement);
          const result = await c.query(statement, params);
          if (!didMutate && statement.includes('FROM servers WHERE')) {
            didMutate = true;
            // The source reader's first SELECT has established its MVCC
            // snapshot. A DIFFERENT PG session commits changes to all three
            // classes of source data before subsequent SELECTs.
            await writer.query('BEGIN');
            await writer.query('UPDATE roles SET name=$1 WHERE _id=$2', ['Changed role', 'role']);
            await writer.query('UPDATE channels SET topic=$1 WHERE _id=$2', ['Changed topic', 'channel']);
            await writer.query('UPDATE channel_permissions SET allow=$1 WHERE _id=$2', [2, 'perm']);
            await writer.query('INSERT INTO channels (_id,"serverId",name,type,topic,"categoryId",category,"order",position,nsfw,slowmode) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
              ['later-channel', sid, 'later', 'text', '', null, '', 1, 1, 0, 0]);
            await writer.query('COMMIT');
          }
          return { rows: result.rows as Array<Record<string, unknown>> };
        },
        release() { c.release(); },
      };
    },
  };
  const result = await issueAtomicPortableSourceAttestation({
    pool, sourceServerId: sid, ownerUserId: owner,
    sourceOrigin: origin, signingPrivateKeyPem: privatePem, now,
  });
  expect(didMutate).toBe(true);
  expect(sql[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(sql.at(-1)).toBe('COMMIT');
  expect(result.structure.roles.map(r => r.name)).toEqual(['Original role']);
  expect(result.structure.channels.map(c => c.name)).toEqual(['chat']);
  expect(result.structure.channels[0].topic).toBe('Original topic');
  expect(result.permissions.channels[0].overrides[0].allow).toBe(1);
  expect(result.permissions.channels).toHaveLength(1);
  expect(result.structure.exportedAt).toBe(result.permissions.exportedAt);
  // The writer's data really committed and is visible to a fresh transaction.
  expect((await writer.query('SELECT name FROM roles WHERE _id=$1', ['role'])).rows[0].name)
    .toBe('Changed role');
  expect((await writer.query('SELECT COUNT(*)::int AS n FROM channels')).rows[0].n).toBe(2);
  const checked = verifyPortableSourceAttestation({
    structure: result.structure, permissions: result.permissions,
    attestation: result.attestation, expectedSourceOrigin: origin,
    trustedSourcePublicKeyPem: publicPem, now,
  });
  expect(checked).toMatchObject({ sourceSignatureValid: true, importSupported: false });
  expect(result).toMatchObject({
    sourceReadIsolation: 'single-client-repeatable-read',
    remotelyVerifiedAtomicity: false, writesPerformed: false,
  });
}, 60_000);
