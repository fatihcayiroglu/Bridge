// P7 C4: HTTP fail-closed boundary for mapped EXISTING rows only.
process.env.JWT_SECRET = 'mapped-apply-route-jwt-test-secret-32chars';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../lib/portableDestinationTrustConfig', () => ({
  readDestinationPinnedSourceRegistry: jest.fn(),
}));
jest.mock('../lib/portableAtomicMappedApply', () => ({
  applyApprovedPortableCommunityMapping: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { readDestinationPinnedSourceRegistry } from '../lib/portableDestinationTrustConfig';
import { applyApprovedPortableCommunityMapping } from '../lib/portableAtomicMappedApply';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb & {
  _pool?: { connect(): Promise<never> };
};
const registry = readDestinationPinnedSourceRegistry as jest.Mock;
const apply = applyApprovedPortableCommunityMapping as jest.Mock;
const OWNER = 'mapped-owner', MEMBER = 'mapped-member', SID = 'mapped-target';
const SOURCE = 'another-installation';
const origin = 'https://another-installation.example';
const sha = (c: string) => c.repeat(64);
// Actual canonical 32-byte Base64URL proof; 43 random-looking characters alone
// are intentionally not a sufficient token-shape guarantee.
const token = Buffer.alloc(32, 0x15).toString('base64url');
const oldApprovalFlag = process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED;
const oldApplyFlag = process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED;

function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
const credential = (id: string) => jwt.sign(
  { id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' },
);
const payload = () => ({
  structure: { format: 'portable-structure' },
  permissions: { format: 'portable-permissions' },
  attestation: { signature: 'ed25519-signed' },
  expectedSourceOrigin: origin, expectedSourceServerId: SOURCE,
  targetServerId: SID,
  mapping: {
    targetServerId: SID, structureDigest: sha('a'),
    permissionsDigest: sha('b'), expectedTargetDigest: sha('c'),
    categories: [{ sourceId: 'sc', targetId: 'tc' }],
    roles: [{ sourceId: 'sr', targetId: 'tr' }],
    channels: [{ sourceId: 'sch', targetId: 'tch' }],
  },
  confirmedReviewFingerprint: sha('f'),
  confirmation: 'APPLY_MAPPED_PORTABLE_METADATA_ONLY',
  approvalToken: token,
});
function submit(user: string | null, body: unknown = payload(),
  scope: 'account-security' | 'sensitive-export' | null = null) {
  let r = request(app()).post('/api/servers/' + SID + '/portable-import/mapped-apply')
    .set('Host', 'attacker-redirect.example');
  if (user) r = r.set('Authorization', 'Bearer ' + credential(user));
  if (user && scope) r = r.set(stepUpHeader(user, scope));
  return r.send(body);
}
beforeEach(async () => {
  db._reset(); registry.mockReset(); apply.mockReset();
  process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED = 'true';
  process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED = 'true';
  await db.users.insert({ _id: OWNER, username: OWNER, password: 'hash', tokenVersion: 0 });
  await db.users.insert({ _id: MEMBER, username: MEMBER, password: 'hash', tokenVersion: 0 });
  await db.servers.insert({ _id: SID, ownerId: OWNER, name: 'Target' });
  await db.members.insert({ _id: 'member-record', serverId: SID, userId: MEMBER });
  db._pool = { connect: jest.fn(async () => { throw Error('Service mocked'); }) };
  registry.mockReturnValue('pinned-source-config');
  apply.mockResolvedValue({
    applied: true, transactionCommitted: true, routeMounted: false,
    changed: { categories: 1, roles: 1, channels: 1 },
    grantsPreserved: true, identitiesPreserved: true,
  });
});
afterAll(() => {
  if (oldApprovalFlag === undefined) delete process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED;
  else process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED = oldApprovalFlag;
  if (oldApplyFlag === undefined) delete process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED;
  else process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED = oldApplyFlag;
});

describe('P7 C4 narrowly scoped mapped-apply HTTP guard', () => {
  it('rejects anonymity, delegated actors, missing/wrong step-up before consulting pinned keys', async () => {
    expect((await submit(null)).status).toBe(401);
    expect((await submit(MEMBER, payload(), 'account-security')).status).toBe(403);
    expect((await submit(OWNER)).status).toBe(403);
    expect((await submit(OWNER, payload(), 'sensitive-export')).status).toBe(403);
    const missing = await request(app())
      .post('/api/servers/missing/portable-import/mapped-apply')
      .set('Authorization', 'Bearer ' + credential(OWNER))
      .set(stepUpHeader(OWNER, 'account-security')).send(payload());
    expect(missing.status).toBe(404);
    expect(registry).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('requires BOTH independent deployment switches', async () => {
    delete process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED;
    expect((await submit(OWNER, payload(), 'account-security')).body.code)
      .toBe('PORTABLE_MAPPED_APPLY_DISABLED');
    process.env.BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED = 'true';
    delete process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED;
    expect((await submit(OWNER, payload(), 'account-security')).status).toBe(503);
    expect(registry).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('supplies only signed data with actual authenticated actor and trusted registry', async () => {
    const r = await submit(OWNER, payload(), 'account-security');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.body).toMatchObject({
      mode: 'existing-mapped-metadata-only',
      applied: true, transactionCommitted: true,
      grantsPreserved: true, identitiesPreserved: true,
      membershipImported: false, permissionGrantsImported: false,
      changed: { categories: 1, roles: 1, channels: 1 },
    });
    expect(registry).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: OWNER, targetServerId: SID, pool: db._pool,
      stepUpGrant: expect.any(String), operatorRegistryJson: 'pinned-source-config',
      confirmedReviewFingerprint: payload().confirmedReviewFingerprint,
      approvalToken: payload().approvalToken, mapping: payload().mapping,
    }));
    for (const secret of [payload().approvalToken, 'pinned-source-config', 'attacker-redirect.example']) {
      expect(JSON.stringify(r.body)).not.toContain(secret);
    }
    expect(r.body).not.toHaveProperty('routeMounted');
  });

  it('rejects spoofed owner/keyring, stale mappings, unsupported claims and bad token shape', async () => {
    const rejected = [
      { ...payload(), confirmation: 'CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES' },
      { ...payload(), ownerId: OWNER },
      { ...payload(), publicKeyPem: 'attacker-key' },
      { ...payload(), failpoint: 'after_claim' },
      { ...payload(), approvalToken: 'bad' },
      { ...payload(), approvalToken: 'a'.repeat(43) },
      { ...payload(), confirmedReviewFingerprint: sha('F') },
      { ...payload(), targetServerId: 'foreign' },
      { ...payload(), expectedSourceOrigin: 'http://source.example' },
      { ...payload(), mapping: { roles: [] } },
      { ...payload(), mapping: { ...payload().mapping, expectedTargetDigest: 'bad' } },
      { ...payload(), mapping: { ...payload().mapping, channels: [{ sourceId: null, targetId: 'tch' }] } },
      { ...payload(), structure: [] },
      { ...payload(), permissions: null },
      { ...payload(), attestation: [] },
    ];
    for (const item of rejected) {
      const r = await submit(OWNER, item, 'account-security');
      expect(r.status).toBe(400);
    }
    expect(registry).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('fails closed on unavailable database, pinned registry, or internal apply rollback', async () => {
    db._pool = undefined;
    expect((await submit(OWNER, payload(), 'account-security')).status).toBe(503);
    db._pool = { connect: jest.fn(async () => { throw Error('unreachable mock'); }) };
    registry.mockImplementationOnce(() => { throw Error('private key storage'); });
    const trust = await submit(OWNER, payload(), 'account-security');
    expect(trust.status).toBe(503);
    expect(JSON.stringify(trust.body)).not.toContain('private key');
    apply.mockRejectedValueOnce(Error('cannot determine token existence from failed rollback'));
    const result = await submit(OWNER, payload(), 'account-security');
    expect(result.status).toBe(422);
    expect(result.body.code).toBe('PORTABLE_MAPPED_APPLY_UNAVAILABLE');
    expect(JSON.stringify(result.body)).not.toContain('token existence');
  });
});
