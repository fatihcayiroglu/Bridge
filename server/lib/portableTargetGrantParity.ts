// P7 C4 — target channel-grant parity reader for a FUTURE atomic importer.
// This helper is UNMOUNTED and does not issue owner consent or apply data.
// Caller must verify pinned-source signature + exact topology independently.
import { createHash } from 'node:crypto';
import { parsePermissionPair } from './permissionMaskInvariant';
import { validatePortableCommunityPermissionManifest } from './portableCommunityPermissionsValidation';

type Row = Record<string, unknown>;
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };
type Link = { sourceId: string; targetId: string };
const MAX_LINKS = 2000;
const MAX_GRANTS = 20000;

export class PortableTargetGrantParityError extends Error {
  readonly code = 'PORTABLE_TARGET_GRANT_PARITY_UNAVAILABLE';
  constructor() {
    super('Destination permission parity could not be verified');
    this.name = 'PortableTargetGrantParityError';
  }
}
function refuse(): never { throw new PortableTargetGrantParityError(); }
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 ||
      value.trim() !== value || /[\x00-\x1f\x7f]/.test(value)) refuse();
  return value;
}
function links(input: unknown, limit: number): Map<string, string> {
  if (!Array.isArray(input) || input.length > limit) refuse();
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) refuse();
    const fields = Object.keys(item);
    if (fields.length !== 2 || !fields.includes('sourceId') || !fields.includes('targetId')) refuse();
    const link = item as Link;
    const source = id(link.sourceId), dest = id(link.targetId);
    if (result.has(source) || used.has(dest)) refuse();
    result.set(source, dest);
    used.add(dest);
  }
  return result;
}
async function read(client: Client, sql: string, params: unknown[], max: number): Promise<Row[]> {
  const result = await client.query(sql, params);
  if (!result || !Array.isArray(result.rows) || result.rows.length > max) refuse();
  return result.rows;
}
type Grant = { channel: string; role: string; allow: number; deny: number };
function grantKey(g: Grant): string { return JSON.stringify([g.channel, g.role]); }
function ordered(grants: Grant[]): Grant[] {
  return grants.sort((a, b) => grantKey(a).localeCompare(grantKey(b)));
}

/**
 * Must be called on the EXACT physical PostgreSQL client of an already-open
 * SERIALIZABLE READ WRITE importer transaction. Locks the current destination
 * owner row and existing mapped channel/role/grant rows, and reads absent-row
 * predicates under SSI. A caller may not COMMIT an apply based on a detached
 * review or an independent pool client. The caller still must recheck signed
 * source authenticity, explicit mapping, full target topology and fresh owner
 * step-up within this transaction. This helper NEVER executes BEGIN or COMMIT.
 */
export async function requireMappedDestinationGrantParity(input: {
  client: Client;
  targetServerId: string;
  ownerId: string;
  sourcePermissions: unknown;
  mapping: { roles: unknown; channels: unknown };
}): Promise<{
  mode: 'transaction-check-only';
  targetGrantDigest: string;
  checkedChannels: number;
  checkedGrants: number;
  importSupported: false;
  writesPerformed: false;
}> {
  try {
    const sid = id(input.targetServerId), owner = id(input.ownerId);
    const source = validatePortableCommunityPermissionManifest(input.sourcePermissions);
    const roleLinks = links(input.mapping.roles, MAX_LINKS);
    const channelLinks = links(input.mapping.channels, 500);
    // @everyone is a synthetic target; never map another role to that ID.
    if ([...roleLinks.values()].some(value => value === sid || value === '__everyone__')) refuse();
    if (source.channels.length !== channelLinks.size ||
        source.channels.some(x => !channelLinks.has(x.channelSourceId))) refuse();

    const state = await read(input.client,
      "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly",
      [], 1);
    if (state.length !== 1 || state[0]?.isolation !== 'serializable' ||
        state[0]?.readonly !== 'off') refuse();

    const current = await read(input.client,
      'SELECT _id FROM servers WHERE _id=$1 AND "ownerId"=$2 FOR UPDATE',
      [sid, owner], 1);
    if (current.length !== 1 || current[0]?._id !== sid) refuse();

    const targetChannelIds = [...channelLinks.values()];
    const targetRoleIds = [...roleLinks.values()];
    const channels = await read(input.client,
      'SELECT _id, "serverId" FROM channels WHERE _id = ANY($1::text[]) FOR SHARE',
      [targetChannelIds], 500);
    if (channels.length !== targetChannelIds.length ||
        channels.some(x => x.serverId !== sid ||
          !targetChannelIds.includes(id(x._id)))) refuse();
    const roles = await read(input.client,
      'SELECT _id, "serverId" FROM roles WHERE _id = ANY($1::text[]) FOR SHARE',
      [targetRoleIds], MAX_LINKS);
    if (roles.length !== targetRoleIds.length ||
        roles.some(x => x.serverId !== sid || !targetRoleIds.includes(id(x._id)))) refuse();

    const expected: Grant[] = [];
    const seenExpected = new Set<string>();
    for (const sourceChannel of source.channels) {
      const targetChannel = channelLinks.get(sourceChannel.channelSourceId);
      if (!targetChannel) refuse();
      for (const row of sourceChannel.overrides) {
        const targetRole = row.roleSourceId === '__everyone__'
          ? sid : roleLinks.get(row.roleSourceId);
        if (!targetRole) refuse();
        const pair = parsePermissionPair(row.allow, row.deny);
        const grant = { channel: targetChannel, role: targetRole,
          allow: pair.allow, deny: pair.deny };
        const key = grantKey(grant);
        if (seenExpected.has(key)) refuse();
        seenExpected.add(key);
        expected.push(grant);
      }
    }
    if (expected.length > MAX_GRANTS) refuse();

    // Legacy/user-specific destination grants have no safe v1 identity map.
    // Fail closed instead of assuming that omitted rows can be preserved.
    const legacy = await read(input.client,
      'SELECT 1 FROM channel_overrides WHERE "channelId" = ANY($1::text[]) LIMIT 1',
      [targetChannelIds], 1);
    if (legacy.length) refuse();

    const actualRows = await read(input.client,
      'SELECT "channelId", "serverId", "roleId", allow, deny FROM channel_permissions WHERE "channelId" = ANY($1::text[]) LIMIT 20001 FOR SHARE',
      [targetChannelIds], MAX_GRANTS);
    const actual: Grant[] = [];
    const seenActual = new Set<string>();
    for (const row of actualRows) {
      const channel = id(row.channelId), rawRole = id(row.roleId);
      const role = rawRole === '__everyone__' ? sid : rawRole;
      if (row.serverId !== sid || !targetChannelIds.includes(channel) ||
          (role !== sid && !targetRoleIds.includes(role))) refuse();
      const pair = parsePermissionPair(row.allow, row.deny);
      const grant = { channel, role, allow: pair.allow, deny: pair.deny };
      const key = grantKey(grant);
      if (seenActual.has(key)) refuse();
      seenActual.add(key);
      actual.push(grant);
    }
    const a = JSON.stringify(ordered(actual)), b = JSON.stringify(ordered(expected));
    if (a !== b) refuse();
    const digest = createHash('sha256')
      .update('bridge-portable-target-grant-parity-v1\n')
      .update(JSON.stringify({ targetServerId: sid, grants: ordered(actual) }))
      .digest('hex');
    return {
      mode: 'transaction-check-only',
      targetGrantDigest: digest,
      checkedChannels: targetChannelIds.length,
      checkedGrants: actual.length,
      importSupported: false,
      writesPerformed: false,
    };
  } catch {
    return refuse();
  }
}
