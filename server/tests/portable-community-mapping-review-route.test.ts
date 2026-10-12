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
import { computePortableCommunityTargetRevision } from '../lib/portableCommunityTargetRevision';

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
      targetRevision: computePortableCommunityTargetRevision({
        serverId: SID,
        categories: [{ _id: 'target-cat', serverId: SID, name: 'General' }],
        roles: [{ _id: 'target-role', serverId: SID, name: 'Readers',
          permissions: PERMS.VIEW_CHANNELS, position: 0 }],
        channels: [{ _id: 'target-channel', serverId: SID,
          name: 'welcome', type: 'text', order: 0 }],
      }),
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
function revision(userId: string, scope: 'account-security' | 'sensitive-export' | null = null) {
  const q = request(app()).get(`/api/servers/${SID}/portable-import/target-revision`)
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


  it('GET target revision is owner-only, step-up protected, deterministic and writes nothing', async () => {
    const before = await snapshot();
    const anonymous = await request(app()).get(`/api/servers/${SID}/portable-import/target-revision`);
    expect(anonymous.status).toBe(401);
    const stranger = await revision(OTHER, 'account-security');
    expect(stranger.status).toBe(403);
    const noProof = await revision(OWNER);
    expect(noProof.status).toBe(403);
    const wrongProof = await revision(OWNER, 'sensitive-export');
    expect(wrongProof.status).toBe(403);
    const first = await revision(OWNER, 'account-security');
    const second = await revision(OWNER, 'account-security');
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toContain('no-store');
    expect(first.body).toMatchObject({
      mode: 'read-only', writesPerformed: false, importSupported: false,
      targetServerId: SID, topologyOnly: true, transactionalLock: false,
      counts: { categories: 1, roles: 1, channels: 1 },
    });
    expect(first.body.targetRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(second.body.targetRevision).toBe(first.body.targetRevision);
    expect(await snapshot()).toEqual(before);
  });

  it('returns 409 for a valid previously reviewed mapping after target topology changes', async () => {
    const old = input();
    const before = await snapshot();
    await db.channels.update({ _id: 'target-channel' }, { $set: { name: 'renamed-after-review' } });
    const changed = await revision(OWNER, 'account-security');
    expect(changed.status).toBe(200);
    expect(changed.body.targetRevision).not.toBe(old.mapping.targetRevision);
    const stale = await post(OWNER, old, 'account-security');
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('PORTABLE_COMMUNITY_TARGET_REVISION_CHANGED');
    expect(stale.body.mapping).toBeUndefined();
    const after = await snapshot();
    expect(after.roles).toEqual(before.roles);
    expect(after.members).toEqual(before.members);
    expect(after.channelPermissions).toEqual(before.channelPermissions);
  });

  it('refuses incomplete destination snapshots for revision lookup instead of a misleading digest', async () => {
    await db.channels.insert({ _id: 'malformed', serverId: SID, type: 'text', name: 37 });
    const out = await revision(OWNER, 'account-security');
    expect(out.status).toBe(503);
    expect(out.body.code).toBe('PORTABLE_COMMUNITY_TARGET_REVISION_UNAVAILABLE');
    expect(out.body.targetRevision).toBeUndefined();
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

  it('detects privilege-widening target roles without permitting apply or writing any data', async () => {
    await db.roles.update({ _id: 'target-role' },
      { $set: { permissions: PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES } });
    const before = await snapshot();
    const updatedRevision = await revision(OWNER, 'account-security');
    expect(updatedRevision.status).toBe(200);
    const body = input();
    body.mapping.targetRevision = updatedRevision.body.targetRevision as string;
    const result = await post(OWNER, body, 'account-security');
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
