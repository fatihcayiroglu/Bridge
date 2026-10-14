// server/tests/roles.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import rolesRouter from '../routes/roles';
import { canViewChannel, PERMS } from '../lib/permissions';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', rolesRouter);
  return app;
}
function tok(uid: string) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Roles Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let memberId: string;
  let serverId: string;
  let ownerToken: string;
  let memberToken: string;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    memberId  = uuidv4();
    serverId  = uuidv4();
    ownerToken  = tok(ownerId);
    memberToken = tok(memberId);

    await db.users.insert({ _id: ownerId,  username: 'owner',  displayName: 'Owner',  tokenVersion: 0 });
    await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'Test', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
  });

  describe('GET /api/servers/:sid/roles', () => {
    it('returns roles for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/roles`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns 403 for non-member', async () => {
      const stranger = uuidv4();
      await db.users.insert({ _id: stranger, username: 's', displayName: 'S', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/servers/${serverId}/roles`)
        .set('Authorization', `Bearer ${tok(stranger)}`);
      expect([403, 404]).toContain(res.status);
    });
  });

  describe('POST /api/servers/:sid/roles', () => {
    it('allows owner to create role', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/roles`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Moderator', color: '#ff0000', permissions: 1 << 4 });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('_id');
      expect(res.body.name).toBe('Moderator');
    });

    it('rejects non-owner creating role', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/roles`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ name: 'Hacker', color: '#000' });
      expect([403]).toContain(res.status);
    });

    it('rejects missing name', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/roles`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ color: '#fff' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/servers/:sid/roles/:roleId', () => {
    let roleId: string;
    beforeEach(async () => {
      const r = await db.roles.insert({ _id: uuidv4(), serverId, name: 'Mod', color: '#fff', permissions: [], createdAt: Date.now() });
      roleId = r._id;
    });

    it('owner can update role name', async () => {
      const res = await request(app)
        .patch(`/api/servers/${serverId}/roles/${roleId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'SuperMod' });
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('SuperMod');
    });

    it('member cannot update role', async () => {
      const res = await request(app)
        .patch(`/api/servers/${serverId}/roles/${roleId}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ name: 'Hacked' });
      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /api/servers/:sid/roles/:roleId', () => {
    let roleId: string;
    beforeEach(async () => {
      const r = await db.roles.insert({ _id: uuidv4(), serverId, name: 'ToDelete', color: '#fff', permissions: [], createdAt: Date.now() });
      roleId = r._id;
    });

    it('owner can delete role', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/roles/${roleId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
    });

    it('member cannot delete role', async () => {
      const res = await request(app)
        .delete(`/api/servers/${serverId}/roles/${roleId}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(403);
    });

    it('revokes the private channel the deleted role granted and removes it from every member', async () => {
      const channelId = uuidv4();
      const staffRole = uuidv4();
      const otherRole = uuidv4();
      await db.channels.insert({ _id: channelId, serverId, name: 'staff', type: 'text' });
      await db.roles.insert({ _id: staffRole, serverId, name: 'Staff', permissions: 0, position: 1, createdAt: Date.now() });
      await db.roles.insert({ _id: otherRole, serverId, name: 'Other', permissions: 0, position: 2, createdAt: Date.now() });
      await db.members.update({ userId: memberId, serverId }, { $set: { roles: [staffRole, otherRole] } });
      // How the channel permission routes persist a private channel: @everyone
      // denied, one role allowed.
      await db.channelPermissions.insert({ _id: uuidv4(), channelId, roleId: '__everyone__', serverId, allow: 0, deny: PERMS.VIEW_CHANNELS, createdAt: 1 });
      await db.channelPermissions.insert({ _id: uuidv4(), channelId, roleId: staffRole, serverId, allow: PERMS.VIEW_CHANNELS, deny: 0, createdAt: 1 });
      expect(await canViewChannel(memberId, serverId, channelId)).toBe(true);

      const res = await request(app)
        .delete(`/api/servers/${serverId}/roles/${staffRole}`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect(res.status).toBe(200);
      expect(await canViewChannel(memberId, serverId, channelId)).toBe(false);
      expect((await db.members.findOne({ userId: memberId, serverId })).roles).toEqual([otherRole]);
      const rows = await db.channelPermissions.find({ channelId });
      expect(rows.map((row: { roleId: string }) => row.roleId)).toEqual(['__everyone__']);
    });

    it('answers 404 and changes nothing for a role of another server', async () => {
      const foreignServer = uuidv4();
      const foreignRole = uuidv4();
      await db.servers.insert({ _id: foreignServer, name: 'Other', ownerId: memberId });
      await db.roles.insert({ _id: foreignRole, serverId: foreignServer, name: 'Foreign', permissions: 0, createdAt: Date.now() });
      const res = await request(app)
        .delete(`/api/servers/${serverId}/roles/${foreignRole}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
      expect(await db.roles.findOne({ _id: foreignRole })).not.toBeNull();
    });
  });

  describe('POST /api/servers/:sid/roles/:roleId/assign', () => {
    let roleId: string;
    beforeEach(async () => {
      const r = await db.roles.insert({ _id: uuidv4(), serverId, name: 'R', color: '#fff', permissions: [], createdAt: Date.now() });
      roleId = r._id;
    });

    it('owner can assign role to member', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/members/${memberId}/roles`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ roleId });
      expect(res.status).toBe(200);
    });

    it('returns 400 when assigning to non-member', async () => {
      const stranger = uuidv4();
      const res = await request(app)
        .post(`/api/servers/${serverId}/members/${stranger}/roles`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ roleId });
      expect([400, 404]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/roles`);
    expect(res.status).toBe(401);
  });
});
