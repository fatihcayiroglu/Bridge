// P7 C4 — pure DESTINATION trust decision. A policy must be loaded only from
// independently authenticated operator-managed configuration (NOT the export,
// request JSON, Host header, DNS discovery, remote JWKS, or TOFU).
// This helper never authorizes an import or records an approval/replay token.
import { createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import {
  isCanonicalPortableSourceOrigin,
  verifyPortableSourceAttestation,
} from './portableSourceAttestation';

export type PinnedSourceKey = {
  publicKeyPem: string;
  keyFingerprint: string;
  activatedAt: string; // canonical ISO UTC, inclusive
  retiresAt: string | null; // canonical ISO UTC, exclusive; null until operator schedules retirement
  revoked: boolean; // emergency revocation always rejects, including old proofs
};
export type TrustedPortableSourcePolicy = {
  sourceOrigin: string;
  sourceServerId: string;
  keys: PinnedSourceKey[];
};

export class PortableSourceTrustPolicyError extends Error {
  readonly code = 'PORTABLE_SOURCE_TRUST_UNAVAILABLE';
  constructor() {
    super('Untrusted or invalid portable source proof');
    this.name = 'PortableSourceTrustPolicyError';
  }
}
function deny(): never { throw new PortableSourceTrustPolicyError(); }
const HEX = /^[a-f0-9]{64}$/;
const MAX_KEYS = 16;
function canonicalUtcTime(raw: unknown): number {
  if (typeof raw !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(raw)) deny();
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) deny();
  return parsed;
}
function exactKeys(input: object, allowed: readonly string[]): boolean {
  const keys = Object.keys(input);
  return keys.length === allowed.length && keys.every(key => allowed.includes(key));
}
function pinnedKeyDer(pem: unknown): Buffer {
  if (typeof pem !== 'string' || pem.length > 2048 || pem.length < 80) deny();
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519' ||
        key.export({ type: 'spki', format: 'pem' }).toString() !== pem) deny();
    return key.export({ type: 'spki', format: 'der' });
  } catch {
    return deny();
  }
}

/**
 * Checks CURRENT operator-controlled trust policy and the already signed
 * source artifact. Rotation is achieved by overlapping explicit pins.
 * Emergency revocation/retirement always denies a proof, even if signed
 * earlier; there is no fallback to discovering a new key from the artifact.
 *
 * NO persistent trust store, policy update endpoint, snapshot replay ledger,
 * durable import approval or destination SQL writer exists in this helper.
 */
export function verifyPortableSourceAgainstPinnedPolicy(input: {
  policy: TrustedPortableSourcePolicy;
  structure: unknown;
  permissions: unknown;
  attestation: unknown;
  now?: number;
}) {
  try {
    const policy: unknown = input.policy;
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) ||
        !exactKeys(policy, ['sourceOrigin', 'sourceServerId', 'keys'])) deny();
    const p = policy as TrustedPortableSourcePolicy;
    if (!isCanonicalPortableSourceOrigin(p.sourceOrigin) ||
        typeof p.sourceServerId !== 'string' ||
        p.sourceServerId.length === 0 || p.sourceServerId.length > 256 ||
        !Array.isArray(p.keys) || p.keys.length < 1 || p.keys.length > MAX_KEYS) deny();

    const a: unknown = input.attestation;
    if (!a || typeof a !== 'object' || Array.isArray(a)) deny();
    const proof = a as Record<string, unknown>;
    if (proof.sourceOrigin !== p.sourceOrigin ||
        proof.sourceServerId !== p.sourceServerId ||
        typeof proof.keyFingerprint !== 'string' || !HEX.test(proof.keyFingerprint)) deny();
    const issued = canonicalUtcTime(proof.issuedAt);
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) deny();
    const claimed = Buffer.from(proof.keyFingerprint, 'hex');

    let selectedPem: string | null = null;
    const fingerprints = new Set<string>();
    for (const pin of p.keys) {
      if (!pin || typeof pin !== 'object' || Array.isArray(pin) ||
          !exactKeys(pin, ['publicKeyPem', 'keyFingerprint', 'activatedAt', 'retiresAt', 'revoked']) ||
          typeof pin.keyFingerprint !== 'string' || !HEX.test(pin.keyFingerprint) ||
          typeof pin.revoked !== 'boolean' ||
          (pin.retiresAt !== null && typeof pin.retiresAt !== 'string')) deny();
      const der = pinnedKeyDer(pin.publicKeyPem);
      const fingerprint = createHash('sha256').update(der).digest();
      const claimedPin = Buffer.from(pin.keyFingerprint, 'hex');
      if (!timingSafeEqual(fingerprint, claimedPin) || fingerprints.has(pin.keyFingerprint)) deny();
      fingerprints.add(pin.keyFingerprint);
      const activates = canonicalUtcTime(pin.activatedAt);
      const retires = pin.retiresAt === null ? null : canonicalUtcTime(pin.retiresAt);
      if (retires !== null && retires <= activates) deny();

      if (timingSafeEqual(claimed, fingerprint)) {
        if (selectedPem !== null || pin.revoked || issued < activates || now < activates ||
            (retires !== null && (issued >= retires || now >= retires))) deny();
        selectedPem = pin.publicKeyPem;
      }
    }
    if (selectedPem === null) deny();

    const proofResult = verifyPortableSourceAttestation({
      structure: input.structure,
      permissions: input.permissions,
      attestation: input.attestation,
      trustedSourcePublicKeyPem: selectedPem,
      expectedSourceOrigin: p.sourceOrigin,
      now,
    });
    return {
      ...proofResult,
      operatorPinVerified: true as const,
      sourceTrustPolicy: 'operator-pinned-offline-v1' as const,
      importSupported: false as const,
      writesPerformed: false as const,
      mappingApproved: false as const,
      replayPreventionImplemented: false as const,
    };
  } catch {
    return deny(); // one generic failure, no invalid-key or signature oracle
  }
}
