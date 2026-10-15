// P7 C3: paired permission + topology preview must remain owner-only,
// read-only, identity-bound, and fail closed on independently valid mismatches.
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
import { createHash } from 'node:crypto';
import serversRouter from '../routes/servers';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { stepUpHeader } from './helpers/stepUp';
import { PERMS } from '../lib/permissions';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const SID = 'paired-preview-target', OWNER = 'paired-preview-owner', OTHER = 'paired-preview-other';
const FROM = 'paired-source-server', NOW = '2026-10-12T07:00:00.000Z';
const token = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const app = () => {
  const a = express();
  a.use(express.json({ limit: '2mb' }));
  a.use('/api/servers', serversRouter);
  return a;
};
function documents(sourceId: string = FROM) {
  const structure = buildPortableCommunityStructure(
    { _id: sourceId, name: 'Community Source' },
    [{ _id: 'source-category', name: 'General', position: 0 }],
    [{ _id: 'source-channel', type: 'text', name: 'welcome', categoryId: 'source-category', order: 0 }],
    [{ _id: 'source-role', name: 'Moderators', permissions: 0, position: 0 }],
    NOW,
  );
  const permissions = buildPortableCommunityPermissionManifest(
    { _id: sourceId },
    [{ _id: 'source-channel', serverId: sourceId }],
    [{ _id: 'source-role', serverId: sourceId }],
    [{ channelId: 'source-channel', canonical: [{
      channelId: 'source-channel', serverId: sourceId, roleId: 'source-role',
      allow: PERMS.VIEW_CHANNELS, deny: 0,
    }], legacy: [{ channelId: 'source-channel', targetType: 'user', targetId: 'private-user-id' }] }],
    NOW,
  );
  return { structure, permissions, targetServerId: SID };
}
const post = (id: string, body: string | object, scope: 'account-security' | 'sensitive-export' | null = null) => {
  const requestBuilder = request(app()).post(`/api/servers/${SID}/portable-import/paired-preview`)
    .set('Authorization', `Bearer ${token(id)}`);
  return (scope ? requestBuilder.set(stepUpHeader(id, scope)) : requestBuilder).send(body);
};
async function state() {
  return {
    servers: await db.servers.find({}),
    categories: await db.channelCategories.find({}),
    channels: await db.channels.find({}),
    roles: await db.roles.find({}),
    members: await db.members.find({}),
    permissions: await db.channelPermissions.find({}),
    overrides: await db.channelOverrides.find({}),
  };
}
beforeEach(async () => {
  db._reset();
  for (const id of [OWNER, OTHER]) {
    await db.users.insert({ _id: id, username: id, password: 'hash', tokenVersion: 0 });
  }
  await db.servers.insert({ _id: SID, ownerId: OWNER, name: 'Destination' });
  await db.channelCategories.insert({ _id: 'target-category', serverId: SID, name: 'General', position: 0 });
  await db.channels.insert({ _id: 'target-channel', serverId: SID, type: 'text', name: 'welcome', order: 0 });
  await db.roles.insert({ _id: 'target-role', serverId: SID, name: 'Moderators', permissions: 0, position: 1 });
  await db.members.insert({ _id: 'other-membership', serverId: SID, userId: OTHER, roles: [] });
});

describe('POST /api/servers/:sid/portable-import/paired-preview', () => {
  it('requires authentication and destination ownership before inspecting either private document', async () => {
    const anon = await request(app()).post(`/api/servers/${SID}/portable-import/paired-preview`)
      .send(documents());
    expect(anon.status).toBe(401);
    const nonowner = await post(OTHER, documents(), 'account-security');
    expect(nonowner.status).toBe(403);
    expect(JSON.stringify(nonowner.body)).not.toContain('source-role');
  });

  it('requires fresh account.import proof and exact signed-in destination binding', async () => {
    const absent = await post(OWNER, documents());
    expect(absent.status).toBe(403);
    expect(absent.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    const wrong = await post(OWNER, documents(), 'sensitive-export');
    expect(wrong.status).toBe(403);
    const switched = await post(OWNER, { ...documents(), targetServerId: 'different-target' }, 'account-security');
    expect(switched.status).toBe(409);
    expect(switched.body.code).toBe('PORTABLE_COMMUNITY_TARGET_CHANGED');
  });

  it('enforces exact keys and rejects checksum-valid different-source pairs without target writes', async () => {
    const before = await state();
    const extra = await post(OWNER, { ...documents(), apply: true }, 'account-security');
    expect(extra.status).toBe(400);
    const mismatched = await post(OWNER, {
      ...documents(), permissions: documents('other-source').permissions,
    }, 'account-security');
    expect(mismatched.status).toBe(422);
    expect(mismatched.body.code).toBe('PORTABLE_COMMUNITY_PAIR_INVALID');
    expect(await state()).toEqual(before);
  });

  it('rejects inconsistent channel coverage and bad digests before reading target children', async () => {
    const before = await state();
    const broken = documents();
    broken.permissions.channels[0]!.overrides[0]!.allow = 0;
    const damaged = await post(OWNER, broken, 'account-security');
    expect(damaged.status).toBe(422);
    expect(damaged.body.code).toBe('PORTABLE_COMMUNITY_PAIR_INVALID');
    expect(damaged.body.permissionPair).toBeUndefined();
    const incomplete = documents();
    incomplete.permissions.channels = [];
    const { integrity: _integrity, portability: _portability, ...canonical } = incomplete.permissions;
    incomplete.permissions.integrity.digest =
      createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
    const missing = await post(OWNER, incomplete, 'account-security');
    expect(missing.status).toBe(422);
    expect(await state()).toEqual(before);
  });

  it('rejects a checksum-valid orphan role permission rather than suggesting any mapping', async () => {
    const original = await state();
    const source = documents();
    source.permissions = buildPortableCommunityPermissionManifest(
      { _id: FROM },
      [{ _id: 'source-channel', serverId: FROM }],
      [{ _id: 'orphan-role', serverId: FROM }],
      [{
        channelId: 'source-channel',
        canonical: [{ channelId: 'source-channel', serverId: FROM,
          roleId: 'orphan-role', allow: PERMS.VIEW_CHANNELS, deny: 0 }],
        legacy: [],
      }],
      NOW,
    );
    const rejected = await post(OWNER, source, 'account-security');
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('PORTABLE_COMMUNITY_PAIR_INVALID');
    expect(rejected.body.permissionPair).toBeUndefined();
    expect(await state()).toEqual(original);
  });

  it('returns conservative collisions, counted nonportable overrides and explicit blockers', async () => {
    const before = await state();
    const res = await post(OWNER, documents(), 'account-security');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body.targetTopologyDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).toMatchObject({
      mode: 'read-only', importSupported: false, writesPerformed: false,
      source: { serverId: FROM }, target: { serverId: SID },
      conflicts: { total: 3, truncated: false },
      permissionPair: {
        mode: 'read-only', importSupported: false, writesPerformed: false,
        counts: { channels: 1, roles: 1, roleOverrides: 1, unsupportedPermissionRows: 1 },
      },
      permissionMapping: {
        mode: 'read-only', importSupported: false, writesPerformed: false,
        coverage: { channels: 1, roleOverrides: 1, hasUnsupportedGrants: true },
        diagnosticNameMatches: { roles: 1, channels: 1, usableForImport: false },
        unresolved: { total: 0, truncated: false },
      },
    });
    expect(res.body.blockers).toContain('TRANSACTIONAL_IMPORT_AND_ROLLBACK_NOT_IMPLEMENTED');
    expect(res.body.blockers).toContain('CHANNEL_PERMISSION_APPLICATION_NOT_IMPLEMENTED');
    expect(JSON.stringify(res.body)).not.toContain('private-user-id');
    expect(JSON.stringify(res.body)).not.toContain('other-membership');
    expect(await state()).toEqual(before);
  });

  it('changes owner-only paired preview fingerprint after transported metadata changes', async () => {
    const initial = await post(OWNER, documents(), 'account-security');
    expect(initial.status).toBe(200);
    const originalDigest: string = initial.body.targetTopologyDigest;
    await db.channelCategories.update({ _id: 'target-category' }, { $set: { position: 5 } });
    const categoryMoved = await post(OWNER, documents(), 'account-security');
    expect(categoryMoved.status).toBe(200);
    expect(categoryMoved.body.targetTopologyDigest).not.toBe(originalDigest);
    await db.roles.update({ _id: 'target-role' }, { $set: { color: '#ff0000' } });
    const roleChanged = await post(OWNER, documents(), 'account-security');
    expect(roleChanged.status).toBe(200);
    expect(roleChanged.body.targetTopologyDigest).not.toBe(categoryMoved.body.targetTopologyDigest);
    await db.channels.update({ _id: 'target-channel' }, { $set: { topic: 'updated topic' } });
    const topicChanged = await post(OWNER, documents(), 'account-security');
    expect(topicChanged.status).toBe(200);
    expect(topicChanged.body.targetTopologyDigest).not.toBe(roleChanged.body.targetTopologyDigest);
    expect(topicChanged.body).toMatchObject({
      mode: 'read-only', writesPerformed: false, importSupported: false,
    });
    expect(JSON.stringify(topicChanged.body)).not.toContain('private-user-id');
  });

  it('fails closed when target topology is malformed or cannot be completely read', async () => {
    const before = await state();
    await db.channels.insert({ _id: 'broken-target', serverId: SID, name: 1, type: 'text' });
    const bad = await post(OWNER, documents(), 'account-security');
    expect(bad.status).toBe(503);
    expect(bad.body.code).toBe('PORTABLE_COMMUNITY_PREVIEW_UNAVAILABLE');
    expect(bad.body.conflicts).toBeUndefined();
    const after = await state();
    expect(after.channels).toHaveLength(before.channels.length + 1);
    expect(after.roles).toEqual(before.roles);
    expect(after.permissions).toEqual(before.permissions);
  });
});
