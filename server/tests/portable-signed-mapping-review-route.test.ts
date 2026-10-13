// HTTP controls for P7 signed source + explicit target mapping review.
// Crypto/choice digest checks are separately exercised with REAL Ed25519.
process.env.JWT_SECRET = 'signed-mapping-review-owner-test-jwt-32char';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../lib/portableDestinationTrustConfig', () => ({
  readDestinationPinnedSourceRegistry: jest.fn(),
}));
jest.mock('../lib/portableSignedMappingReview', () => ({
  inspectSignedCommunityMappingReview: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { readDestinationPinnedSourceRegistry } from '../lib/portableDestinationTrustConfig';
import { inspectSignedCommunityMappingReview } from '../lib/portableSignedMappingReview';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const config = readDestinationPinnedSourceRegistry as jest.Mock;
const inspect = inspectSignedCommunityMappingReview as jest.Mock;
const SID = 'destination-signed-review';
const OWNER = 'signed-review-owner', MEMBER = 'signed-review-member';
const SOURCE = 'another-installation-community';
const ORIGIN = 'https://pinned-source.example';
const jwtToken = (id: string) =>
  jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const input = () => ({
  structure: { source: SOURCE },
  permissions: { channels: [] },
  attestation: { sourceOrigin: ORIGIN, sourceServerId: SOURCE },
  expectedSourceOrigin: ORIGIN,
  expectedSourceServerId: SOURCE,
  targetServerId: SID,
  mapping: { explicit: true },
});
function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
function post(user: string | null, payload: unknown = input(),
  scope: 'account-security' | 'sensitive-export' | null = null) {
  let q = request(app())
    .post(`/api/servers/${SID}/portable-import/signed-mapping-review`)
    .set('Host', 'attacker-supplied-host.example');
  if (user) q = q.set('Authorization', `Bearer ${jwtToken(user)}`);
  if (scope && user) q = q.set(stepUpHeader(user, scope));
  return q.send(payload);
}
async function snapshot() {
  return {
    servers: await db.servers.find({}),
    members: await db.members.find({}),
    roles: await db.roles.find({}),
    categories: await db.channelCategories.find({}),
    channels: await db.channels.find({}),
    grants: await db.channelPermissions.find({}),
  };
}

beforeEach(async () => {
  db._reset(); config.mockReset(); inspect.mockReset();
  for (const id of [OWNER, MEMBER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, ownerId: OWNER, name: 'Destination' });
  await db.members.insert({ _id: 'member-record', userId: MEMBER, serverId: SID });
  await db.channelCategories.insert({ _id: 'category', serverId: SID, name: 'General', position: 0 });
  await db.roles.insert({ _id: 'role', serverId: SID, name: 'Readers', permissions: 1 });
  await db.channels.insert({ _id: 'channel', serverId: SID, name: 'lobby', type: 'text' });
  config.mockReturnValue('pinned-operator-registry-not-from-request');
  inspect.mockReturnValue({
    mode: 'read-only', sourceSignatureValid: true,
    reviewFingerprint: 'f'.repeat(64), approvalEligible: false,
    mappingApproved: false, importSupported: false, writesPerformed: false,
    targetTopologyBound: true, transactionallyLocked: false,
  });
});

describe('P7 signed+mapped owner review HTTP boundary', () => {
  it('rejects anonymous/delegated and absent or wrong step-up before reading pinned keys', async () => {
    expect((await post(null)).status).toBe(401);
    expect((await post(MEMBER, input(), 'account-security')).status).toBe(403);
    expect((await post(OWNER)).status).toBe(403);
    expect((await post(OWNER, input(), 'sensitive-export')).status).toBe(403);
    const missing = await request(app())
      .post('/api/servers/no-such/portable-import/signed-mapping-review')
      .set('Authorization', `Bearer ${jwtToken(OWNER)}`)
      .set(stepUpHeader(OWNER, 'account-security')).send(input());
    expect(missing.status).toBe(404);
    expect(config).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('uses only source trusted by operator and fresh destination server topology, never attacker Host', async () => {
    const before = await snapshot();
    const r = await post(OWNER, input(), 'account-security');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toMatchObject({
      mode: 'read-only', sourceSignatureValid: true,
      approvalEligible: false, mappingApproved: false, writesPerformed: false,
      importSupported: false, targetTopologyBound: true, transactionallyLocked: false,
    });
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledWith({
      structure: input().structure,
      permissions: input().permissions,
      attestation: input().attestation,
      expectedSourceOrigin: ORIGIN,
      expectedSourceServerId: SOURCE,
      operatorRegistryJson: 'pinned-operator-registry-not-from-request',
      mapping: input().mapping,
      destination: {
        serverId: SID,
        categories: expect.arrayContaining([expect.objectContaining({ _id: 'category' })]),
        roles: expect.arrayContaining([expect.objectContaining({ _id: 'role' })]),
        channels: expect.arrayContaining([expect.objectContaining({ _id: 'channel' })]),
      },
    });
    expect(JSON.stringify(r.body)).not.toContain('attacker-supplied-host.example');
    expect(JSON.stringify(r.body)).not.toContain('pinned-operator-registry-not-from-request');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses disabled registry, unavailable topology or failed signed mapping without partial content', async () => {
    config.mockImplementationOnce(() => { throw new Error('secret registry bytes'); });
    const disabled = await post(OWNER, input(), 'account-security');
    expect(disabled.status).toBe(503);
    expect(disabled.body.code).toBe('PORTABLE_SIGNED_MAPPING_TRUST_UNAVAILABLE');
    expect(inspect).not.toHaveBeenCalled();
    const { Channels } = require('../db/repositories') as typeof import('../db/repositories');
    const spy = jest.spyOn(Channels, 'findByServer').mockRejectedValueOnce(new Error('PG unavailable'));
    try {
      const unavailable = await post(OWNER, input(), 'account-security');
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe('PORTABLE_SIGNED_MAPPING_TARGET_UNAVAILABLE');
    } finally { spy.mockRestore(); }
    inspect.mockImplementationOnce(() => { throw new Error('attacker-supplied signature material'); });
    const invalid = await post(OWNER, input(), 'account-security');
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('PORTABLE_SIGNED_MAPPING_REVIEW_INVALID');
    expect(JSON.stringify(invalid.body)).not.toContain('attacker-supplied signature');
    expect(invalid.body).not.toHaveProperty('mapping');
  });

  it('rejects wrong target, forged public keys, unexpected fields and malformed source identity', async () => {
    for (const malformed of [
      { ...input(), targetServerId: 'another-server' },
      { ...input(), publicKeyPem: 'attacker-key' },
      { ...input(), approval: true },
      { ...input(), expectedSourceOrigin: 'http://pinned-source.example' },
      { ...input(), expectedSourceOrigin: 'https://pinned-source.example/path' },
      { ...input(), expectedSourceServerId: '  ' },
      { ...input(), attestation: [] },
      { ...input(), mapping: null },
    ]) {
      const r = await post(OWNER, malformed, 'account-security');
      expect(r.status).toBe(400);
    }
    expect(config).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });
});
