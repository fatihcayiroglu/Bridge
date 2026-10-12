import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  parsePinnedPortableSourceRegistry, verifyAttestationAgainstPinnedRegistry,
} from '../lib/portableSourceKeyring';
import {
  portableSourceAttestationSigningBytes, PortableSourceAttestationError,
  type PortableSourceAttestation,
} from '../lib/portableSourceAttestation';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';

const ORIGIN = 'https://source.bridge.example';
const OTHER = 'https://other.bridge.example';
const NOW = Date.parse('2026-10-13T10:00:00.000Z');
const earlier = new Date(NOW - 2 * 3600_000).toISOString();
const later = new Date(NOW + 2 * 3600_000).toISOString();

function generateSigner() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { publicKeyPem, fingerprint, privateKey };
}
type Signer = ReturnType<typeof generateSigner>;
function signed(signer: Signer, origin = ORIGIN, sourceServerId = 'source-server', name = 'Community') {
  const server = { _id: sourceServerId, name };
  const categories = [{ _id: 'cat-1', name: 'General', position: 0 }];
  const channels = [{ _id: 'chan-1', serverId: sourceServerId, name: 'welcome',
    type: 'text', categoryId: 'cat-1', order: 0 }];
  const roles = [{ _id: 'role-1', serverId: sourceServerId, name: 'Member',
    position: 0, permissions: 1 }];
  const at = new Date(NOW - 60_000).toISOString();
  const structure = buildPortableCommunityStructure(server, categories, channels, roles, at);
  const permissions = buildPortableCommunityPermissionManifest(server, channels, roles,
    [{ channelId: 'chan-1', canonical: [], legacy: [] }], at);
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation', version: 1,
    sourceOrigin: origin, sourceServerId: server._id,
    snapshotId: 'pinned-source-snapshot-id-32chars',
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    issuedAt: at, expiresAt: new Date(NOW + 60_000).toISOString(),
    keyFingerprint: signer.fingerprint,
  };
  const attestation = {
    ...fields,
    signature: sign(null, portableSourceAttestationSigningBytes(fields), signer.privateKey)
      .toString('base64url'),
  };
  return { structure, permissions, attestation };
}
function key(signer: Signer, update: Record<string, unknown> = {}) {
  return {
    sourceOrigin: ORIGIN, publicKeyPem: signer.publicKeyPem,
    activeFrom: earlier, activeUntil: later, revoked: false, ...update,
  };
}
function registry(keys: unknown[]) {
  return JSON.stringify({ format: 'bridge-portable-source-trust-registry', version: 1, keys });
}
function prove(fixture: ReturnType<typeof signed>, registryJson: string,
  overrides: Record<string, unknown> = {}) {
  return verifyAttestationAgainstPinnedRegistry({
    ...fixture,
    operatorRegistryJson: registryJson,
    expectedSourceOrigin: ORIGIN,
    expectedSourceServerId: 'source-server',
    now: NOW,
    ...overrides,
  });
}

describe('P7 destination-pinned key registry: offline source verification only', () => {
  it('verifies a signed manifest pair only with independently pinned Ed25519 identity', () => {
    const original = generateSigner();
    const f = signed(original);
    const trust = registry([key(original)]);
    expect(prove(f, trust)).toMatchObject({
      mode: 'read-only', sourceSignatureValid: true,
      trustPolicy: 'operator-pinned-revocable-v1',
      sourceServerId: 'source-server',
      trustedSourceOrigin: ORIGIN,
      importSupported: false, writesPerformed: false, mappingApproved: false,
      snapshotAtomicityVerified: false,
    });
    expect(JSON.stringify(prove(f, trust))).not.toContain(original.publicKeyPem);
  });

  it('permits explicit overlap rotation and instantly refuses revoked old signatures', () => {
    const oldSigner = generateSigner();
    const newSigner = generateSigner();
    const oldProof = signed(oldSigner);
    const newProof = signed(newSigner);
    const overlap = registry([key(oldSigner), key(newSigner)]);
    expect(prove(oldProof, overlap).sourceSignatureValid).toBe(true);
    expect(prove(newProof, overlap).sourceSignatureValid).toBe(true);

    // A retired key remains listed for audit; revocation means NO acceptance,
    // even for a proof issued before the revocation happened.
    const rotated = registry([key(oldSigner, { revoked: true }), key(newSigner)]);
    expect(() => prove(oldProof, rotated)).toThrow(PortableSourceAttestationError);
    expect(prove(newProof, rotated).sourceSignatureValid).toBe(true);
  });

  it('refuses unpinned signers, source-origin confusion and tampering despite valid self-checksums', () => {
    const signer = generateSigner();
    const attacker = generateSigner();
    const authentic = signed(signer);
    const trust = registry([key(signer)]);
    expect(() => prove(signed(attacker), trust)).toThrow(PortableSourceAttestationError);
    expect(() => prove(authentic, registry([key(attacker)])))
      .toThrow(PortableSourceAttestationError);
    expect(() => prove(authentic, trust, { expectedSourceOrigin: OTHER }))
      .toThrow(PortableSourceAttestationError);
    expect(() => prove(authentic, trust, { expectedSourceServerId: 'other-community' }))
      .toThrow(PortableSourceAttestationError);
    // Distinct community signed by the SAME legitimately pinned source key:
    // the cryptographic signature is authentic, but the destination selected
    // a different community and must fail closed BEFORE treating it as usable.
    const signedOtherCommunity = signed(signer, ORIGIN, 'other-community');
    expect(() => prove(signedOtherCommunity, trust))
      .toThrow(PortableSourceAttestationError);
    expect(() => prove(authentic, trust, { expectedSourceServerId: '' }))
      .toThrow(PortableSourceAttestationError);
    // An operator pins both the source origin AND the expected community.
    // An otherwise signed document cannot silently switch identities.
    expect(() => prove(authentic, trust, { attestation: {
      ...authentic.attestation, sourceServerId: 'other-community',
    } })).toThrow(PortableSourceAttestationError);

    expect(() => prove(authentic, registry([key(signer, { sourceOrigin: OTHER })])))
      .toThrow(PortableSourceAttestationError);
    // A second valid signed fixture with IDENTICAL manifest bytes isn't
    // tampering: the authentic signature remains valid for those bytes.
    // Make the source topology genuinely different, recompute its own
    // checksums, then attach the original attestation: digests MUST disagree.
    const tampered = signed(attacker, ORIGIN, 'source-server', 'Malicious replacement community');
    expect(tampered.structure.integrity.digest).not.toBe(authentic.structure.integrity.digest);
    expect(() => prove({ ...tampered, attestation: authentic.attestation }, trust))
      .toThrow(PortableSourceAttestationError);
  });

  it('blocks signatures outside authorized key activation and end-of-life windows', () => {
    const signer = generateSigner();
    const f = signed(signer);
    expect(() => prove(f, registry([key(signer, {
      activeFrom: new Date(NOW - 30_000).toISOString(),
    })]))).toThrow(PortableSourceAttestationError);
    expect(() => prove(f, registry([key(signer, {
      activeUntil: new Date(NOW).toISOString(),
    })]))).toThrow(PortableSourceAttestationError);
    expect(() => prove(f, registry([key(signer, { revoked: true })])))
      .toThrow(PortableSourceAttestationError);
  });

  it('rejects noncanonical, duplicate, foreign, malformed and oversized registry policy', () => {
    const signer = generateSigner();
    const normal = key(signer);
    const rsaKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const invalidEntries = [
      [], [normal, normal], [key(signer, { sourceOrigin: 'http://source.bridge.example' })],
      [key(signer, { activeFrom: later, activeUntil: earlier })],
      [key(signer, { activeFrom: 'invalid' })],
      [key(signer, { revoked: 'false' })],
      [key(signer, { publicKeyPem: rsaKey })],
      [key(signer, { publicKeyPem: signer.publicKeyPem + 'untrusted appended bytes' })],
      [key(signer, { privateKeyPem: 'must-not-be-here' })],
      Array.from({ length: 33 }, () => normal),
    ];
    for (const entries of invalidEntries) {
      expect(() => parsePinnedPortableSourceRegistry(registry(entries)))
        .toThrow(PortableSourceAttestationError);
    }
    expect(() => parsePinnedPortableSourceRegistry(JSON.stringify({
      format: 'bridge-portable-source-trust-registry', version: 1,
      keys: [normal], role: 'administrator',
    }))).toThrow(PortableSourceAttestationError);
    expect(() => parsePinnedPortableSourceRegistry(registry([normal]).repeat(3500)))
      .toThrow(PortableSourceAttestationError);
    expect(() => parsePinnedPortableSourceRegistry('{broken-json'))
      .toThrow(PortableSourceAttestationError);
  });

  it('always rejects invalid proofs with one generic error and no data leaks', () => {
    const signer = generateSigner();
    const f = signed(signer);
    try {
      prove(f, registry([key(signer, { revoked: true })]));
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PortableSourceAttestationError);
      expect(String(err)).not.toContain(signer.publicKeyPem);
      expect(JSON.stringify(err)).not.toContain('source-server');
    }
  });
});
