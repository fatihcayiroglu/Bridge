// P7 C4 groundwork: verify the identity of a SOURCE whose public key was
// pinned independently by the destination operator. No import/apply path.
// The signature proves that holder of the pinned key attested these digests;
// it DOES NOT prove snapshot atomicity, durable approval, or safe DB writes.
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { inspectPortableCommunityManifestPair } from './portableCommunityPair';

export type PortableSourceAttestation = {
  format: 'bridge-portable-community-source-attestation';
  version: 1;
  sourceOrigin: string;
  sourceServerId: string;
  snapshotId: string;
  structureDigest: string;
  permissionsDigest: string;
  issuedAt: string;
  expiresAt: string;
  keyFingerprint: string;
  signature: string;
};
type Fields = Omit<PortableSourceAttestation, 'signature'>;
const FIELDS = [
  'format', 'version', 'sourceOrigin', 'sourceServerId', 'snapshotId',
  'structureDigest', 'permissionsDigest', 'issuedAt', 'expiresAt',
  'keyFingerprint', 'signature',
] as const;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
const B64URL = /^[A-Za-z0-9_-]{86}$/;

export class PortableSourceAttestationError extends Error {
  readonly code = 'PORTABLE_SOURCE_ATTESTATION_INVALID';
  constructor() {
    super('Invalid or untrusted portable source attestation');
    this.name = 'PortableSourceAttestationError';
  }
}
function bad(): never { throw new PortableSourceAttestationError(); }
export function isCanonicalPortableSourceOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.origin === value && !!u.hostname;
  } catch { return false; }
}
function isoTime(value: unknown): number {
  if (typeof value !== 'string' || value.length !== 24 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) bad();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) bad();
  return timestamp;
}

/** Domain-separated canonical UTF-8 signature payload. No JSON key-order ambiguity. */
export function portableSourceAttestationSigningBytes(value: Fields): Buffer {
  const fields = {
    format: value.format, version: value.version, sourceOrigin: value.sourceOrigin,
    sourceServerId: value.sourceServerId, snapshotId: value.snapshotId,
    structureDigest: value.structureDigest, permissionsDigest: value.permissionsDigest,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    keyFingerprint: value.keyFingerprint,
  };
  return Buffer.from('bridge-portable-source-attestation-v1\n' + JSON.stringify(fields), 'utf8');
}

/**
 * Verification is OFFLINE and only against a trusted key from local admin
 * configuration, NEVER a key or URL supplied inside the untrusted file.
 * The output is informational, not a migration authorization.
 */
export function verifyPortableSourceAttestation(args: {
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  trustedSourcePublicKeyPem: string;
  now?: number;
}) {
  try {
    const pair = inspectPortableCommunityManifestPair(args.structure, args.permissions);
    if (!isCanonicalPortableSourceOrigin(args.expectedSourceOrigin)) bad();
    const a = args.attestation;
    if (!a || typeof a !== 'object' || Array.isArray(a)) bad();
    const obj = a as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length !== FIELDS.length || keys.some(k => !(FIELDS as readonly string[]).includes(k))) bad();
    if (obj.format !== 'bridge-portable-community-source-attestation' || obj.version !== 1 ||
        obj.sourceOrigin !== args.expectedSourceOrigin ||
        obj.sourceServerId !== pair.sourceServerId ||
        typeof obj.snapshotId !== 'string' || !TOKEN.test(obj.snapshotId) ||
        obj.structureDigest !== pair.structureDigest ||
        obj.permissionsDigest !== pair.permissionsDigest ||
        typeof obj.keyFingerprint !== 'string' || !HEX64.test(obj.keyFingerprint) ||
        typeof obj.signature !== 'string' || !B64URL.test(obj.signature)) bad();

    const issued = isoTime(obj.issuedAt);
    const expires = isoTime(obj.expiresAt);
    const now = args.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 ||
        issued > now + CLOCK_SKEW_MS || now >= expires ||
        expires <= issued || expires - issued > MAX_AGE_MS) bad();

    const publicKey = createPublicKey(args.trustedSourcePublicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') bad();
    const keyBytes = publicKey.export({ type: 'spki', format: 'der' });
    const fingerprint = createHash('sha256').update(keyBytes).digest();
    const expected = Buffer.from(obj.keyFingerprint, 'hex');
    if (fingerprint.length !== expected.length || !timingSafeEqual(fingerprint, expected)) bad();

    // The signature length check prevents accepting noncanonical base64url
    // encodings of the same signature and bounds attacker-controlled input.
    const signature = Buffer.from(obj.signature, 'base64url');
    if (signature.length !== 64 || signature.toString('base64url') !== obj.signature) bad();
    const payload = portableSourceAttestationSigningBytes(obj as Fields);
    if (!verify(null, payload, publicKey, signature)) bad();
    return {
      mode: 'read-only' as const,
      sourceSignatureValid: true as const,
      importSupported: false as const,
      writesPerformed: false as const,
      mappingApproved: false as const,
      snapshotAtomicityVerified: false as const,
      trustedSourceOrigin: args.expectedSourceOrigin,
      sourceServerId: pair.sourceServerId,
      snapshotId: obj.snapshotId,
      structureDigest: pair.structureDigest,
      permissionsDigest: pair.permissionsDigest,
      keyFingerprint: obj.keyFingerprint,
      blockers: [
        'SOURCE_SNAPSHOT_ATOMICITY_NOT_VERIFIED',
        'DURABLE_SINGLE_USE_OWNER_APPROVAL_NOT_IMPLEMENTED',
        'DESTINATION_TRANSACTIONAL_IMPORT_NOT_IMPLEMENTED',
      ],
    };
  } catch {
    // No distinguishable origin, checksum, clock, or signature oracle.
    return bad();
  }
}
