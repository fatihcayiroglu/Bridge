// P7 C4: source-side read-only paired snapshot and offline attestation issuer.
// No HTTP route, source trust store, replay authorization or import/apply path.
import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto';
import { buildPortableCommunityStructure } from './portableCommunity';
import { buildPortableCommunityPermissionManifest, type SourcePermissionRows } from './portableCommunityPermissions';
import { inspectPortableCommunityManifestPair } from './portableCommunityPair';
import {
  isCanonicalPortableSourceOrigin, portableSourceAttestationSigningBytes,
  verifyPortableSourceAttestation, type PortableSourceAttestation,
} from './portableSourceAttestation';

type Row = Record<string, unknown>;
type Client = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
};
type Pool = { connect(): Promise<Client> };
const MAX_DOCUMENT_BYTES = 512 * 1024;

// Never return SQL, secrets, owner identities or untrusted row content to API callers.
export class PortableSourceSnapshotError extends Error {
  readonly code = 'PORTABLE_SOURCE_SNAPSHOT_UNAVAILABLE';
  constructor() {
    super('Portable source snapshot cannot be issued safely');
    this.name = 'PortableSourceSnapshotError';
  }
}
function refuse(): never { throw new PortableSourceSnapshotError(); }
function textId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) refuse();
  return value;
}
function bool01(value: unknown): boolean {
  // PostgreSQL channels.nsfw is INTEGER; a truthy 1 must NOT silently become
  // "false" when serialized by the portable structure builder.
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  refuse();
}
function normalizeChannel(row: Row): Row {
  const value = normalize(row, ['order', 'position', 'slowmode']);
  value.nsfw = bool01(row.nsfw);
  return value;
}
function numeric(value: unknown): number {
  const candidate = typeof value === 'number' ? value
    : typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(candidate) || candidate < 0) refuse();
  return candidate;
}
function normalize(row: Row, fields: string[]): Row {
  const value: Row = { ...row };
  for (const field of fields) {
    // PostgreSQL BIGINTs arrive as strings by default. Never round, coerce
    // NULL to zero, or convert scientific notation to a permission mask.
    if (value[field] !== undefined && value[field] !== null) value[field] = numeric(value[field]);
  }
  return value;
}
async function read(client: Client, sql: string, params: unknown[], max: number) {
  const result = await client.query(sql, params);
  if (!result || !Array.isArray(result.rows) || result.rows.length > max) refuse();
  return result.rows;
}

export async function issueAtomicPortableSourceAttestation(input: {
  pool: Pool;
  sourceServerId: string;
  ownerUserId: string;
  sourceOrigin: string;
  signingPrivateKeyPem: string;
  now?: number;
}) {
  const sid = textId(input.sourceServerId);
  const owner = textId(input.ownerUserId);
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0 || now > 8_640_000_000_000_000 - 300_000 ||
      !isCanonicalPortableSourceOrigin(input.sourceOrigin)) refuse();
  // The trust relationship and private key lifecycle are controlled by the
  // source deployer, not by the client request. Never accept them from HTTP.
  let client: Client | null = null;
  let begun = false;
  let committed = false;
  try {
    const key = createPrivateKey(input.signingPrivateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') refuse();
    const publicKey = createHash('sha256')
      .update(createPublicKey(key).export({ type: 'spki', format: 'der' }))
      .digest('hex');
    client = await input.pool.connect();
    // FIRST query on this physical PG session sets the isolation snapshot;
    // no repository calls to unrelated pool clients are allowed.
    begun = true;
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const serverRows = await read(client,
      'SELECT _id, "ownerId", name, description, icon FROM servers WHERE _id=$1 LIMIT 2', [sid], 2);
    // With noUncheckedIndexedAccess, even length===1 does not narrow [0].
    // Check the actual row before accessing ownerId or passing it to builders.
    // Never treat a missing server as an approved export.
    const server = serverRows[0];
    if (!server || serverRows.length !== 1 || server.ownerId !== owner) refuse();
    const categories = await read(client,
      'SELECT _id, name, position, collapsed FROM channel_categories WHERE "serverId"=$1 LIMIT 501', [sid], 500);
    const channels = (await read(client,
      'SELECT _id, "serverId", name, type, topic, "categoryId", category, "order", position, nsfw, slowmode FROM channels WHERE "serverId"=$1 LIMIT 501',
      [sid], 500)).map(normalizeChannel);
    const roles = (await read(client,
      'SELECT _id, "serverId", name, color, position, permissions FROM roles WHERE "serverId"=$1 LIMIT 2001',
      [sid], 2000)).map(row => normalize(row, ['position', 'permissions']));
    const canonical = (await read(client,
      'SELECT p."channelId", p."serverId", p."roleId", p.allow, p.deny FROM channel_permissions p WHERE p."serverId"=$1 OR p."channelId" IN (SELECT _id FROM channels WHERE "serverId"=$1) LIMIT 20001',
      [sid], 20000)).map(row => normalize(row, ['allow', 'deny']));
    // Legacy overrides are intentionally EXCLUDED from migration payloads;
    // count them without selecting targetId, userId or other sensitive columns.
    const legacy = await read(client,
      'SELECT o."channelId" FROM channel_overrides o JOIN channels c ON c._id=o."channelId" WHERE c."serverId"=$1 LIMIT 20001',
      [sid], 20000);
    const allowed = new Set(channels.map(channel => textId(channel._id)));
    for (const item of canonical) {
      // Select rows by BOTH claimed server and owning channel; otherwise a
      // mis-scoped or orphan row could vanish silently. Every returned row
      // must belong to the exact source channel and source community.
      if (!allowed.has(textId(item.channelId)) || item.serverId !== sid) refuse();
    }
    const permissions: SourcePermissionRows[] = channels.map(channel => ({
      channelId: textId(channel._id),
      canonical: canonical.filter(item => item.channelId === channel._id),
      legacy: legacy.filter(item => item.channelId === channel._id),
    }));
    const exportedAt = new Date(now).toISOString();
    const structure = buildPortableCommunityStructure(
      server, categories.map(x => normalize(x, ['position'])), channels, roles, exportedAt);
    const permissionManifest = buildPortableCommunityPermissionManifest(
      server, channels, roles, permissions, exportedAt);
    for (const doc of [structure, permissionManifest]) {
      if (Buffer.byteLength(JSON.stringify(doc), 'utf8') > MAX_DOCUMENT_BYTES) refuse();
    }
    const pair = inspectPortableCommunityManifestPair(structure, permissionManifest);
    if (pair.sourceServerId !== sid ||
        pair.sourceSnapshotTimes.structure !== pair.sourceSnapshotTimes.permissions) refuse();

    await client.query('COMMIT');
    committed = true;
    const fields: Omit<PortableSourceAttestation, 'signature'> = {
      format: 'bridge-portable-community-source-attestation',
      version: 1,
      sourceOrigin: input.sourceOrigin,
      sourceServerId: sid,
      snapshotId: randomBytes(24).toString('base64url'),
      structureDigest: pair.structureDigest,
      permissionsDigest: pair.permissionsDigest,
      issuedAt: exportedAt,
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
      keyFingerprint: publicKey,
    };
    const attestation: PortableSourceAttestation = {
      ...fields,
      signature: sign(null, portableSourceAttestationSigningBytes(fields), key).toString('base64url'),
    };
    // Self-check the public verifier before returning any artifact.
    const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    verifyPortableSourceAttestation({
      structure, permissions: permissionManifest, attestation,
      expectedSourceOrigin: input.sourceOrigin, trustedSourcePublicKeyPem: pub, now,
    });
    return {
      mode: 'read-only' as const, importSupported: false as const, writesPerformed: false as const,
      mappingApproved: false as const, approvalReusable: false as const,
      sourceReadIsolation: 'single-client-repeatable-read' as const,
      // A remote verifier cannot independently prove the source operator
      // actually used a transaction; no falsely certified proof is exposed.
      remotelyVerifiedAtomicity: false as const,
      structure, permissions: permissionManifest, attestation,
    };
  } catch {
    if (begun && !committed && client) {
      try { await client.query('ROLLBACK'); } catch { /* fail closed */ }
    }
    return refuse();
  } finally {
    if (client) client.release();
  }
}
