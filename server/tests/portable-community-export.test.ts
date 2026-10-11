// P7 C2: executable owner/step-up/privacy contract for the read-only structure export.
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
import { stepUpHeader } from './helpers/stepUp';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { PERMS } from '../lib/permissions';

const db = require('../db/loader') as import('./helpers/mockDb').MockDb;
const SID = 'c2-community', OWNER = 'c2-owner', OTHER = 'c2-other';
const token = (id: string) => jwt.sign({ id, v: 0 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/servers', serversRouter);
  return instance;
}
function exportAs(id: string, scope: 'sensitive-export' | 'account-security' | null = null) {
  const req = request(app()).get(`/api/servers/${SID}/portable-export`)
    .set('Authorization', `Bearer ${token(id)}`);
  return scope ? req.set(stepUpHeader(id, scope)) : req;
}

beforeEach(async () => {
  db._reset();
  await db.users.insert({ _id: OWNER, username: 'owner', password: 'hash', tokenVersion: 0 });
  await db.users.insert({ _id: OTHER, username: 'other', password: 'hash', tokenVersion: 0 });
  await db.servers.insert({
    _id: SID, name: 'Owner Only', ownerId: OWNER, description: 'Community',
    privateAdminToken: 'NEVER-EXPORTED-SECRET',
  });
  await db.channelCategories.insert({
    _id: 'cat1', serverId: SID, name: 'Welcome', position: 1, collapsed: false,
    secret: 'NEVER-EXPORTED-CATEGORY',
  });
  await db.roles.insert({
    _id: 'role1', serverId: SID, name: 'Moderator', color: '#abc123',
    position: 2, permissions: PERMS.MANAGE_CHANNELS | PERMS.VIEW_CHANNELS,
    internalNote: 'NEVER-EXPORTED-ROLE',
  });
  await db.channels.insert({
    _id: 'channel1', serverId: SID, name: 'general', type: 'text', topic: 'Welcome',
    order: 1, categoryId: 'cat1', slowmode: 0, webhookSecret: 'NEVER-EXPORTED-CHANNEL',
  });
  await db.messages.insert({ _id: 'msg1', serverId: SID, channelId: 'channel1', content: 'NEVER-EXPORTED-MESSAGE' });
  await db.members.insert({ _id: 'membership1', userId: OTHER, serverId: SID, roles: ['role1'], privateNote: 'NEVER-EXPORTED-MEMBER' });
  await db.channelPermissions.insert({ _id: 'perm1', channelId: 'channel1', serverId: SID, roleId: 'role1', allow: 1, deny: 0 });
});

describe('P7 C2 owner-only community structure export', () => {
  it('rejects missing authentication, delegated members and missing or wrong-scope step-up', async () => {
    const unauthenticated = await request(app()).get(`/api/servers/${SID}/portable-export`);
    expect(unauthenticated.status).toBe(401);
    const member = await exportAs(OTHER, 'sensitive-export');
    expect(member.status).toBe(403);
    expect(JSON.stringify(member.body)).not.toContain('general');

    const unproven = await exportAs(OWNER);
    expect(unproven.status).toBe(403);
    expect(unproven.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'sensitive-export' });
    const wrongScope = await exportAs(OWNER, 'account-security');
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body.reasons).toContain('step_up_scope_mismatch');
  });

  it('exports only owner-authorized allowlisted structure without credentials or individual records', async () => {
    const reply = await exportAs(OWNER, 'sensitive-export');
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toContain('no-store');
    expect(reply.headers['content-disposition']).toContain('bridge-community-structure-v1.json');
    expect(reply.body).toMatchObject({
      format: 'bridge-portable-community-structure', version: 1,
      community: { sourceServerId: SID, name: 'Owner Only' },
      categories: [{ sourceId: 'cat1', name: 'Welcome' }],
      roles: [{ sourceId: 'role1', name: 'Moderator', permissions: PERMS.MANAGE_CHANNELS | PERMS.VIEW_CHANNELS }],
      channels: [{ sourceId: 'channel1', name: 'general', categorySourceId: 'cat1' }],
      portability: { importSupported: false },
    });
    const serialized = JSON.stringify(reply.body);
    for (const marker of ['NEVER-EXPORTED-', 'membership1', 'msg1', 'privateAdminToken', 'ownerId', 'webhookSecret', 'role1-secret']) {
      expect(serialized).not.toContain(marker);
    }
    const { integrity, portability, ...payload } = reply.body;
    expect(integrity.digest).toBe(createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex'));
    expect(portability.excluded).toContain('channelPermissionOverrides');
    expect(Object.keys(reply.body.community).sort()).toEqual(['sourceServerId', 'name', 'description', 'icon'].sort());
  });

  it('fails closed if a channel points to a foreign category or role data has invalid permission bits', async () => {
    await db.channels.update({ _id: 'channel1' }, { $set: { categoryId: 'not-on-this-server' } });
    const badReference = await exportAs(OWNER, 'sensitive-export');
    expect(badReference.status).toBe(409);
    expect(badReference.body.code).toBe('PORTABLE_COMMUNITY_SOURCE_INCONSISTENT');
    expect(badReference.body.channels).toBeUndefined();

    await db.channels.update({ _id: 'channel1' }, { $set: { categoryId: 'cat1' } });
    await db.roles.update({ _id: 'role1' }, { $set: { permissions: -1 } });
    const badMask = await exportAs(OWNER, 'sensitive-export');
    expect(badMask.status).toBe(409);
    expect(badMask.body.roles).toBeUndefined();
  });

  it('serializes fields deterministically without turning a checksum into an authenticity claim', () => {
    const a = buildPortableCommunityStructure(
      { _id: SID, name: 'Owner Only' },
      [{ _id: 'b', name: 'B', position: 2 }, { _id: 'a', name: 'A', position: 1 }],
      [{ _id: 'c', name: 'general', type: 'text', categoryId: 'a', order: 0 }],
      [{ _id: 'r', name: 'Reader', permissions: 0 }],
      '2026-10-11T12:00:00.000Z',
    );
    const b = buildPortableCommunityStructure(
      { _id: SID, name: 'Owner Only' },
      [{ _id: 'a', name: 'A', position: 1 }, { _id: 'b', name: 'B', position: 2 }],
      [{ _id: 'c', name: 'general', type: 'text', categoryId: 'a', order: 0 }],
      [{ _id: 'r', name: 'Reader', permissions: 0 }],
      '2026-10-11T12:00:00.000Z',
    );
    expect(a.integrity.digest).toBe(b.integrity.digest);
    expect(a.categories.map(row => row.sourceId)).toEqual(['a', 'b']);
  });
});
