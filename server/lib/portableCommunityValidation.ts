// P7 C3 groundwork: reject modified, oversized or internally inconsistent
// community-structure snapshots before any migration preview or DB write.
// SHA-256 is an accidental-corruption checksum, NOT an authenticity signature.
import { buildPortableCommunityStructure } from './portableCommunity';

type RecordValue = Record<string, unknown>;
export class PortableCommunityValidationError extends Error {
  readonly code = 'PORTABLE_COMMUNITY_INVALID';
  constructor() {
    super('Invalid or inconsistent portable community structure');
    this.name = 'PortableCommunityValidationError';
  }
}

function reject(): never { throw new PortableCommunityValidationError(); }
function object(value: unknown, keys: readonly string[]): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const row = value as RecordValue;
  const actual = Object.keys(row);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) return reject();
  return row;
}
function array(value: unknown, max: number): RecordValue[] {
  if (!Array.isArray(value) || value.length > max) return reject();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return reject();
    return row as RecordValue;
  });
}
function str(value: unknown, min: number, max: number): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) return reject();
  return value;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return reject();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') return reject();
  return value;
}
function id(value: unknown): string { return str(value, 1, 256); }
function ensureUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) reject();
}
function canonicalEquals(a: unknown, b: unknown): void {
  // No coercion; every exported field must survive parsing untouched.
  if (JSON.stringify(a) !== JSON.stringify(b)) reject();
}

export function validatePortableCommunityStructure(document: unknown) {
  try {
    // Limit before walking potentially attacker-controlled arrays and objects.
    const serialized = JSON.stringify(document);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > 512 * 1024) reject();
    const root = object(document, [
      'format', 'version', 'exportedAt', 'community', 'categories',
      'roles', 'channels', 'integrity', 'portability',
    ]);
    if (root.format !== 'bridge-portable-community-structure' || root.version !== 1) reject();
    const exportedAt = str(root.exportedAt, 20, 40);
    const c = object(root.community, ['sourceServerId', 'name', 'description', 'icon']);
    const sourceServerId = id(c.sourceServerId);
    str(c.name, 0, 200); str(c.description, 0, 2048); str(c.icon, 0, 64);

    const categories = array(root.categories, 2000).map(item => {
      const row = object(item, ['sourceId', 'name', 'position', 'collapsed']);
      return {
        sourceId: id(row.sourceId), name: str(row.name, 0, 200),
        position: number(row.position), collapsed: bool(row.collapsed),
      };
    });
    ensureUnique(categories.map(row => row.sourceId));
    const roles = array(root.roles, 2000).map(item => {
      const row = object(item, ['sourceId', 'name', 'color', 'position', 'permissions']);
      return {
        sourceId: id(row.sourceId), name: str(row.name, 0, 200),
        color: str(row.color, 0, 32), position: number(row.position),
        permissions: number(row.permissions),
      };
    });
    ensureUnique(roles.map(row => row.sourceId));
    const channels = array(root.channels, 2000).map(item => {
      const row = object(item, [
        'sourceId', 'name', 'type', 'topic', 'categorySourceId',
        'legacyCategoryName', 'order', 'nsfw', 'slowmode',
      ]);
      return {
        sourceId: id(row.sourceId), name: str(row.name, 0, 200),
        type: str(row.type, 1, 32), topic: str(row.topic, 0, 2048),
        categorySourceId: row.categorySourceId === null ? null : id(row.categorySourceId),
        legacyCategoryName: str(row.legacyCategoryName, 0, 200),
        order: number(row.order), nsfw: bool(row.nsfw), slowmode: number(row.slowmode),
      };
    });
    ensureUnique(channels.map(row => row.sourceId));

    const integrity = object(root.integrity, ['algorithm', 'canonicalization', 'digest']);
    if (integrity.algorithm !== 'sha256' || integrity.canonicalization !== 'ordered-json-v1' ||
        typeof integrity.digest !== 'string' || !/^[a-f0-9]{64}$/.test(integrity.digest)) reject();
    const portability = object(root.portability, ['importSupported', 'excluded']);
    if (portability.importSupported !== false || !Array.isArray(portability.excluded)) reject();

    const rebuilt = buildPortableCommunityStructure(
      {
        _id: sourceServerId, name: c.name, description: c.description, icon: c.icon,
      },
      categories.map(row => ({ _id: row.sourceId, name: row.name, position: row.position, collapsed: row.collapsed })),
      channels.map(row => ({
        _id: row.sourceId, name: row.name, type: row.type, topic: row.topic,
        categoryId: row.categorySourceId, category: row.legacyCategoryName,
        order: row.order, nsfw: row.nsfw, slowmode: row.slowmode,
      })),
      roles.map(row => ({
        _id: row.sourceId, name: row.name, color: row.color,
        position: row.position, permissions: row.permissions,
      })),
      exportedAt,
    );
    canonicalEquals(rebuilt.categories, categories);
    canonicalEquals(rebuilt.roles, roles);
    canonicalEquals(rebuilt.channels, channels);
    canonicalEquals(rebuilt.portability, portability);
    if (rebuilt.integrity.digest !== integrity.digest) reject();
    return rebuilt;
  } catch {
    // No parser error details are returned: this may ultimately process
    // hostile files and must not turn internal schema details into an oracle.
    return reject();
  }
}
