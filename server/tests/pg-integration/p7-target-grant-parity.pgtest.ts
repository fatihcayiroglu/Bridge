// Live PostgreSQL proof: grant locks, serializable session and mismatch denial.
// npm run test:pg requires PG_TEST_URL; this suite never silently skips.
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { buildPortableCommunityPermissionManifest } from '../../lib/portableCommunityPermissions';
import {
  requireMappedDestinationGrantParity, PortableTargetGrantParityError,
} from '../../lib/portableTargetGrantParity';

const URL = process.env.PG_TEST_URL;
if (!URL) throw new Error('PG_TEST_URL required for live destination grant parity proof');
const name = 'p7grants_' + randomBytes(8).toString('hex');
const quoted = '"' + name + '"';
let admin: Pool;
let primary: Pool;
let second: Pool;
const sid = 'dest';
const source = 'src';
const permissions = buildPortableCommunityPermissionManifest(
  { _id: source },
  [{ _id: 'sc', serverId: source }],
  [{ _id: 'sr', serverId: source }],
  [{ channelId: 'sc', canonical: [
    { channelId: 'sc', roleId: 'sr', allow: 1, deny: 2 },
    { channelId: 'sc', roleId: source, targetType: 'everyone', allow: 4, deny: 8 },
  ], legacy: [] }],
  '2026-10-13T12:00:00.000Z',
);
const mapping = {
  roles: [{ sourceId: 'sr', targetId: 'tr' }],
  channels: [{ sourceId: 'sc', targetId: 'tc' }],
};
beforeAll(async () => {
  admin = new Pool({ connectionString: URL, max: 1 });
  await admin.query('CREATE SCHEMA ' + quoted);
  primary = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + name });
  second = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + name });
  await primary.query('CREATE TABLE servers (_id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL)');
  await primary.query('CREATE TABLE channels (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL)');
  await primary.query('CREATE TABLE roles (_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL)');
  await primary.query('CREATE TABLE channel_permissions ("channelId" TEXT NOT NULL, "serverId" TEXT NOT NULL, "roleId" TEXT NOT NULL, allow BIGINT NOT NULL, deny BIGINT NOT NULL)');
  await primary.query('CREATE TABLE channel_overrides ("channelId" TEXT NOT NULL)');
  await primary.query('INSERT INTO servers VALUES ($1,$2)', [sid, 'owner']);
  await primary.query('INSERT INTO channels VALUES ($1,$2)', ['tc', sid]);
  await primary.query('INSERT INTO roles VALUES ($1,$2)', ['tr', sid]);
  await primary.query('INSERT INTO channel_permissions VALUES ($1,$2,$3,$4,$5),($1,$2,$6,$7,$8)',
    ['tc', sid, 'tr', 1, 2, sid, 4, 8]);
}, 60_000);
afterAll(async () => {
  if (primary) await primary.end();
  if (second) await second.end();
  if (admin) {
    try { await admin.query('DROP SCHEMA ' + quoted + ' CASCADE'); }
    finally { await admin.end(); }
  }
}, 60_000);
async function check(client: import('pg').PoolClient, owner = 'owner') {
  return requireMappedDestinationGrantParity({
    client, targetServerId: sid, ownerId: owner, sourcePermissions: permissions, mapping,
  });
}
describe('P7 C4 live mapped grant parity on PostgreSQL', () => {
  it('refuses read-committed connection and wrong owner', async () => {
    const c = await primary.connect();
    try {
      await c.query('BEGIN');
      await expect(check(c)).rejects.toBeInstanceOf(PortableTargetGrantParityError);
      await c.query('ROLLBACK');
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(check(c, 'other')).rejects.toBeInstanceOf(PortableTargetGrantParityError);
      await c.query('ROLLBACK');
    } finally { c.release(); }
  });
  it('locks live grants on one serializable client and prevents concurrent modification', async () => {
    const c = await primary.connect();
    const other = await second.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await check(c);
      expect(result).toMatchObject({ checkedChannels: 1, checkedGrants: 2,
        writesPerformed: false, importSupported: false });
      expect(result.targetGrantDigest).toMatch(/^[0-9a-f]{64}$/);
      await other.query('BEGIN');
      await other.query("SET LOCAL lock_timeout='150ms'");
      await expect(other.query('UPDATE channel_permissions SET allow=16 WHERE "channelId"=$1 AND "roleId"=$2',
        ['tc', 'tr'])).rejects.toThrow();
      await other.query('ROLLBACK');
      await c.query('COMMIT');
    } finally { c.release(); other.release(); }
  });
  it('refuses changed target grants and any legacy channel overrides', async () => {
    await second.query('UPDATE channel_permissions SET allow=16 WHERE "roleId"=$1', ['tr']);
    let c = await primary.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(check(c)).rejects.toBeInstanceOf(PortableTargetGrantParityError);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    await second.query('UPDATE channel_permissions SET allow=1 WHERE "roleId"=$1', ['tr']);
    await second.query('INSERT INTO channel_overrides VALUES ($1)', ['tc']);
    c = await primary.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(check(c)).rejects.toBeInstanceOf(PortableTargetGrantParityError);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    await second.query('DELETE FROM channel_overrides');
  });
});
