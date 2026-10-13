// P7 C4: owner-only read-only source proof endpoint. No import/apply path.
process.env.JWT_SECRET = 'source-attestation-review-jwt-32chars';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../lib/portableDestinationTrustConfig', () => ({
  readDestinationPinnedSourceRegistry: jest.fn(),
}));
jest.mock('../lib/portableSourceKeyring', () => ({
  verifyAttestationAgainstPinnedRegistry: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { readDestinationPinnedSourceRegistry } from '../lib/portableDestinationTrustConfig';
import { verifyAttestationAgainstPinnedRegistry } from '../lib/portableSourceKeyring';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const config = readDestinationPinnedSourceRegistry as jest.Mock;
const verify = verifyAttestationAgainstPinnedRegistry as jest.Mock;
const SID = 'destination', OWNER = 'owner', MEMBER = 'member';
const ORIGIN = 'https://operator-pinned-source.example';
const SOURCE = 'expected-source-community';
const jwtToken = (user: string) => jwt.sign({ id: user, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
const body = () => ({
  structure: { structureManifest: 'signed structure' },
  permissions: { permissionManifest: 'signed permissions' },
  attestation: { sourceOrigin: ORIGIN, sourceServerId: SOURCE, signature: 'attested' },
  expectedSourceOrigin: ORIGIN,
  expectedSourceServerId: SOURCE,
});
function review(user: string | null, payload: unknown = body(),
  scope: 'account-security' | 'sensitive-export' | null = null) {
  let q = request(app()).post(`/api/servers/${SID}/portable-import/source-attestation-review`)
    .set('Host', 'untrusted-attacker.example');
  if (user) q = q.set('Authorization', `Bearer ${jwtToken(user)}`);
  if (scope && user) q = q.set(stepUpHeader(user, scope));
  return q.send(payload);
}
async function snapshot() {
  return {
    servers: await db.servers.find({}),
    channels: await db.channels.find({}),
    categories: await db.channelCategories.find({}),
    roles: await db.roles.find({}),
    permissions: await db.channelPermissions.find({}),
    members: await db.members.find({}),
  };
}

beforeEach(async () => {
  db._reset();
  config.mockReset();
  verify.mockReset();
  for (const id of [OWNER, MEMBER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, ownerId: OWNER, name: 'Destination' });
  await db.members.insert({ _id: 'destination-member', serverId: SID, userId: MEMBER });
  config.mockReturnValue('operator-private-pinned-registry-test');
  verify.mockReturnValue({
    mode: 'read-only', sourceSignatureValid: true,
    sourceServerId: SOURCE, trustedSourceOrigin: ORIGIN,
    trustPolicy: 'operator-pinned-revocable-v1',
    importSupported: false, writesPerformed: false,
    mappingApproved: false, snapshotAtomicityVerified: false,
    blockers: ['TRANSACTIONAL_IMPORT_NOT_IMPLEMENTED'],
  });
});

describe('P7 C4 owner-only source attestation review is NOT migration authority', () => {
  it('rejects anonymous, missing server, delegated member and missing/wrong step-up before touching registry', async () => {
    expect((await review(null)).status).toBe(401);
    const notFound = await request(app()).post('/api/servers/missing/portable-import/source-attestation-review')
      .set('Authorization', `Bearer ${jwtToken(OWNER)}`)
      .set(stepUpHeader(OWNER, 'account-security')).send(body());
    expect(notFound.status).toBe(404);
    expect((await review(MEMBER, body(), 'account-security')).status).toBe(403);
    const noProof = await review(OWNER);
    expect(noProof.status).toBe(403);
    expect(noProof.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    expect((await review(OWNER, body(), 'sensitive-export')).status).toBe(403);
    expect(config).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });

  it('verifies with operator registry only, never Host or client key, and never writes destination', async () => {
    const before = await snapshot();
    const result = await review(OWNER, body(), 'account-security');
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(result.body).toMatchObject({
      mode: 'read-only', targetServerId: SID, sourceSignatureValid: true,
      mappingApproved: false, importSupported: false, writesPerformed: false,
      targetTopologyBound: false,
    });
    expect(config).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({
      structure: body().structure,
      permissions: body().permissions,
      attestation: body().attestation,
      expectedSourceOrigin: ORIGIN,
      expectedSourceServerId: SOURCE,
      operatorRegistryJson: 'operator-private-pinned-registry-test',
    });
    expect(JSON.stringify(result.body)).not.toContain('operator-private-pinned-registry-test');
    expect(JSON.stringify(result.body)).not.toContain('untrusted-attacker.example');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects client-supplied public keys and extra keys instead of trusting them', async () => {
    const before = await snapshot();
    const withKey = { ...body(), publicKeyPem: 'attacker-key' };
    const bad = await review(OWNER, withKey, 'account-security');
    expect(bad.status).toBe(400);
    const wrongShape = await review(OWNER, { attestation: body().attestation }, 'account-security');
    expect(wrongShape.status).toBe(400);
    expect(config).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it('fails closed if operator registry is disabled or unavailable', async () => {
    config.mockImplementationOnce(() => { throw new Error('untrusted config parse'); });
    const result = await review(OWNER, body(), 'account-security');
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('PORTABLE_SOURCE_TRUST_UNAVAILABLE');
    expect(JSON.stringify(result.body)).not.toContain('untrusted config parse');
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns the same generic failure for mismatched source, revoked signer and corrupt signature', async () => {
    const malformed = ['revoked signer', 'wrong source id', 'tampered digest'];
    for (const reason of malformed) {
      verify.mockImplementationOnce(() => { throw new Error(reason); });
      const result = await review(OWNER, body(), 'account-security');
      expect(result.status).toBe(422);
      expect(result.body.code).toBe('PORTABLE_SOURCE_ATTESTATION_INVALID');
      expect(JSON.stringify(result.body)).not.toContain(reason);
      expect(result.body).not.toHaveProperty('sourceSignatureValid');
    }
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it('rejects source identity or input shape omissions before verification', async () => {
    const missingOrigin = await review(OWNER, {
      ...body(), expectedSourceOrigin: '',
    }, 'account-security');
    expect(missingOrigin.status).toBe(400);
    const missingId = await review(OWNER, {
      ...body(), expectedSourceServerId: '',
    }, 'account-security');
    expect(missingId.status).toBe(400);
    expect(config).not.toHaveBeenCalled();
  });
});
