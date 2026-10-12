// P7 C4: destination-side operator-pinned source trust registry.
// Offline, read-only. Never learns keys from a manifest, Origin/Host header,
// DNS, or a remote JWKS endpoint. No destination import/approval privileges.
import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import {
  isCanonicalPortableSourceOrigin, verifyPortableSourceAttestation,
  PortableSourceAttestationError,
} from './portableSourceAttestation';

const MAX_REGISTRY_BYTES = 64 * 1024;
const MAX_KEYS = 32;
const KEYS = ['sourceOrigin', 'publicKeyPem', 'activeFrom', 'activeUntil', 'revoked'] as const;
const HEX = /^[0-9a-f]{64}$/;

type TrustedKey = {
  sourceOrigin: string;
  publicKeyPem: string;
  activeFrom: string;
  activeUntil: string;
  revoked: boolean;
  fingerprint: string;
};
function invalid(): never { throw new PortableSourceAttestationError(); }
function canonicalTime(raw: unknown): number {
  if (typeof raw !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) invalid();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) invalid();
  return parsed;
}
function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid();
  return raw as Record<string, unknown>;
}
function equalKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(raw);
  return keys.length === expected.length && keys.every(k => expected.includes(k));
}
/**
 * Parse an independently provisioned operator policy. An inactive or revoked
 * key is retained as metadata, NEVER accepted as a signer.
 * This is a configuration verifier, not a key management/user-facing API.
 */
export function parsePinnedPortableSourceRegistry(raw: string): readonly TrustedKey[] {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_REGISTRY_BYTES) invalid();
    const document = obj(JSON.parse(raw) as unknown);
    if (!equalKeys(document, ['format', 'version', 'keys']) ||
        document.format !== 'bridge-portable-source-trust-registry' ||
        document.version !== 1 || !Array.isArray(document.keys) ||
        document.keys.length < 1 || document.keys.length > MAX_KEYS) invalid();
    const used = new Set<string>();
    const parsed: TrustedKey[] = [];
    for (const entry of document.keys) {
      const record = obj(entry);
      if (!equalKeys(record, KEYS) ||
          !isCanonicalPortableSourceOrigin(record.sourceOrigin) ||
          typeof record.publicKeyPem !== 'string' ||
          record.publicKeyPem.length > 1000 ||
          typeof record.revoked !== 'boolean') invalid();
      // Explicit narrowing is required: validating an unknown record field
      // through a helper does not give TypeScript a string type to retain.
      const activeFrom = record.activeFrom;
      const activeUntil = record.activeUntil;
      if (typeof activeFrom !== 'string' || typeof activeUntil !== 'string') invalid();
      const from = canonicalTime(activeFrom);
      const until = canonicalTime(activeUntil);
      if (from >= until) invalid();
      const key = createPublicKey(record.publicKeyPem);
      if (key.asymmetricKeyType !== 'ed25519') invalid();
      const pem = key.export({ type: 'spki', format: 'pem' }).toString();
      // Do not let Node accept valid public keys with ignored trailing data.
      if (pem !== record.publicKeyPem) invalid();
      const fingerprint = createHash('sha256')
        .update(key.export({ type: 'spki', format: 'der' })).digest('hex');
      const tuple = record.sourceOrigin + '\n' + fingerprint;
      if (used.has(tuple)) invalid();
      used.add(tuple);
      parsed.push(Object.freeze({
        sourceOrigin: record.sourceOrigin,
        publicKeyPem: pem,
        activeFrom,
        activeUntil,
        revoked: record.revoked,
        fingerprint,
      } as TrustedKey));
    }
    return Object.freeze(parsed);
  } catch { return invalid(); }
}

/**
 * Verify an attestation only with a PINNED matching key for a caller-selected
 * trusted origin. Artifacts can never introduce a new signing key or origin.
 * Revocation wins over old signatures; rotation requires deliberate keyring
 * replacement with both keys during overlap. No TOFU and no write authority.
 */
export function verifyAttestationAgainstPinnedRegistry(args: {
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  expectedSourceOrigin: string;
  // Exact source community approved by the DESTINATION operator. Do not
  // derive this identifier from the signed artifact itself.
  expectedSourceServerId: string;
  operatorRegistryJson: string;
  now?: number;
}) {
  try {
    if (!isCanonicalPortableSourceOrigin(args.expectedSourceOrigin) ||
        typeof args.expectedSourceServerId !== 'string' ||
        args.expectedSourceServerId.length === 0 ||
        args.expectedSourceServerId.length > 256) invalid();
    const clock = args.now ?? Date.now();
    if (!Number.isSafeInteger(clock) || clock < 0) invalid();
    const attestation = obj(args.attestation);
    if (attestation.sourceOrigin !== args.expectedSourceOrigin ||
        attestation.sourceServerId !== args.expectedSourceServerId ||
        typeof attestation.keyFingerprint !== 'string' ||
        !HEX.test(attestation.keyFingerprint)) invalid();
    const issued = canonicalTime(attestation.issuedAt);
    const pins = parsePinnedPortableSourceRegistry(args.operatorRegistryJson);
    // Match a fixed fingerprint without an artifact-selected key lookup URL.
    // Every trusted key is from local operator configuration alone.
    const candidate = Buffer.from(attestation.keyFingerprint, 'hex');
    const match = pins.find(k =>
      k.sourceOrigin === args.expectedSourceOrigin &&
      timingSafeEqual(candidate, Buffer.from(k.fingerprint, 'hex')));
    if (!match || match.revoked) invalid();
    const from = canonicalTime(match.activeFrom);
    const until = canonicalTime(match.activeUntil);
    if (issued < from || issued >= until || clock < from || clock >= until) invalid();
    return {
      ...verifyPortableSourceAttestation({
        structure: args.structure,
        permissions: args.permissions,
        attestation: args.attestation,
        expectedSourceOrigin: args.expectedSourceOrigin,
        trustedSourcePublicKeyPem: match.publicKeyPem,
        now: clock,
      }),
      trustPolicy: 'operator-pinned-revocable-v1' as const,
      importSupported: false as const,
      writesPerformed: false as const,
      mappingApproved: false as const,
    };
  } catch { return invalid(); }
}
