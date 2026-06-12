// server/tests/roles.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret';
process.env.REFRESH_SECRET = 'test-refresh-secret';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import rolesRouter from '../routes/roles';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers/:sid/roles', authMiddleware, rolesRouter);
  return app;
}
function tok(uid) { return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Roles Routes', () => {
  let app, ownerId, memberId, serverId, ownerToken, memberToken;

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
        .send({ name: 'Moderator', color: '#ff0000', permissions: ['KICK_MEMBERS'] });
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
    let roleId;
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
    let roleId;
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
  });

  describe('POST /api/servers/:sid/roles/:roleId/assign', () => {
    let roleId;
    beforeEach(async () => {
      const r = await db.roles.insert({ _id: uuidv4(), serverId, name: 'R', color: '#fff', permissions: [], createdAt: Date.now() });
      roleId = r._id;
    });

    it('owner can assign role to member', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: memberId });
      expect(res.status).toBe(200);
    });

    it('returns 400 when assigning to non-member', async () => {
      const stranger = uuidv4();
      const res = await request(app)
        .post(`/api/servers/${serverId}/roles/${roleId}/assign`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userId: stranger });
      expect([400, 404]).toContain(res.status);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/servers/${serverId}/roles`);
    expect(res.status).toBe(401);
  });
});
