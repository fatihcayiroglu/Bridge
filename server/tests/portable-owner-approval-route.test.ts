// P7 C4: owner-only opt-in approval endpoint, not a community importer.
process.env.JWT_SECRET = 'owner-approval-route-jwt-test-min-32chars';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));
jest.mock('../lib/portableDestinationTrustConfig', () => ({
  readDestinationPinnedSourceRegistry: jest.fn(),
}));
jest.mock('../lib/portableTransactionalApprovalStage', () => ({
  stageOwnerConfirmedPortableApproval: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { stepUpHeader } from './helpers/stepUp';
import { mintStepUpGrant, STEP_UP_HEADER } from '../lib/stepUp';
import { readDestinationPinnedSourceRegistry } from '../lib/portableDestinationTrustConfig';
import { stageOwnerConfirmedPortableApproval } from '../lib/portableTransactionalApprovalStage';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb & {
  _pool?: { connect: () => Promise<never> };
};
const config = readDestinationPinnedSourceRegistry as jest.Mock;
const stage = stageOwnerConfirmedPortableApproval as jest.Mock;
const SID = 'approval-target';
const OWNER = 'approval-owner';
const MEMBER = 'approval-member';
const SOURCE = 'source-instance';
const ORIGIN = 'https://pinned-source.example';
const hash = (c: string) => c.repeat(64);
const originalFlag = process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED;

const token = (id: string) =>
  jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
const body = () => ({
  structure: { source: SOURCE },
  permissions: { coverage: 'paired' },
  attestation: { signature: 'signed' },
  expectedSourceOrigin: ORIGIN,
  expectedSourceServerId: SOURCE,
  targetServerId: SID,
  mapping: {
    targetServerId: SID, structureDigest: hash('a'),
    permissionsDigest: hash('b'), expectedTargetDigest: hash('c'),
    categories: [{ sourceId: 'sc', targetId: 'tc' }],
    roles: [{ sourceId: 'sr', targetId: 'tr' }],
    channels: [{ sourceId: 'sch', targetId: 'tch' }],
  },
  confirmedReviewFingerprint: hash('f'),
  confirmation: 'CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES',
});
function post(user: string | null, payload: unknown = body(),
  scope: 'account-security' | 'sensitive-export' | null = null) {
  let r = request(app())
    .post('/api/servers/' + SID + '/portable-import/owner-approval')
    .set('Host', 'attacker-origin.invalid');
  if (user) r = r.set('Authorization', 'Bearer ' + token(user));
  if (user && scope) r = r.set(stepUpHeader(user, scope));
  return r.send(payload);
}
beforeEach(async () => {
  db._reset();
  config.mockReset(); stage.mockReset();
  process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED = 'true';
  for (const id of [OWNER, MEMBER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, ownerId: OWNER, name: 'Destination' });
  await db.members.insert({ _id: 'member', serverId: SID, userId: MEMBER });
  db._pool = { connect: jest.fn(async () => { throw new Error('Should never be called by route'); }) };
  config.mockReturnValue('operator-pinned-config-not-from-request');
  stage.mockResolvedValue({
    approvalToken: 'a'.repeat(43),
    expiresAt: '2026-10-13T17:02:00.000Z',
    targetReviewFingerprint: hash('f'),
    approvalRecordWritten: true,
    destinationDataWritesPerformed: false,
    importSupported: false,
  });
});
afterAll(() => {
  if (originalFlag === undefined) delete process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED;
  else process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED = originalFlag;
});
describe('P7 owner-confirmed, disabled-by-default API boundary', () => {
  it('refuses anonymous, delegated, missing/wrong step-up before pinned registry', async () => {
    expect((await post(null)).status).toBe(401);
    expect((await post(MEMBER, body(), 'account-security')).status).toBe(403);
    expect((await post(OWNER)).status).toBe(403);
    expect((await post(OWNER, body(), 'sensitive-export')).status).toBe(403);
    const notFound = await request(app())
      .post('/api/servers/does-not-exist/portable-import/owner-approval')
      .set('Authorization', 'Bearer ' + token(OWNER))
      .set(stepUpHeader(OWNER, 'account-security'))
      .send(body());
    expect(notFound.status).toBe(404);
    expect(config).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('stays disabled until deliberate deployment opt-in, even with owner proof', async () => {
    delete process.env.BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED;
    const response = await post(OWNER, body(), 'account-security');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PORTABLE_OWNER_APPROVAL_DISABLED');
    expect(config).not.toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it('never supplies attacker owner, host or signing keys; returns only committed token evidence', async () => {
    const response = await post(OWNER, body(), 'account-security');
    expect(response.status).toBe(201);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.body).toMatchObject({
      approvalRecordWritten: true, destinationDataWritesPerformed: false, importSupported: false,
    });
    expect(config).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledTimes(1);
    expect(stage).toHaveBeenCalledWith(expect.objectContaining({
      pool: db._pool, ownerId: OWNER, targetServerId: SID,
      confirmedReviewFingerprint: body().confirmedReviewFingerprint,
      stepUpGrant: expect.any(String),
      operatorRegistryJson: 'operator-pinned-config-not-from-request',
      mapping: body().mapping,
    }));
    expect(JSON.stringify(response.body)).not.toContain('attacker-origin.invalid');
    expect(JSON.stringify(response.body)).not.toContain('operator-pinned-config-not-from-request');
  });

  it('blocks invalid explicit confirmation, extra privileged fields, stale digests and unsafe mapping shape', async () => {
    const variants = [
      { ...body(), confirmation: 'yes' },
      { ...body(), confirmation: false },
      { ...body(), confirmedReviewFingerprint: 'not-hex' },
      { ...body(), confirmedReviewFingerprint: hash('F') },
      { ...body(), targetServerId: 'attacker-target' },
      { ...body(), ownerId: 'attacker' },
      { ...body(), publicKeyPem: 'attacker-key' },
      { ...body(), operatorRegistryJson: 'attacker-keyring' },
      { ...body(), mapping: { roles: [] } },
      { ...body(), mapping: { ...body().mapping, channels: [{ sourceId: 10, targetId: 'tch' }] } },
      { ...body(), mapping: { ...body().mapping, expectedTargetDigest: 'unknown' } },
      { ...body(), expectedSourceOrigin: 'http://untrusted.example' },
      { ...body(), expectedSourceServerId: '' },
      { ...body(), structure: [] },
      { ...body(), attestation: null },
    ];
    for (const invalid of variants) {
      const r = await post(OWNER, invalid, 'account-security');
      expect(r.status).toBe(400);
    }
    expect(stage).not.toHaveBeenCalled();
    expect(config).not.toHaveBeenCalled();
  });

  it('fails closed when registry or DB unavailable or backend refuses review, without revealing token', async () => {
    config.mockImplementationOnce(() => { throw Error('private registry details'); });
    const noTrust = await post(OWNER, body(), 'account-security');
    expect(noTrust.status).toBe(503);
    expect(JSON.stringify(noTrust.body)).not.toContain('private registry');
    db._pool = undefined;
    const noPool = await post(OWNER, body(), 'account-security');
    expect(noPool.status).toBe(503);
    expect(noPool.body.code).toBe('PORTABLE_OWNER_APPROVAL_DB_UNAVAILABLE');
    db._pool = { connect: jest.fn(async () => { throw Error('must not connect in test'); }) };
    stage.mockRejectedValueOnce(Error('secret signature or target data'));
    const badReview = await post(OWNER, body(), 'account-security');
    expect(badReview.status).toBe(422);
    expect(badReview.body.code).toBe('PORTABLE_OWNER_APPROVAL_UNAVAILABLE');
    expect(badReview.body).not.toHaveProperty('approvalToken');
    expect(JSON.stringify(badReview.body)).not.toContain('secret signature');
  });

  // The in-transaction check refuses an owner proof older than 120 s with
  // the uniform 422, which the client cannot act on. A stale-but-valid grant
  // must instead get 403 STEP_UP_REQUIRED (step_up_stale) at the route, so
  // the client asks for ONE fresh proof; a recent one still proceeds.
  it('asks for a fresh owner proof instead of failing later with a silent 422', async () => {
    const minted = (ageMs: number) => ({
      [STEP_UP_HEADER]: mintStepUpGrant({ _id: OWNER, tokenVersion: 0 }, 'totp', 'account-security', Date.now() - ageMs).token,
    });
    const stale = await request(app()).post('/api/servers/' + SID + '/portable-import/owner-approval')
      .set('Authorization', 'Bearer ' + token(OWNER)).set(minted(101_000)).send(body());
    expect(stale.status).toBe(403);
    expect(stale.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security', reasons: ['step_up_stale'] });
    expect(stage).not.toHaveBeenCalled();
    const recent = await request(app()).post('/api/servers/' + SID + '/portable-import/owner-approval')
      .set('Authorization', 'Bearer ' + token(OWNER)).set(minted(60_000)).send(body());
    expect(recent.status).toBe(201);
    expect(stage).toHaveBeenCalledTimes(1);
  });
});
