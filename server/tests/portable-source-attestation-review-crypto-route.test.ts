// REAL cryptographic contract across the destination HTTP route, deployment
// keyring, source paired manifests and Ed25519. No verifier mocks.
process.env.JWT_SECRET = 'p7-live-source-verify-jwt-32characters';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import {
  portableSourceAttestationSigningBytes, type PortableSourceAttestation,
} from '../lib/portableSourceAttestation';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const SID = 'destination-real-review';
const OWNER = 'destination-real-owner';
const SOURCE = 'source-from-another-installation';
const ORIGIN = 'https://pinned-source.example';
const oldEnabled = process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED;
const oldRegistry = process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64;
const bearer = jwt.sign({ id: OWNER, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
function signedInput(now: number) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  const exported = new Date(now - 60_000).toISOString();
  const server = { _id: SOURCE, name: 'Source' };
  const categories = [{ _id: 'cat', name: 'General', position: 0 }];
  const channels = [{ _id: 'channel', serverId: SOURCE, name: 'welcome',
    type: 'text', categoryId: 'cat', order: 0 }];
  const roles = [{ _id: 'role', serverId: SOURCE, name: 'Readers',
    permissions: 1, position: 0 }];
  const structure = buildPortableCommunityStructure(server, categories, channels, roles, exported);
  const permissions = buildPortableCommunityPermissionManifest(server, channels, roles,
    [{ channelId: 'channel', canonical: [], legacy: [] }], exported);
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation',
    version: 1, sourceOrigin: ORIGIN, sourceServerId: SOURCE,
    snapshotId: 'real-cryptographic-endpoint-test-snapshot',
    structureDigest: structure.integrity.digest,
    permissionsDigest: permissions.integrity.digest,
    issuedAt: exported,
    expiresAt: new Date(now + 120_000).toISOString(),
    keyFingerprint: fingerprint,
  };
  const attestation = {
    ...fields,
    signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey)
      .toString('base64url'),
  };
  const registryEntry = {
    sourceOrigin: ORIGIN, publicKeyPem,
    activeFrom: new Date(now - 3600_000).toISOString(),
    activeUntil: new Date(now + 3600_000).toISOString(),
    revoked: false,
  };
  return {
    input: { structure, permissions, attestation,
      expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE },
    registryEntry,
  };
}
function setPolicy(key: Record<string, unknown>) {
  const policy = {
    format: 'bridge-portable-source-trust-registry',
    version: 1,
    keys: [key],
  };
  process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED = 'true';
  process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64 =
    Buffer.from(JSON.stringify(policy), 'utf8').toString('base64');
}
function post(data: unknown) {
  return request(app())
    .post(`/api/servers/${SID}/portable-import/source-attestation-review`)
    .set('Host', 'attacker-host.invalid')
    .set('Authorization', `Bearer ${bearer}`)
    .set(stepUpHeader(OWNER, 'account-security')).send(data);
}

beforeEach(async () => {
  db._reset();
  await db.users.insert({ _id: OWNER, username: OWNER, password: 'hash', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, name: 'Destination', ownerId: OWNER });
});
afterAll(() => {
  if (oldEnabled === undefined) delete process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED;
  else process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED = oldEnabled;
  if (oldRegistry === undefined) delete process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64;
  else process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64 = oldRegistry;
});

describe('P7 destination HTTP review genuine source signature and revocation', () => {
  it('authenticates a real signed pair using only independently configured keyring', async () => {
    const f = signedInput(Date.now());
    setPolicy(f.registryEntry);
    const result = await post(f.input);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      mode: 'read-only', sourceSignatureValid: true,
      trustPolicy: 'operator-pinned-revocable-v1',
      sourceServerId: SOURCE, targetServerId: SID,
      importSupported: false, writesPerformed: false, mappingApproved: false,
      targetTopologyBound: false,
    });
    expect(result.headers['cache-control']).toContain('no-store');
    expect(JSON.stringify(result.body)).not.toContain(f.registryEntry.publicKeyPem);
  });

  it('rejects tampered source docs even when recomputed checksums appear valid', async () => {
    const now = Date.now();
    const f = signedInput(now);
    setPolicy(f.registryEntry);
    const replacement = buildPortableCommunityStructure(
      { _id: SOURCE, name: 'Malicious replacement' },
      [{ _id: 'cat', name: 'General', position: 0 }],
      [{ _id: 'channel', serverId: SOURCE, name: 'welcome',
        type: 'text', categoryId: 'cat', order: 0 }],
      [{ _id: 'role', serverId: SOURCE, name: 'Readers', permissions: 1, position: 0 }],
      f.input.structure.exportedAt,
    );
    expect(replacement.integrity.digest).not.toBe(f.input.structure.integrity.digest);
    const res = await post({ ...f.input, structure: replacement });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PORTABLE_SOURCE_ATTESTATION_INVALID');
    expect(res.body).not.toHaveProperty('sourceSignatureValid');
  });

  it('rejects a previously valid signature immediately after operator revokes its key', async () => {
    const f = signedInput(Date.now());
    setPolicy(f.registryEntry);
    const accepted = await post(f.input);
    expect(accepted.status).toBe(200);
    setPolicy({ ...f.registryEntry, revoked: true });
    const revoked = await post(f.input);
    expect(revoked.status).toBe(422);
    expect(revoked.body.code).toBe('PORTABLE_SOURCE_ATTESTATION_INVALID');
  });

  it('does not trust artifact-selected origins or signer material without an independent key', async () => {
    const f = signedInput(Date.now());
    setPolicy(f.registryEntry);
    const forged = await post({
      ...f.input,
      expectedSourceOrigin: 'https://not-the-pinned-source.example',
    });
    expect(forged.status).toBe(422);
    const extra = await post({ ...f.input, publicKeyPem: f.registryEntry.publicKeyPem });
    expect(extra.status).toBe(400);
    process.env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED = 'false';
    const disabled = await post(f.input);
    expect(disabled.status).toBe(503);
  });
});
