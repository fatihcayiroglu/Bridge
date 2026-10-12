// P7 C3: deterministic topology fingerprint for comparing two READ-ONLY
// owner preflight requests. This is not a DB revision, signed snapshot, lock,
// durable approval, concurrency barrier, or authorization to import.
import { createHash } from 'node:crypto';
import { parsePermissionMask } from './permissionMaskInvariant';

type Row = Record<string, unknown>;
type Kind = 'category' | 'role' | 'channel';
export type DestinationTopology = {
  serverId: string;
  categories: readonly Row[];
  roles: readonly Row[];
  channels: readonly Row[];
};
const CHANNEL_TYPES = ['text', 'voice', 'forum', 'stage', 'announcement'];
function id(v: unknown): string {
  if (typeof v !== 'string' || !v || v.length > 256) throw new TypeError('Invalid topology ID');
  return v;
}
function label(v: unknown): string {
  if (typeof v !== 'string' || v.length > 200) throw new TypeError('Invalid topology name');
  return v;
}
function sortById<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function rowsOf(kind: Kind, rows: readonly Row[], serverId: string) {
  const limit = kind === 'channel' ? 500 : 2000;
  if (!Array.isArray(rows) || rows.length > limit) throw new TypeError('Invalid topology row count');
  const seen = new Set<string>();
  const result: Array<{ id: string; name: string; type?: string;
    permissions?: number; categoryId?: string | null }> = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        row.serverId !== serverId) throw new TypeError('Foreign target topology row');
    const rowId = id(row._id);
    if (seen.has(rowId)) throw new TypeError('Duplicate target topology ID');
    seen.add(rowId);
    const entry: typeof result[number] = { id: rowId, name: label(row.name) };
    if (kind === 'role') {
      entry.permissions = parsePermissionMask(row.permissions, 'target role permission mask');
    }
    if (kind === 'channel') {
      if (typeof row.type !== 'string' || !CHANNEL_TYPES.includes(row.type)) {
        throw new TypeError('Invalid target channel type');
      }
      entry.type = row.type;
      const rawCategory = row.categoryId;
      entry.categoryId = rawCategory === null || rawCategory === undefined ? null : id(rawCategory);
    }
    result.push(entry);
  }
  return sortById(result);
}

/** Hash only allowlisted identity/permission metadata, with deterministic sorting. */
export function fingerprintDestinationTopology(value: DestinationTopology): string {
  const serverId = id(value.serverId);
  const categories = rowsOf('category', value.categories, serverId);
  const roles = rowsOf('role', value.roles, serverId);
  const channels = rowsOf('channel', value.channels, serverId);
  const categoryIds = new Set(categories.map(row => row.id));
  for (const channel of channels) {
    if (channel.categoryId != null && !categoryIds.has(channel.categoryId)) {
      throw new TypeError('Destination channel references missing category');
    }
  }
  const canonical = {
    format: 'bridge-destination-topology-review',
    version: 1,
    serverId, categories, roles, channels,
  };
  return createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}
