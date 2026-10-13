import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';
import { portableSourceAttestationSigningBytes, type PortableSourceAttestation } from '../lib/portableSourceAttestation';
import { inspectLockedPortableImportReview, LockedPortableReviewError } from '../lib/portableLockedImportReview';

const SID = 'target';
const SOURCE = 'source';
const ORIGIN = 'https://locked-source.example';
const NOW = Date.parse('2026-10-13T12:00:00.000Z');
const AT = new Date(NOW - 60_000).toISOString();

function fixture(options: {
  ownerMissing?: boolean; isolation?: string; readonly?: string;
  targetRoleMask?: number; grantAllow?: number; legacy?: boolean;
  movedTarget?: boolean;
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const keyFingerprint = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  const sourceServer = { _id: SOURCE, name: 'Source' };
  const sourceCats = [{ _id: 'scat', serverId: SOURCE, name: 'General', position: 0, collapsed: false }];
  const sourceRoles = [{ _id: 'sr', serverId: SOURCE, name: 'Readers', color: '#99aab5', position: 0, permissions: 1 }];
  const sourceChannels = [{ _id: 'sch', serverId: SOURCE, name: 'welcome', type: 'text',
    categoryId: 'scat', category: 'GENERAL', topic: '', order: 0, nsfw: false, slowmode: 0 }];
  const structure = buildPortableCommunityStructure(sourceServer, sourceCats, sourceChannels, sourceRoles, AT);
  const permissions = buildPortableCommunityPermissionManifest(sourceServer, sourceChannels, sourceRoles, [{
    channelId: 'sch', legacy: [], canonical: [
      { channelId: 'sch', serverId: SOURCE, roleId: 'sr', allow: 1, deny: 0 },
    ],
  }], AT);
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation', version: 1,
    sourceOrigin: ORIGIN, sourceServerId: SOURCE, snapshotId: 'locked-target-snapshot-123456',
    structureDigest: structure.integrity.digest, permissionsDigest: permissions.integrity.digest,
    issuedAt: AT, expiresAt: new Date(NOW + 120_000).toISOString(), keyFingerprint,
  };
  const attestation = {
    ...fields, signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey).toString('base64url'),
  };
  const operatorRegistryJson = JSON.stringify({
    format: 'bridge-portable-source-trust-registry', version: 1,
    keys: [{ sourceOrigin: ORIGIN, publicKeyPem,
      activeFrom: new Date(NOW - 3600_000).toISOString(),
      activeUntil: new Date(NOW + 3600_000).toISOString(), revoked: false }],
  });
  const categories = [{ _id: 'tc', serverId: SID, name: 'General', position: 0, collapsed: false }];
  const roles = [{ _id: 'tr', serverId: SID, name: 'Readers',
    color: '#99aab5', position: 0, permissions: options.targetRoleMask ?? 1 }];
  const channels = [{ _id: 'tch', serverId: SID, name: 'welcome', type: 'text',
    topic: options.movedTarget ? 'edited' : '', categoryId: 'tc', category: 'GENERAL',
    order: '0', nsfw: 0, slowmode: 0 }];
  const initialDestination = { serverId: SID, categories, roles,
    channels: channels.map(c => ({ ...c, order: 0, nsfw: false })) };
  const mapping = {
    targetServerId: SID,
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    expectedTargetDigest: fingerprintDestinationTopology({
      ...initialDestination, channels: initialDestination.channels.map(c => ({ ...c, topic: '' })),
    }),
    categories: [{ sourceId: 'scat', targetId: 'tc' }],
    roles: [{ sourceId: 'sr', targetId: 'tr' }],
    channels: [{ sourceId: 'sch', targetId: 'tch' }],
  };
  const grants = [{ channelId: 'tch', serverId: SID, roleId: 'tr', allow: options.grantAllow ?? 1, deny: 0 }];
  const queries: string[] = [];
  const client = { async query(sql: string) {
    queries.push(sql);
    if (sql.includes('transaction_isolation')) return { rows: [{
      isolation: options.isolation ?? 'serializable', readonly: options.readonly ?? 'off',
    }] };
    if (sql.includes('FROM servers')) return { rows: options.ownerMissing ? [] : [{ _id: SID }] };
    if (sql.includes('FROM channel_categories')) return { rows: categories };
    if (sql.includes('FROM roles')) return { rows: roles };
    if (sql.includes('FROM channels')) return { rows: channels };
    if (sql.includes('FROM channel_overrides')) return { rows: options.legacy ? [{ present: true }] : [] };
    if (sql.includes('FROM channel_permissions')) return { rows: grants };
    throw Error('Unexpected query');
  }};
  return {
    client, queries, targetServerId: SID, ownerId: 'owner',
    structure, permissions, attestation, expectedSourceOrigin: ORIGIN,
    expectedSourceServerId: SOURCE, operatorRegistryJson, mapping, now: NOW,
  };
}

describe('P7 locked signed source + destination grant review', () => {
  it('reviews source, topology and current grants on exactly the supplied SQL session', async () => {
    const f = fixture();
    const result = await inspectLockedPortableImportReview(f);
    expect(result).toMatchObject({
      mode: 'transaction-check-only', checkedChannels: 1, checkedGrants: 1,
      consentSupported: false, consentIssued: false, importSupported: false,
      writesPerformed: false,
    });
    expect(result.verifiedReviewFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.targetTopologyDigest).toBe(f.mapping.expectedTargetDigest);
    expect(result.targetGrantDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(f.queries.filter(x => x.includes('transaction_isolation'))).toHaveLength(2);
    expect(f.queries.filter(x => x.includes('FOR SHARE'))).toHaveLength(6);
    expect(f.queries.some(x => x.includes('FOR UPDATE'))).toBe(true);
    expect(result).not.toHaveProperty('approvalToken');
    expect(JSON.stringify(result)).not.toContain(f.operatorRegistryJson);
  });

  it.each([
    { isolation: 'read committed' },
    { isolation: 'repeatable read' },
    { readonly: 'on' },
    { ownerMissing: true },
    { movedTarget: true },
    { targetRoleMask: 3 },
    { grantAllow: 2 },
    { legacy: true },
  ])('fails closed for stale, widened or unsafe target %#', async options => {
    await expect(inspectLockedPortableImportReview(fixture(options)))
      .rejects.toBeInstanceOf(LockedPortableReviewError);
  });

  it('rejects forged source signature and revoked operator signer', async () => {
    const f = fixture();
    await expect(inspectLockedPortableImportReview({ ...f,
      attestation: { ...f.attestation, signature: 'corrupted' },
    })).rejects.toBeInstanceOf(LockedPortableReviewError);
    const revoked = JSON.parse(f.operatorRegistryJson);
    revoked.keys[0].revoked = true;
    await expect(inspectLockedPortableImportReview({ ...f,
      operatorRegistryJson: JSON.stringify(revoked),
    })).rejects.toBeInstanceOf(LockedPortableReviewError);
  });
});
