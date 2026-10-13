import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { portableSourceAttestationSigningBytes, type PortableSourceAttestation } from '../lib/portableSourceAttestation';
import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import { PERMS } from '../lib/permissions';
import { inspectStaticPortableImportConsentPolicy } from '../lib/portableImportConsentStaticPolicy';

const SID = 'target';
const SOURCE = 'source';
const ORIGIN = 'https://pinned-export.example';
const NOW = Date.parse('2026-10-13T11:00:00.000Z');
const AT = new Date(NOW - 60_000).toISOString();

function fixture(opts: {
  sourceMask?: number;
  targetMask?: number;
  channelAllow?: number;
  channelDeny?: number;
  legacy?: boolean;
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const keyFingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const server = { _id: SOURCE, name: 'Source' };
  const categories = [{ _id: 'source-category', serverId: SOURCE, name: 'General', position: 0 }];
  const roles = [{ _id: 'source-role', serverId: SOURCE, name: 'Readers', permissions: opts.sourceMask ?? 1, position: 0 }];
  const channels = [{ _id: 'source-channel', serverId: SOURCE, name: 'welcome', type: 'text',
    categoryId: 'source-category', order: 0 }];
  const structure = buildPortableCommunityStructure(server, categories, channels, roles, AT);
  const permissions = buildPortableCommunityPermissionManifest(server, channels, roles, [{
    channelId: 'source-channel',
    canonical: opts.channelAllow === undefined && opts.channelDeny === undefined ? [] :
      [{ channelId: 'source-channel', serverId: SOURCE, roleId: 'source-role',
        allow: opts.channelAllow ?? 0, deny: opts.channelDeny ?? 0 }],
    legacy: opts.legacy ? [{ channelId: 'source-channel', userId: 'excluded' }] : [],
  }], AT);
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation',
    version: 1,
    sourceOrigin: ORIGIN,
    sourceServerId: SOURCE,
    snapshotId: 'consent-static-snapshot-123456',
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    issuedAt: AT,
    expiresAt: new Date(NOW + 120_000).toISOString(),
    keyFingerprint,
  };
  const attestation = {
    ...fields, signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey).toString('base64url'),
  };
  const operatorRegistryJson = JSON.stringify({
    format: 'bridge-portable-source-trust-registry', version: 1,
    keys: [{ sourceOrigin: ORIGIN, publicKeyPem: pem,
      activeFrom: new Date(NOW - 3600_000).toISOString(),
      activeUntil: new Date(NOW + 3600_000).toISOString(), revoked: false }],
  });
  const destination = {
    serverId: SID,
    categories: [{ _id: 'target-category', serverId: SID, name: 'General', position: 0 }],
    roles: [{ _id: 'target-role', serverId: SID, name: 'Readers', permissions: opts.targetMask ?? 1, position: 0 }],
    channels: [{ _id: 'target-channel', serverId: SID, name: 'welcome', type: 'text' }],
  };
  const mapping = {
    targetServerId: SID, structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    expectedTargetDigest: fingerprintDestinationTopology(destination),
    categories: [{ sourceId: 'source-category', targetId: 'target-category' }],
    roles: [{ sourceId: 'source-role', targetId: 'target-role' }],
    channels: [{ sourceId: 'source-channel', targetId: 'target-channel' }],
  };
  return { structure, permissions, attestation, expectedSourceOrigin: ORIGIN,
    expectedSourceServerId: SOURCE, operatorRegistryJson, destination, mapping, now: NOW };
}

describe('P7 C4 signed consent STATIC policy is not an authorization', () => {
  it('accepts only conservative static evidence; no consent, token, DB lock or import capability', () => {
    const f = fixture();
    const result = inspectStaticPortableImportConsentPolicy(f);
    expect(result).toMatchObject({
      mode: 'read-only', staticChecksPassed: true, reasons: [],
      consentSupported: false, consentIssued: false, writesPerformed: false,
      importSupported: false, liveTargetPermissionGrantsVerified: false,
      destinationRevisionLocked: false, approvalReusable: false,
    });
    expect(result.verifiedReviewFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.targetTopologyDigest).toBe(f.mapping.expectedTargetDigest);
    expect(result).not.toHaveProperty('approvalToken');
    expect(JSON.stringify(result)).not.toContain(f.operatorRegistryJson);
    expect(inspectStaticPortableImportConsentPolicy(f).verifiedReviewFingerprint)
      .toBe(result.verifiedReviewFingerprint);
  });

  it('rejects permission widening with a fully valid pinned source signature', () => {
    const result = inspectStaticPortableImportConsentPolicy(fixture({ targetMask: 3 }));
    expect(result.staticChecksPassed).toBe(false);
    expect(result.reasons).toContain('ROLE_PRIVILEGE_WIDENING');
    expect(result.reasons).toContain('MAPPING_REVIEW_BLOCKED');
    expect(result.consentIssued).toBe(false);
  });

  it.each([PERMS.MANAGE_ROLES, PERMS.ADMINISTRATOR])(
    'rejects source role privileged bit 0x%s even if destination mask matches', (bit) => {
      const result = inspectStaticPortableImportConsentPolicy(fixture({
        sourceMask: 1 | bit, targetMask: 1 | bit,
      }));
      expect(result.reasons).toContain('SOURCE_PRIVILEGED_ROLE_BITS');
      expect(result.staticChecksPassed).toBe(false);
    },
  );

  it.each([PERMS.MANAGE_ROLES, PERMS.ADMINISTRATOR])(
    'rejects allow and deny privileged channel overrides for bit %s', bit => {
      for (const options of [{ channelAllow: bit }, { channelDeny: bit }]) {
        const result = inspectStaticPortableImportConsentPolicy(fixture(options));
        expect(result.staticChecksPassed).toBe(false);
        expect(result.reasons).toContain('SOURCE_PRIVILEGED_CHANNEL_GRANTS');
      }
    },
  );

  it('rejects omitted legacy/user grants instead of silently importing a subset', () => {
    const result = inspectStaticPortableImportConsentPolicy(fixture({ legacy: true }));
    expect(result.staticChecksPassed).toBe(false);
    expect(result.reasons).toContain('UNSUPPORTED_SOURCE_GRANTS');
    expect(result.reasons).toContain('MAPPING_REVIEW_BLOCKED');
  });

  it('fails closed for revoked source key, forged signature and changed destination digest', () => {
    const f = fixture();
    const revoked = JSON.parse(f.operatorRegistryJson);
    revoked.keys[0].revoked = true;
    const variants = [
      { ...f, operatorRegistryJson: JSON.stringify(revoked) },
      { ...f, attestation: { ...f.attestation, signature: 'tampered' } },
      { ...f, destination: { ...f.destination,
        channels: [{ ...f.destination.channels[0], topic: 'changed' }] } },
      { ...f, mapping: { ...f.mapping, roles: [] } },
    ];
    for (const attempt of variants) {
      const r = inspectStaticPortableImportConsentPolicy(attempt);
      expect(r).toMatchObject({
        staticChecksPassed: false,
        reasons: ['MAPPING_REVIEW_UNVERIFIED'],
        verifiedReviewFingerprint: null,
        targetTopologyDigest: null,
        consentIssued: false, importSupported: false,
      });
    }
  });
});
