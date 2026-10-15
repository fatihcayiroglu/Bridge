// server/tests/pg-integration/role-delete-revokes-grants.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: DELETING A ROLE REVOKES EVERYTHING IT GRANTED
// ════════════════════════════════════════════════════════════════════════════
// Role deletion used to remove only the `roles` row. The role's
// `channel_permissions` ALLOW rows and its id in `members.roles` (JSONB) stayed,
// and the resolver matched channel overrides against those raw ids, so former
// members kept every private channel the role had opened. The stale rows also
// made the community's portable permission export refuse to run.
//
// Proven here against PostgreSQL itself: the JSONB `-`/`?` cleanup, the
// cascade's atomicity (an injected failure rolls everything back) and the
// resolver ignoring dangling rows already present in existing databases.

import { Roles, Channels, ChannelPermissions } from '../../db/repositories';
import { canViewChannel, resolvePermissions, DEFAULT_PERMISSIONS, PERMS } from '../../lib/permissions';
import { buildPortableCommunityPermissionManifest } from '../../lib/portableCommunityPermissions';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-rdel';
const SID = `${P}-srv`;
const OTHER_SID = `${P}-srv2`;
const CID = `${P}-ch-staff`;
const OWNER = `${P}-owner`;
const M1 = `${P}-m1`;
const M2 = `${P}-m2`;
const STAFF = `${P}-role-staff`;
const OTHER = `${P}-role-other`;
const FOREIGN = `${P}-role-foreign`;

RUN('real PostgreSQL — role deletion revokes its grants', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    await q(`DROP TRIGGER IF EXISTS pgt_rdel_fail ON members`);
    await q(`DROP FUNCTION IF EXISTS pgt_rdel_fail()`);
    await q(`DELETE FROM channel_permissions WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM members WHERE "serverId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM roles WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM channels WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };
  const memberRoles = async (userId: string) =>
    (await q(`SELECT roles FROM members WHERE "userId"=$1 AND "serverId"=$2`, [userId, SID]))[0]?.roles;

  async function seed(): Promise<void> {
    await cleanup();
    for (const id of [OWNER, M1, M2]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'Role delete', $2, 1), ($3, 'Other', $2, 1)`, [SID, OWNER, OTHER_SID]);
    await q(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1, $2, 'staff', 1)`, [CID, SID]);
    await q(`INSERT INTO roles (_id, "serverId", name, permissions, position, "createdAt")
             VALUES ($1, $3, 'Staff', 0, 1, 1), ($2, $3, 'Other', 0, 2, 1), ($4, $5, 'Foreign', 0, 1, 1)`,
      [STAFF, OTHER, SID, FOREIGN, OTHER_SID]);
    await q(`INSERT INTO members ("userId", "serverId", "joinedAt", roles) VALUES
             ($1, $2, 1, '[]'::jsonb), ($3, $2, 1, $4::jsonb), ($5, $2, 1, $6::jsonb)`,
      [OWNER, SID, M1, JSON.stringify([STAFF, OTHER]), M2, JSON.stringify([STAFF])]);
    // A private channel exactly as the channel permission routes persist it.
    await q(`INSERT INTO channel_permissions (_id, "channelId", "roleId", "serverId", allow, deny, "createdAt") VALUES
             ($1, $3, '__everyone__', $4, 0, $5, 1), ($2, $3, $6, $4, $5, 0, 1)`,
      [`${P}-cp-everyone`, `${P}-cp-staff`, CID, SID, PERMS.VIEW_CHANNELS, STAFF]);
  }

  beforeEach(seed);
  afterAll(cleanup);

  it('removes the role, its channel rows and its member references together', async () => {
    expect(await canViewChannel(M1, SID, CID)).toBe(true);
    expect(await canViewChannel(M2, SID, CID)).toBe(true);

    expect(await Roles.delete(STAFF, SID)).toBe(true);

    expect(await q(`SELECT 1 FROM roles WHERE _id=$1`, [STAFF])).toHaveLength(0);
    expect((await q(`SELECT "roleId" FROM channel_permissions WHERE "channelId"=$1`, [CID])).map((r: { roleId: string }) => r.roleId))
      .toEqual(['__everyone__']);
    expect(await memberRoles(M1)).toEqual([OTHER]);
    expect(await memberRoles(M2)).toEqual([]);
    expect(await canViewChannel(M1, SID, CID)).toBe(false);
    expect(await canViewChannel(M2, SID, CID)).toBe(false);
    expect(await resolvePermissions(M2, SID)).toBe(DEFAULT_PERMISSIONS);
  });

  it('keeps the community permission export working after a deletion', async () => {
    await Roles.delete(STAFF, SID);
    expect(await q(`SELECT 1 FROM roles WHERE _id=$1`, [STAFF])).toHaveLength(0);
    const server = (await q(`SELECT * FROM servers WHERE _id=$1`, [SID]))[0];
    const channels = await Channels.findByServer(SID);
    const roles = await Roles.findByServer(SID);
    const data = await Promise.all(channels.map(async (channel: { _id: string }) => ({
      channelId: String(channel._id),
      canonical: await ChannelPermissions.findByChannel(String(channel._id)),
      legacy: await Channels.findOverridesByChannel(String(channel._id)),
    })));
    // The serializer takes plain rows; repository interfaces carry no index signature.
    const channelRows = channels.map((row): Record<string, unknown> => ({ ...row }));
    const roleRows = roles.map((row): Record<string, unknown> => ({ ...row }));
    expect(() => buildPortableCommunityPermissionManifest(server, channelRows, roleRows, data as never)).not.toThrow();
  });

  it('refuses a role of another server or a missing role and changes nothing', async () => {
    expect(await Roles.delete(FOREIGN, SID)).toBe(false);
    expect(await Roles.delete(`${P}-role-missing`, SID)).toBe(false);
    expect(await q(`SELECT 1 FROM roles WHERE _id=$1`, [FOREIGN])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM channel_permissions WHERE "roleId"=$1`, [STAFF])).toHaveLength(1);
    expect(await memberRoles(M1)).toEqual([STAFF, OTHER]);
  });

  it('is atomic: a failure while updating members rolls the whole deletion back', async () => {
    await q(`CREATE FUNCTION pgt_rdel_fail() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN RAISE EXCEPTION 'injected member update failure'; END $$`);
    await q(`CREATE TRIGGER pgt_rdel_fail BEFORE UPDATE ON members FOR EACH ROW
             WHEN (NEW."serverId" = '${SID}') EXECUTE FUNCTION pgt_rdel_fail()`);

    await expect(Roles.delete(STAFF, SID)).rejects.toThrow(/injected member update failure/);

    expect(await q(`SELECT 1 FROM roles WHERE _id=$1`, [STAFF])).toHaveLength(1);
    expect(await q(`SELECT 1 FROM channel_permissions WHERE "roleId"=$1`, [STAFF])).toHaveLength(1);
    expect(await memberRoles(M1)).toEqual([STAFF, OTHER]);
    expect(await canViewChannel(M1, SID, CID)).toBe(true);
  });

  it('a dangling role id left by an older deletion grants nothing', async () => {
    // Rows as an older build left them: role row gone, references kept.
    await q(`DELETE FROM roles WHERE _id=$1`, [STAFF]);
    expect(await memberRoles(M1)).toEqual([STAFF, OTHER]);
    expect(await q(`SELECT 1 FROM channel_permissions WHERE "roleId"=$1`, [STAFF])).toHaveLength(1);

    expect(await canViewChannel(M1, SID, CID)).toBe(false);
    expect(await canViewChannel(M2, SID, CID)).toBe(false);
  });
});
