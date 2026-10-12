// P7 C3 groundwork: fail-closed intake of the C2 permission coverage file.
// No target access, ID remapping, apply, SQL write, or source-authentication claim.
import { createHash, timingSafeEqual } from 'node:crypto';
import { parsePermissionPair } from './permissionMaskInvariant';

type Dict = Record<string, unknown>;
const MAX_BYTES = 512 * 1024;
const FORMAT = 'bridge-portable-community-permissions';
const EXCLUDED = [
  'legacy-overrides', 'individual-user-overrides',
  'unknown-target-overrides', 'member-assignments',
] as const;

export class PortableCommunityPermissionsError extends Error {
  readonly code = 'PORTABLE_COMMUNITY_PERMISSIONS_INVALID';
  constructor() {
    super('Invalid community permission manifest');
    this.name = 'PortableCommunityPermissionsError';
  }
}
function bad(): never { throw new PortableCommunityPermissionsError(); }
function keys(value: unknown, fields: readonly string[]): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
  const obj = value as Dict;
  const got = Object.keys(obj);
  if (got.length !== fields.length || got.some(field => !fields.includes(field))) return bad();
  return obj;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256) return bad();
  return value;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return bad();
  return value;
}
function asciiOrder(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }
function strictlyOrdered(values: string[]): void {
  for (let i = 1; i < values.length; i++) {
    if (asciiOrder(values[i - 1]!, values[i]!) >= 0) bad();
  }
}
function equalStringList(value: unknown, expected: readonly string[]): void {
  if (!Array.isArray(value) || value.length !== expected.length ||
      value.some((x, i) => x !== expected[i])) bad();
}

export function validatePortableCommunityPermissionManifest(input: unknown) {
  try {
    const serialized = JSON.stringify(input);
    if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) return bad();
    const root = keys(input, ['format', 'version', 'exportedAt', 'sourceServerId',
      'channels', 'unsupported', 'integrity', 'portability']);
    if (root.format !== FORMAT || root.version !== 1) bad();
    const exportedAt = root.exportedAt;
    if (typeof exportedAt !== 'string' || !Number.isFinite(Date.parse(exportedAt)) ||
        new Date(exportedAt).toISOString() !== exportedAt) bad();
    const sourceServerId = id(root.sourceServerId);
    if (!Array.isArray(root.channels) || root.channels.length > 500) bad();

    const channels = root.channels.map(value => {
      const c = keys(value, ['channelSourceId', 'overrides']);
      const channelSourceId = id(c.channelSourceId);
      if (!Array.isArray(c.overrides) || c.overrides.length > 2000) bad();
      const overrides = c.overrides.map(row => {
        const o = keys(row, ['roleSourceId', 'allow', 'deny']);
        const roleSourceId = id(o.roleSourceId);
        const { allow, deny } = parsePermissionPair(o.allow, o.deny, 'portable permission');
        return { roleSourceId, allow, deny };
      });
      strictlyOrdered(overrides.map(o => o.roleSourceId));
      return { channelSourceId, overrides };
    });
    strictlyOrdered(channels.map(c => c.channelSourceId));

    const unknown = keys(root.unsupported, [
      'legacyOverrideRows', 'individualOverrideRows', 'unknownTargetRows',
    ]);
    const unsupported = {
      legacyOverrideRows: count(unknown.legacyOverrideRows),
      individualOverrideRows: count(unknown.individualOverrideRows),
      unknownTargetRows: count(unknown.unknownTargetRows),
    };

    const integ = keys(root.integrity, ['algorithm', 'canonicalization', 'digest']);
    if (integ.algorithm !== 'sha256' || integ.canonicalization !== 'ordered-json-v1' ||
        typeof integ.digest !== 'string' || !/^[0-9a-f]{64}$/.test(integ.digest)) bad();
    const capabilities = keys(root.portability, ['importSupported', 'migrationReady', 'included', 'excluded']);
    if (capabilities.importSupported !== false || capabilities.migrationReady !== false) bad();
    equalStringList(capabilities.included, ['canonical-role-overrides', 'canonical-everyone-overrides']);
    equalStringList(capabilities.excluded, EXCLUDED);

    const data = { format: FORMAT, version: 1, exportedAt, sourceServerId, channels, unsupported };
    const digest = createHash('sha256').update(JSON.stringify(data), 'utf8').digest();
    if (!timingSafeEqual(digest, Buffer.from(integ.digest, 'hex'))) bad();
    return {
      ...data,
      integrity: { algorithm: 'sha256', canonicalization: 'ordered-json-v1', digest: integ.digest },
      portability: {
        importSupported: false,
        migrationReady: false,
        included: ['canonical-role-overrides', 'canonical-everyone-overrides'],
        excluded: [...EXCLUDED],
      },
    };
  } catch {
    // Uniform error avoids leaking whether an attacker hit parsing,
    // checksum, permission bit validity, or unsupported-field validation.
    return bad();
  }
}
