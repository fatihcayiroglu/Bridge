import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import {
  portableSourceAttestationSigningBytes,
  type PortableSourceAttestation,
} from '../lib/portableSourceAttestation';
import {
  verifyPortableSourceAgainstPinnedPolicy,
  PortableSourceTrustPolicyError,
  type TrustedPortableSourcePolicy,
  type PinnedSourceKey,
} from '../lib/portableSourceTrustPolicy';

const ORIGIN = 'https://source.bridge.example';
const SOURCE = 'source-community-identity';
const NOW = Date.parse('2026-10-13T08:00:00.000Z');
function iso(ms: number) { return new Date(ms).toISOString(); }
function signedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyFingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const server = { _id: SOURCE, name: 'Source' };
  const channels = [{ _id: 'channel', serverId: SOURCE, name: 'lobby', type: 'text', order: 0 }];
  const roles = [{ _id: 'role', serverId: SOURCE, name: 'Readers', permissions: 1, position: 0 }];
  const structure = buildPortableCommunityStructure(server, [], channels, roles, iso(NOW - 60_000));
  const permissions = buildPortableCommunityPermissionManifest(server, channels, roles,
    [{ channelId: 'channel', canonical: [], legacy: [] }], iso(NOW - 60_000));
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation', version: 1,
    sourceOrigin: ORIGIN, sourceServerId: SOURCE,
    snapshotId: 'snapshot-random-token-at-least-16',
    structureDigest: structure.integrity.digest, permissionsDigest: permissions.integrity.digest,
    issuedAt: iso(NOW - 60_000), expiresAt: iso(NOW + 60_000), keyFingerprint,
  };
  const attestation: PortableSourceAttestation = {
    ...fields,
    signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey).toString('base64url'),
  };
  const pin: PinnedSourceKey = {
    publicKeyPem, keyFingerprint, activatedAt: iso(NOW - 300_000),
    retiresAt: null, revoked: false,
  };
  const policy: TrustedPortableSourcePolicy = { sourceOrigin: ORIGIN, sourceServerId: SOURCE, keys: [pin] };
  return { structure, permissions, attestation, policy, pin };
}
function verify(f: ReturnType<typeof signedFixture>, change: Record<string, unknown> = {}) {
  return verifyPortableSourceAgainstPinnedPolicy({
    policy: f.policy, structure: f.structure, permissions: f.permissions,
    attestation: f.attestation, now: NOW, ...change,
  });
}

describe('P7 C4 independently provisioned source key policy (NO import)', () => {
  it('validates matching key and community pins, and explicitly does not approve any write', () => {
    const f = signedFixture();
    const result = verify(f);
    expect(result).toMatchObject({
      sourceSignatureValid: true, operatorPinVerified: true,
      sourceTrustPolicy: 'operator-pinned-offline-v1',
      importSupported: false, writesPerformed: false, mappingApproved: false,
      replayPreventionImplemented: false, snapshotAtomicityVerified: false,
      sourceServerId: SOURCE, trustedSourceOrigin: ORIGIN,
    });
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(result)).not.toContain('publicKeyPem');
  });

  it('accepts two independently pinned active keys during explicit rotation overlap', () => {
    const prior = signedFixture();
    const replacement = signedFixture();
    const policy: TrustedPortableSourcePolicy = {
      sourceOrigin: ORIGIN, sourceServerId: SOURCE,
      keys: [prior.pin, replacement.pin],
    };
    expect(verify(prior, { policy }).operatorPinVerified).toBe(true);
    expect(verify(replacement, { policy }).operatorPinVerified).toBe(true);
  });

  it('rejects old proofs after emergency revocation or scheduled retirement', () => {
    const f = signedFixture();
    const revoked = { ...f.policy, keys: [{ ...f.pin, revoked: true }] };
    expect(() => verify(f, { policy: revoked })).toThrow(PortableSourceTrustPolicyError);
    const retiring = { ...f.policy, keys: [{ ...f.pin, retiresAt: iso(NOW - 1) }] };
    expect(() => verify(f, { policy: retiring })).toThrow(PortableSourceTrustPolicyError);
    const notYetActivated = { ...f.policy, keys: [{ ...f.pin, activatedAt: iso(NOW - 30_000) }] };
    expect(() => verify(f, { policy: notYetActivated })).toThrow(PortableSourceTrustPolicyError);
  });

  it('refuses source or origin switching even with valid signatures from the pinned key', () => {
    const f = signedFixture();
    expect(() => verify(f, { policy: { ...f.policy, sourceServerId: 'other-community' } }))
      .toThrow(PortableSourceTrustPolicyError);
    expect(() => verify(f, { policy: { ...f.policy, sourceOrigin: 'https://other.bridge.example' } }))
      .toThrow(PortableSourceTrustPolicyError);
    const attacker = signedFixture();
    expect(() => verify(attacker, { policy: f.policy })).toThrow(PortableSourceTrustPolicyError);
    expect(() => verify(f, { attestation: { ...f.attestation, sourceOrigin: 'https://evil.example' } }))
      .toThrow(PortableSourceTrustPolicyError);
  });

  it('rejects invalid dormant pins and duplicate fingerprints rather than ignoring policy corruption', () => {
    const f = signedFixture();
    const dup = { ...f.policy, keys: [f.pin, { ...f.pin }] };
    expect(() => verify(f, { policy: dup })).toThrow(PortableSourceTrustPolicyError);
    const invalid = [
      { ...f.pin, keyFingerprint: '0'.repeat(64) },
      { ...f.pin, publicKeyPem: f.pin.publicKeyPem + 'injected text' },
      { ...f.pin, publicKeyPem: 'not a real key' },
      { ...f.pin, activatedAt: 'not-a-date' },
      { ...f.pin, retiresAt: iso(NOW - 600_000) },
      { ...f.pin, revoked: 'false' },
      { ...f.pin, leakedMetadata: 'unexpected' },
    ];
    for (const pin of invalid) {
      const policy = { ...f.policy, keys: [f.pin, pin] };
      expect(() => verify(f, { policy })).toThrow(PortableSourceTrustPolicyError);
    }
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const rsaPem = rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(() => verify(f, { policy: { ...f.policy, keys: [f.pin, {
      ...f.pin, publicKeyPem: rsaPem, keyFingerprint: createHash('sha256')
        .update(rsa.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    }] } })).toThrow(PortableSourceTrustPolicyError);
  });

  it('rejects unexpected or malformed trust configuration without any trust-on-first-use fallback', () => {
    const f = signedFixture();
    for (const policy of [
      null, {}, { ...f.policy, keys: [] },
      { ...f.policy, keys: Array.from({ length: 17 }, () => f.pin) },
      { ...f.policy, sourceOrigin: 'http://source.bridge.example' },
      { ...f.policy, keys: [f.pin], trustedFromArtifact: true },
      { ...f.policy, keys: 'untrusted public key' },
    ]) {
      expect(() => verify(f, { policy })).toThrow(PortableSourceTrustPolicyError);
    }
  });

  it('rejects altered signed manifest, forged signature or bad current time without issuing detailed errors', () => {
    const f = signedFixture();
    const tampered = structuredClone(f.structure);
    tampered.channels[0].name = 'modified';
    for (const overrides of [
      { structure: tampered },
      { attestation: { ...f.attestation, signature: 'A'.repeat(86) } },
      { now: Number.NaN },
      { now: NOW + 60_001 },
    ]) {
      expect(() => verify(f, overrides)).toThrow(PortableSourceTrustPolicyError);
    }
  });
});
