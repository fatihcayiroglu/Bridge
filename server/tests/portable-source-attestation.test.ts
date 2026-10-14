import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import {
  portableSourceAttestationSigningBytes,
  verifyPortableSourceAttestation,
  isCanonicalPortableSourceOrigin,
  PortableSourceAttestationError,
  type PortableSourceAttestation,
} from '../lib/portableSourceAttestation';

const NOW = Date.parse('2026-10-12T12:00:00.000Z');
const SOURCE = 'source-community-id';
const ORIGIN = 'https://source.bridge.example';
const AT = '2026-10-12T11:55:00.000Z';

function manifestPair(name = 'Old community') {
  const server = { _id: SOURCE, name };
  const categories = [{ _id: 'source-category', name: 'General', position: 0 }];
  const channels = [{
    _id: 'source-channel', serverId: SOURCE, name: 'lobby',
    type: 'text', categoryId: 'source-category', order: 0,
  }];
  const roles = [{ _id: 'source-role', serverId: SOURCE, name: 'Members', position: 0, permissions: 1 }];
  return {
    structure: buildPortableCommunityStructure(server, categories, channels, roles, AT),
    permissions: buildPortableCommunityPermissionManifest(server, channels, roles,
      [{ channelId: 'source-channel', canonical: [], legacy: [] }], AT),
  };
}
function signedProof() {
  const source = manifestPair();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyFingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation',
    version: 1,
    sourceOrigin: ORIGIN,
    sourceServerId: SOURCE,
    snapshotId: 'snapshot-id-at-least-16-chars',
    structureDigest: source.structure.integrity.digest,
    permissionsDigest: source.permissions.integrity.digest,
    issuedAt: new Date(NOW - 60_000).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString(),
    keyFingerprint,
  };
  const signature = sign(null, portableSourceAttestationSigningBytes(fields), privateKey)
    .toString('base64url');
  const attestation: PortableSourceAttestation = { ...fields, signature };
  return { ...source, attestation, publicKeyPem, privateKey };
}
function verifyWith(
  fixture: ReturnType<typeof signedProof>,
  overrides: Record<string, unknown> = {},
) {
  return verifyPortableSourceAttestation({
    structure: fixture.structure,
    permissions: fixture.permissions,
    attestation: fixture.attestation,
    expectedSourceOrigin: ORIGIN,
    trustedSourcePublicKeyPem: fixture.publicKeyPem,
    now: NOW,
    ...overrides,
  });
}

describe('P7 C4 independently pinned source signature proof (NOT an import)', () => {
  it('accepts matching Ed25519 signature over both validated manifests and a pinned key', () => {
    const f = signedProof();
    const result = verifyWith(f);
    expect(result).toMatchObject({
      mode: 'read-only',
      sourceSignatureValid: true,
      importSupported: false,
      writesPerformed: false,
      mappingApproved: false,
      snapshotAtomicityVerified: false,
      trustedSourceOrigin: ORIGIN,
      structureDigest: f.structure.integrity.digest,
      permissionsDigest: f.permissions.integrity.digest,
      blockers: expect.arrayContaining([
        'SOURCE_SNAPSHOT_ATOMICITY_NOT_VERIFIED',
        'DESTINATION_TRANSACTIONAL_IMPORT_NOT_IMPLEMENTED',
      ]),
    });
    expect(JSON.stringify(result)).not.toContain(f.privateKey.export({
      type: 'pkcs8', format: 'pem',
    }).toString());
  });

  it('rejects any attacker-supplied key rather than using the attestation to bootstrap trust', () => {
    const original = signedProof();
    const forged = signedProof();
    expect(() => verifyWith(forged, { trustedSourcePublicKeyPem: original.publicKeyPem }))
      .toThrow(PortableSourceAttestationError);
    expect(() => verifyWith(forged, { expectedSourceOrigin: 'https://other.bridge.example' }))
      .toThrow(PortableSourceAttestationError);
    expect(() => verifyWith(original, { trustedSourcePublicKeyPem: 'not a public key' }))
      .toThrow(PortableSourceAttestationError);
  });

  it('rejects modified source manifests even when the attacker recomputes their self-checksum', () => {
    const f = signedProof();
    const changed = manifestPair('Renamed by attacker');
    expect(() => verifyWith(f, { structure: changed.structure }))
      .toThrow(PortableSourceAttestationError);
    const modified = { ...f.attestation, snapshotId: 'different-snapshot-id-1234567' };
    expect(() => verifyWith(f, { attestation: modified }))
      .toThrow(PortableSourceAttestationError);
    expect(() => verifyWith(f, { permissions: { ...f.permissions, sourceServerId: 'another-community' } }))
      .toThrow(PortableSourceAttestationError);
  });

  it('rejects changes to every signed security field and rejects extra keys', () => {
    const f = signedProof();
    const changes = [
      { keyFingerprint: '0'.repeat(64) },
      { sourceOrigin: 'https://evil.bridge.example' },
      { sourceServerId: 'wrong-source' },
      { permissionsDigest: 'a'.repeat(64) },
      { structureDigest: 'b'.repeat(64) },
      { expiresAt: new Date(NOW + 120_000).toISOString() },
      { snapshotId: 'short' },
      { format: 'bridge-portable-community-structure' },
      { version: 2 },
      { injectedApproval: true },
      { signature: 'A'.repeat(86) },
    ];
    for (const alteration of changes) {
      expect(() => verifyWith(f, { attestation: { ...f.attestation, ...alteration } }))
        .toThrow(PortableSourceAttestationError);
    }
  });

  it('rejects expired, future-dated, excessive-duration and malformed proof times', () => {
    const f = signedProof();
    expect(() => verifyWith(f, { now: NOW + 60_000 }))
      .toThrow(PortableSourceAttestationError);
    expect(() => verifyWith(f, { now: NOW - 10 * 60_000 }))
      .toThrow(PortableSourceAttestationError);
    expect(() => verifyWith(f, { now: NaN }))
      .toThrow(PortableSourceAttestationError);

    for (const invalidDate of ['2026-10-12', 'not-a-date', '2026-13-12T11:59:00.000Z']) {
      expect(() => verifyWith(f, { attestation: { ...f.attestation, issuedAt: invalidDate } }))
        .toThrow(PortableSourceAttestationError);
    }
  });

  it('does not accept noncanonical origins, wrong key types or untrusted envelope metadata', () => {
    const f = signedProof();
    expect(() => verifyWith(f, { expectedSourceOrigin: 'http://source.bridge.example' }))
      .toThrow(PortableSourceAttestationError);
    expect(() => verifyWith(f, { expectedSourceOrigin: 'https://source.bridge.example/path' }))
      .toThrow(PortableSourceAttestationError);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => verifyWith(f, {
      trustedSourcePublicKeyPem: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    })).toThrow(PortableSourceAttestationError);
  });

  it('refuses a second spelling of the same signature (no base64url malleability)', () => {
    const f = signedProof();
    const sig = f.attestation.signature;
    // 86 base64url characters carry 516 bits for a 64-byte signature: the last
    // character's 4 low bits are padding. Flipping one of them spells the SAME
    // bytes differently; only the canonical spelling may verify.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(sig.slice(-1));
    const twin = sig.slice(0, -1) + alphabet[last ^ 1];
    expect(twin).not.toBe(sig);
    expect(Buffer.from(twin, 'base64url').equals(Buffer.from(sig, 'base64url'))).toBe(true);
    expect(verifyWith(f).sourceSignatureValid).toBe(true);
    expect(() => verifyWith(f, { attestation: { ...f.attestation, signature: twin } }))
      .toThrow(PortableSourceAttestationError);
  });

  it('refuses an attestation that is not a plain object', () => {
    const f = signedProof();
    for (const attestation of [null, undefined, 'signed', 42, [f.attestation]]) {
      expect(() => verifyWith(f, { attestation })).toThrow(PortableSourceAttestationError);
    }
  });

  it('accepts only bounded canonical https origins', () => {
    expect(isCanonicalPortableSourceOrigin(ORIGIN)).toBe(true);
    expect(isCanonicalPortableSourceOrigin(`https://${'a'.repeat(497)}.example`)).toBe(false); // > 512 chars
    for (const value of [undefined, null, 42, {}, 'https://', 'https://source.bridge.example:443']) {
      expect(isCanonicalPortableSourceOrigin(value)).toBe(false);
    }
  });
});
