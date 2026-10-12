// P7 C3: actual HTTP contract for explicit ID mapping REVIEW; no SQL writes.
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../routes/discover', () => ({ invalidateMemberCount: jest.fn(async () => {}) }));
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import serversRouter from '../routes/servers';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { stepUpHeader } from './helpers/stepUp';
import { PERMS } from '../lib/permissions';
import { fingerprintDestinationTopology } from '../lib/portableCommunityTargetFingerprint';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const SID = 'mapping-review-target', OWNER = 'mapping-owner', OTHER = 'mapping-member';
const SOURCE = 'mapping-source-server', AT = '2026-10-12T11:00:00.000Z';
const token = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
function app() {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
}
function expectedTargetDigest(roleMask = PERMS.VIEW_CHANNELS) {
  return fingerprintDestinationTopology({
    serverId: SID,
    categories: [{ _id: 'target-cat', serverId: SID, name: 'General' }],
    roles: [{ _id: 'target-role', serverId: SID, name: 'Readers', permissions: roleMask }],
    channels: [{ _id: 'target-channel', serverId: SID, name: 'welcome', type: 'text' }],
  });
}
function input() {
  const structure = buildPortableCommunityStructure(
    { _id: SOURCE, name: 'Source' },
    [{ _id: 'source-cat', name: 'General', position: 0 }],
    [{ _id: 'source-channel', name: 'welcome', type: 'text', categoryId: 'source-cat', order: 0 }],
    [{ _id: 'source-role', name: 'Readers', permissions: PERMS.VIEW_CHANNELS, position: 0 }],
    AT,
  );
  const permissions = buildPortableCommunityPermissionManifest(
    { _id: SOURCE },
    [{ _id: 'source-channel', serverId: SOURCE }],
    [{ _id: 'source-role', serverId: SOURCE }],
    [{ channelId: 'source-channel', canonical: [{
      channelId: 'source-channel', serverId: SOURCE, roleId: 'source-role',
      allow: PERMS.VIEW_CHANNELS, deny: 0,
    }], legacy: [] }],
    AT,
  );
  return {
    structure, permissions, targetServerId: SID,
    mapping: {
      targetServerId: SID,
      expectedTargetDigest: expectedTargetDigest(),
      structureDigest: structure.integrity.digest,
      permissionsDigest: permissions.integrity.digest,
      categories: [{ sourceId: 'source-cat', targetId: 'target-cat' }],
      roles: [{ sourceId: 'source-role', targetId: 'target-role' }],
      channels: [{ sourceId: 'source-channel', targetId: 'target-channel' }],
    },
  };
}
function post(userId: string, body: unknown, scope: 'account-security' | 'sensitive-export' | null = null) {
  const q = request(app()).post(`/api/servers/${SID}/portable-import/mapping-review`)
    .set('Authorization', `Bearer ${token(userId)}`);
  return (scope ? q.set(stepUpHeader(userId, scope)) : q).send(body);
}
function getFingerprint(userId: string, scope: 'account-security' | 'sensitive-export' | null = null) {
  const q = request(app()).get(`/api/servers/${SID}/portable-import/target-fingerprint`)
    .set('Authorization', `Bearer ${token(userId)}`);
  return scope ? q.set(stepUpHeader(userId, scope)) : q;
}
async function snapshot() {
  return {
    servers: await db.servers.find({}),
    channels: await db.channels.find({}),
    categories: await db.channelCategories.find({}),
    roles: await db.roles.find({}),
    members: await db.members.find({}),
    channelPermissions: await db.channelPermissions.find({}),
    overrides: await db.channelOverrides.find({}),
  };
}

beforeEach(async () => {
  db._reset();
  for (const id of [OWNER, OTHER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, name: 'Destination', ownerId: OWNER });
  await db.channelCategories.insert({ _id: 'target-cat', serverId: SID, name: 'General' });
  await db.roles.insert({ _id: 'target-role', serverId: SID, name: 'Readers',
    permissions: PERMS.VIEW_CHANNELS, position: 0 });
  await db.channels.insert({ _id: 'target-channel', serverId: SID,
    name: 'welcome', type: 'text', order: 0 });
  await db.members.insert({ _id: 'membership-sensitive', serverId: SID, userId: OTHER, roles: [] });
});

describe('POST /api/servers/:sid/portable-import/mapping-review', () => {
  it('provides an owner-only no-store target fingerprint without source files or DB writes', async () => {
    const before = await snapshot();
    const anonymous = await request(app()).get(`/api/servers/${SID}/portable-import/target-fingerprint`);
    expect(anonymous.status).toBe(401);
    expect((await getFingerprint(OTHER, 'account-security')).status).toBe(403);
    const missingStepUp = await getFingerprint(OWNER);
    expect(missingStepUp.status).toBe(403);
    expect(missingStepUp.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    expect((await getFingerprint(OWNER, 'sensitive-export')).status).toBe(403);
    const first = await getFingerprint(OWNER, 'account-security');
    const second = await getFingerprint(OWNER, 'account-security');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.body).toMatchObject({
      mode: 'read-only', writesPerformed: false, importSupported: false,
      targetServerId: SID, topologyOnly: true, transactionalLock: false,
      counts: { categories: 1, roles: 1, channels: 1 },
    });
    expect(first.body.targetTopologyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.body.targetTopologyDigest).toBe(input().mapping.expectedTargetDigest);
    expect(second.body.targetTopologyDigest).toBe(first.body.targetTopologyDigest);
    expect(await snapshot()).toEqual(before);
  });

  it('detects topology drift without disclosing target records or granting writes', async () => {
    const stale = input();
    const first = await getFingerprint(OWNER, 'account-security');
    expect(first.status).toBe(200);
    await db.channels.update({ _id: 'target-channel' }, { $set: { topic: 'new topic' } });
    const refreshed = await getFingerprint(OWNER, 'account-security');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.targetTopologyDigest).not.toBe(first.body.targetTopologyDigest);
    const rejected = await post(OWNER, stale, 'account-security');
    expect(rejected.status).toBe(422);
    expect(rejected.body.mapping).toBeUndefined();
  });

  it('fails closed rather than returning a partial fingerprint on an inconsistent target', async () => {
    await db.channels.insert({ _id: 'broken', serverId: SID, name: 123, type: 'text' });
    const response = await getFingerprint(OWNER, 'account-security');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PORTABLE_COMMUNITY_TARGET_FINGERPRINT_UNAVAILABLE');
  });


  it('refuses anonymous and nonowner requests before reading destination children', async () => {
    const anon = await request(app()).post(`/api/servers/${SID}/portable-import/mapping-review`)
      .send(input());
    expect(anon.status).toBe(401);
    const notOwner = await post(OTHER, input(), 'account-security');
    expect(notOwner.status).toBe(403);
    expect(JSON.stringify(notOwner.body)).not.toContain('target-role');
  });

  it('requires import step-up and rejects wrong scope, switched target and extra apply flag', async () => {
    const absent = await post(OWNER, input());
    expect(absent.status).toBe(403);
    expect(absent.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    const wrong = await post(OWNER, input(), 'sensitive-export');
    expect(wrong.status).toBe(403);
    const switched = await post(OWNER, { ...input(), targetServerId: 'another-target' }, 'account-security');
    expect(switched.status).toBe(409);
    const extra = await post(OWNER, { ...input(), apply: true }, 'account-security');
    expect(extra.status).toBe(400);
  });

  it('returns explicit complete mapping diagnostics without modifying the database', async () => {
    const before = await snapshot();
    const result = await post(OWNER, input(), 'account-security');
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toContain('no-store');
    expect(result.body).toMatchObject({
      mode: 'read-only', importSupported: false, writesPerformed: false, mappingApproved: false,
      sourceServerId: SOURCE, targetServerId: SID,
      counts: { categories: 1, roles: 1, channels: 1,
        unsafeRoleMappings: 0, unsupportedPermissionRows: 0 },
      mapping: { roles: [{ sourceId: 'source-role', targetId: 'target-role' }] },
    });
    expect(result.body.blockers).toContain('IMPORT_NOT_IMPLEMENTED');
    expect(result.body.blockers).toContain('TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED');
    expect(JSON.stringify(result.body)).not.toContain('membership-sensitive');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses previously valid mappings after a target category change', async () => {
    const previous = input();
    const changed = await db.channelCategories.update({ _id: 'target-cat' },
      { $set: { name: 'Changed since preview' } });
    expect(changed).toBeDefined();
    const before = await snapshot();
    const rejected = await post(OWNER, previous, 'account-security');
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('PORTABLE_COMMUNITY_MAPPING_INVALID');
    expect(rejected.body.mapping).toBeUndefined();
    expect(await snapshot()).toEqual(before);
  });

  it('detects privilege-widening target roles without permitting apply or writing any data', async () => {
    await db.roles.update({ _id: 'target-role' },
      { $set: { permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES } });
    const before = await snapshot();
    const reviewed = input();
    reviewed.mapping.expectedTargetDigest =
      expectedTargetDigest(PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES);
    const result = await post(OWNER, reviewed, 'account-security');
    expect(result.status).toBe(200);
    expect(result.body.counts.unsafeRoleMappings).toBe(1);
    expect(result.body.blockers).toContain('TARGET_ROLE_PERMISSION_WIDENING');
    expect(result.body.importSupported).toBe(false);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects missing mappings, malformed source files and cross-server target topology', async () => {
    const before = await snapshot();
    const missing = input();
    missing.mapping.channels = [];
    const invalid = await post(OWNER, missing, 'account-security');
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe('PORTABLE_COMMUNITY_MAPPING_INVALID');
    const damaged = input();
    damaged.structure.channels[0]!.name = 'modified-without-checksum';
    expect((await post(OWNER, damaged, 'account-security')).status).toBe(422);
    expect(await snapshot()).toEqual(before);
    await db.channels.insert({ _id: 'another-server-row', serverId: SID, name: 'broken', type: 'text' });
    await db.channels.update({ _id: 'target-channel' }, { $set: { serverId: 'foreign-server' } });
    const inconsistent = await post(OWNER, input(), 'account-security');
    expect(inconsistent.status).toBe(422);
  });

  it('does not return a partial mapping when destination repositories fail', async () => {
    const { Channels } = require('../db/repositories') as typeof import('../db/repositories');
    const spy = jest.spyOn(Channels, 'findByServer').mockRejectedValueOnce(new Error('PG unavailable'));
    try {
      const unavailable = await post(OWNER, input(), 'account-security');
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.code).toBe('PORTABLE_COMMUNITY_MAPPING_UNAVAILABLE');
      expect(unavailable.body.mapping).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
