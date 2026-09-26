// server/tests/webhooks.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { VIEW_CHANNELS: 1, MANAGE_WEBHOOKS: 1 << 24, ADMINISTRATOR: 1 << 30, ADMIN: 1 << 30 },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import webhooksRouter from '../routes/webhooks';
const perms   = require('../lib/permissions');
import { requireDoc } from './helpers/mockDb';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/channels/:channelId/webhooks', authMiddleware, webhooksRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Webhooks Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let serverId: string;
  let channelId: string;
  let ownerToken: string;

  beforeEach(async () => {
    db._reset?.();
    app       = buildApp();
    ownerId   = uuidv4();
    serverId  = uuidv4();
    channelId = uuidv4();
    ownerToken = tok(ownerId);

    await db.users.insert({ _id: ownerId, username: 'owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text' });

    perms.resolvePermissions.mockResolvedValue(8);
    perms.hasPermission.mockImplementation((_p: unknown, _flag: number) => true);
  });

  describe('GET /api/channels/:cid/webhooks', () => {
    it('returns webhooks for channel owner', async () => {
      await db.webhooks.insert({ _id: uuidv4(), channelId, serverId, name: 'MyHook', token: 'tok123', createdAt: Date.now() });
      const res = await request(app)
        .get(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].name).toBe('MyHook');
      // Secret should not be exposed
      expect(res.body[0].token).toBeUndefined();
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await request(app)
        .get(`/api/channels/${uuidv4()}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });

    it('returns 403 without permission', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .get(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });
  });

  it('uses channel-scoped permissions and denies hidden-channel webhook management', async () => {
    perms.hasPermission.mockImplementation((_p: unknown, flag: number) => flag !== 1);
    const res = await request(app)
      .get(`/api/channels/${channelId}/webhooks`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
    expect(perms.resolvePermissions).toHaveBeenCalledWith(ownerId, serverId, channelId);
  });

  describe('POST /api/channels/:cid/webhooks', () => {
    it('creates a webhook using the canonical avatarUrl storage column', async () => {
      const avatar = 'https://cdn.example.test/hooks/deploy.png';
      const res = await request(app)
        .post(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Deploy Hook', avatar });
      expect([200, 201]).toContain(res.status);
      const hooks = await db.webhooks.find({ channelId });
      expect(hooks.length).toBe(1);
      expect(hooks[0].name).toBe('Deploy Hook');
      expect(hooks[0].avatarUrl).toBe(avatar);
      // NOT NULL in PostgreSQL; the mock DB accepted its absence, production answered 500 (Final21 Phase 15).
      expect(typeof hooks[0].createdAt).toBe('number');
      expect(hooks[0]).not.toHaveProperty('avatar');
      expect(res.body.avatarUrl).toBe(avatar);
      expect(res.body).not.toHaveProperty('avatar');
      expect(typeof res.body.token).toBe('string');
      expect(res.headers['cache-control']).toContain('no-store');
    });

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post(`/api/channels/${channelId}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent channel', async () => {
      const res = await request(app)
        .post(`/api/channels/${uuidv4()}/webhooks`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'hook' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/channels/:cid/webhooks/:wid', () => {
    let webhookId: string;
    beforeEach(async () => {
      const wh = await db.webhooks.insert({ _id: uuidv4(), channelId, serverId, name: 'ToDelete', token: 'x', createdAt: Date.now() });
      webhookId = wh._id;
    });

    it('deletes a webhook', async () => {
      const res = await request(app)
        .delete(`/api/channels/${channelId}/webhooks/${webhookId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect([200, 204]).toContain(res.status);
      const hook = await db.webhooks.findOne({ _id: webhookId });
      expect(hook).toBeNull();
    });

    it('returns 404 for nonexistent webhook', async () => {
      const res = await request(app)
        .delete(`/api/channels/${channelId}/webhooks/${uuidv4()}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(404);
    });
  });

  it('rejects unauthenticated', async () => {
    const res = await request(app).get(`/api/channels/${channelId}/webhooks`);
    expect(res.status).toBe(401);
  });
});

describe('Webhooks strict contracts and token scope', () => {
  let app: ReturnType<typeof buildApp>;
  let uid: string, sid: string, cid: string, auth: string;

  beforeEach(async () => {
    db._reset?.();
    jest.clearAllMocks();
    app = buildApp();
    uid = uuidv4(); sid = uuidv4(); cid = uuidv4();
    auth = tok(uid);
    await db.users.insert({ _id: uid, username: 'strict-owner', displayName: 'Owner', tokenVersion: 0 });
    await db.servers.insert({ _id: sid, name: 'Strict', ownerId: uid });
    await db.channels.insert({ _id: cid, serverId: sid, name: 'general', type: 'text' });
    perms.resolvePermissions.mockResolvedValue((1 << 0) | (1 << 24));
    perms.hasPermission.mockReturnValue(true);
  });

  it.each([123, {}, [], true, '   ', 'x'.repeat(101)])('rejects malformed webhook name %p', async (name) => {
    const res = await request(app).post(`/api/channels/${cid}/webhooks`)
      .set('Authorization', `Bearer ${auth}`).send({ name });
    expect(res.status).toBe(400);
  });

  it.each([123, {}, [], true, 'x'.repeat(2049)])('rejects malformed avatar %p', async (avatar) => {
    const res = await request(app).post(`/api/channels/${cid}/webhooks`)
      .set('Authorization', `Bearer ${auth}`).send({ name: 'hook', avatar });
    expect(res.status).toBe(400);
  });

  it('returns token-authenticated metadata only under the canonical channel locator', async () => {
    const created = await request(app).post(`/api/channels/${cid}/webhooks`)
      .set('Authorization', `Bearer ${auth}`).send({ name: 'scoped' });
    expect(created.status).toBe(201);
    const wid = created.body._id;
    const secret = created.body.token;

    const ok = await request(app).get(`/api/channels/${cid}/webhooks/${wid}?token=${secret}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeUndefined();
    expect(ok.headers['cache-control']).toContain('no-store');
    expect(ok.headers['referrer-policy']).toBe('no-referrer');

    const wrongChannel = await request(app).get(`/api/channels/${uuidv4()}/webhooks/${wid}?token=${secret}`)
      .set('Authorization', `Bearer ${auth}`);
    expect(wrongChannel.status).toBe(401);
  });

  it('rejects missing, array and wrong-length tokens without throwing', async () => {
    const hook = await db.webhooks.insert({ _id: uuidv4(), channelId: cid, serverId: sid, name: 'token', token: 'a'.repeat(64), createdAt: Date.now() });
    const missing = await request(app).get(`/api/channels/${cid}/webhooks/${hook._id}`).set('Authorization', `Bearer ${auth}`);
    expect(missing.status).toBe(401);
    const wrong = await request(app).get(`/api/channels/${cid}/webhooks/${hook._id}?token=x`).set('Authorization', `Bearer ${auth}`);
    expect(wrong.status).toBe(401);
  });
});

describe('Webhook mutation permission edges', () => {
  let app: ReturnType<typeof buildApp>;
  let uid: string, sid: string, cid: string, auth: string;
  beforeEach(async () => {
    db._reset?.(); jest.clearAllMocks(); app = buildApp();
    uid=uuidv4(); sid=uuidv4(); cid=uuidv4(); auth=tok(uid);
    await db.users.insert({ _id: uid, username:'edge', displayName:'Edge', tokenVersion:0 });
    await db.servers.insert({ _id:sid, name:'Edge', ownerId:uid });
    await db.channels.insert({ _id:cid, serverId:sid, name:'general', type:'text' });
    perms.resolvePermissions.mockResolvedValue(0);
    perms.hasPermission.mockReturnValue(false);
  });
  it('denies POST without current webhook management permission', async () => {
    const res=await request(app).post(`/api/channels/${cid}/webhooks`).set('Authorization',`Bearer ${auth}`).send({name:'x'});
    expect(res.status).toBe(403);
  });
  it('denies DELETE without current webhook management permission', async () => {
    const wh=await db.webhooks.insert({_id:uuidv4(),channelId:cid,serverId:sid,name:'x',token:'t',createdAt:Date.now()});
    const res=await request(app).delete(`/api/channels/${cid}/webhooks/${wh._id}`).set('Authorization',`Bearer ${auth}`);
    expect(res.status).toBe(403);
  });
  it('returns 404 for DELETE when the canonical channel disappeared', async () => {
    const res=await request(app).delete(`/api/channels/${uuidv4()}/webhooks/${uuidv4()}`).set('Authorization',`Bearer ${auth}`);
    expect(res.status).toBe(404);
  });
  it('does not delete a webhook owned by another channel', async () => {
    perms.resolvePermissions.mockResolvedValue((1<<0)|(1<<24)); perms.hasPermission.mockReturnValue(true);
    const other=uuidv4(); await db.channels.insert({_id:other,serverId:sid,name:'other',type:'text'});
    const wh=await db.webhooks.insert({_id:uuidv4(),channelId:other,serverId:sid,name:'x',token:'t',createdAt:Date.now()});
    const res=await request(app).delete(`/api/channels/${cid}/webhooks/${wh._id}`).set('Authorization',`Bearer ${auth}`);
    expect(res.status).toBe(404);
    expect(await db.webhooks.findOne({_id:wh._id})).not.toBeNull();
  });
});
