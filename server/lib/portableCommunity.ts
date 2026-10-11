// P7 C2: read-only, owner-authorized structural community export.
// This is deliberately NOT an importer or an account/community backup.
// Only explicitly selected fields cross this serialization boundary.
import { createHash } from 'node:crypto';
import { parsePermissionMask } from './permissionMaskInvariant';

type Row = Record<string, unknown>;
const MAX_NAME_LENGTH = 200;
const CHANNEL_TYPES = new Set(['text', 'voice', 'announcement', 'forum', 'stage']);

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function text(value: unknown, label: string, max: number, fallback?: string): string {
  if (value === null || value === undefined) {
    if (fallback !== undefined) return fallback;
    throw new TypeError(`Missing ${label}`);
  }
  if (typeof value !== 'string' || value.length > max) throw new TypeError(`Invalid ${label}`);
  return value;
}

function integer(value: unknown, label: string): number {
  const n = value === undefined || value === null ? 0 : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new TypeError(`Invalid ${label}`);
  }
  return n;
}

function uniqueIds<T extends { sourceId: string }>(rows: T[], label: string): T[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.sourceId)) throw new TypeError(`Duplicate ${label} source ID`);
    seen.add(row.sourceId);
  }
  return rows;
}

const excluded = Object.freeze([
  'users', 'memberships', 'memberRoleAssignments', 'messages', 'attachments',
  'channelPermissionOverrides', 'individualVisibilityOverrides',
  'invites', 'webhooks', 'bots', 'moderationRecords', 'secrets', 'credentials',
]);

export function buildPortableCommunityStructure(
  server: Row,
  categories: readonly Row[],
  channels: readonly Row[],
  roles: readonly Row[],
  exportedAt: string = new Date().toISOString(),
) {
  if (!Number.isFinite(Date.parse(exportedAt)) || new Date(exportedAt).toISOString() !== exportedAt) {
    throw new TypeError('Invalid export timestamp');
  }
  const sourceServerId = identifier(server._id, 'server ID');
  const mappedCategories = uniqueIds(categories.map(category => ({
    sourceId: identifier(category._id, 'category ID'),
    name: text(category.name, 'category name', MAX_NAME_LENGTH),
    position: integer(category.position, 'category position'),
    collapsed: category.collapsed === true,
  })), 'category').sort((a, b) => a.position - b.position || a.sourceId.localeCompare(b.sourceId));
  const categoryIds = new Set(mappedCategories.map(category => category.sourceId));

  const mappedRoles = uniqueIds(roles.map(role => ({
    sourceId: identifier(role._id, 'role ID'),
    name: text(role.name, 'role name', MAX_NAME_LENGTH),
    color: text(role.color, 'role color', 32, ''),
    position: integer(role.position, 'role position'),
    permissions: parsePermissionMask(role.permissions ?? 0, 'exported role permissions'),
  })), 'role').sort((a, b) => a.position - b.position || a.sourceId.localeCompare(b.sourceId));

  const mappedChannels = uniqueIds(channels.map(channel => {
    const sourceId = identifier(channel._id, 'channel ID');
    const type = text(channel.type, 'channel type', 32);
    if (!CHANNEL_TYPES.has(type)) throw new TypeError('Unsupported channel type in export');
    const categorySourceId = channel.categoryId == null || channel.categoryId === ''
      ? null : identifier(channel.categoryId, 'channel category ID');
    if (categorySourceId && !categoryIds.has(categorySourceId)) {
      throw new TypeError('Channel references an unknown category');
    }
    return {
      sourceId,
      name: text(channel.name, 'channel name', MAX_NAME_LENGTH),
      type,
      topic: text(channel.topic, 'channel topic', 2048, ''),
      categorySourceId,
      legacyCategoryName: text(channel.category, 'legacy category', MAX_NAME_LENGTH, ''),
      order: integer(channel.order ?? channel.position, 'channel order'),
      nsfw: channel.nsfw === true,
      slowmode: integer(channel.slowmode, 'slowmode'),
    };
  }), 'channel').sort((a, b) => a.order - b.order || a.sourceId.localeCompare(b.sourceId));

  const data = {
    format: 'bridge-portable-community-structure',
    version: 1,
    exportedAt,
    community: {
      sourceServerId,
      name: text(server.name, 'server name', MAX_NAME_LENGTH),
      description: text(server.description, 'server description', 2048, ''),
      icon: text(server.icon, 'server icon', 64, ''),
    },
    categories: mappedCategories,
    roles: mappedRoles,
    channels: mappedChannels,
  } as const;

  return {
    ...data,
    integrity: {
      algorithm: 'sha256',
      canonicalization: 'ordered-json-v1',
      digest: createHash('sha256').update(JSON.stringify(data), 'utf8').digest('hex'),
    },
    portability: { importSupported: false, excluded: [...excluded] },
  };
}
