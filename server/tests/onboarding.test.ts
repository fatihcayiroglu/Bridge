// server/tests/onboarding.test.ts
process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/permissions', () => ({
  resolvePermissions: jest.fn(),
  hasPermission:      jest.fn(),
  PERMS: { MANAGE_SERVER: 8, ADMINISTRATOR: 1 << 30 },
}));

import request from 'supertest';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
const db      = require('../db/loader');
const jwt     = require('jsonwebtoken');
import { authMiddleware } from '../middleware/auth';
import onboardingRouter from '../routes/onboarding';
const perms   = require('../lib/permissions');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', authMiddleware, onboardingRouter);
  return app;
}
function tok(uid: string, v = 0) { return jwt.sign({ id: uid, v }, process.env.JWT_SECRET, { expiresIn: '1h' }); }

describe('Onboarding Routes', () => {
  let app: express.Express;
  let ownerId: string;
  let memberId: string;
  let serverId: string;
  let ownerToken: string;
  let memberToken: string;

  beforeEach(async () => {
    db._reset?.();
    app      = buildApp();
    ownerId  = uuidv4();
    memberId = uuidv4();
    serverId = uuidv4();
    ownerToken  = tok(ownerId);
    memberToken = tok(memberId);

    await db.users.insert({ _id: ownerId,  username: 'owner',  displayName: 'Owner',  tokenVersion: 0 });
    await db.users.insert({ _id: memberId, username: 'member', displayName: 'Member', tokenVersion: 0 });
    await db.servers.insert({ _id: serverId, name: 'TestServer', ownerId });
    await db.members.insert({ userId: ownerId,  serverId, roles: [] });
    await db.members.insert({ userId: memberId, serverId, roles: [] });
    await db.channels.insert({ _id: uuidv4(), serverId, name: 'rules', type: 'text' });

    perms.resolvePermissions.mockResolvedValue(8);
    perms.hasPermission.mockReturnValue(true);
  });

  describe('GET /api/servers/:sid/onboarding', () => {
    it('returns default onboarding config for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('enabled');
      expect(res.body).toHaveProperty('channels');
    });

    it('returns saved onboarding config', async () => {
      await db.serverOnboarding.insert({ _id: uuidv4(), serverId, enabled: true, welcomeMessage: 'Hey {user}!', defaultRoles: '[]', questions: '[]' });
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.welcomeMessage).toBe('Hey {user}!');
    });

    it('returns 403 for non-member', async () => {
      const strangeId = uuidv4();
      await db.users.insert({ _id: strangeId, username: 'x', displayName: 'X', tokenVersion: 0 });
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${tok(strangeId)}`);
      expect(res.status).toBe(403);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).get(`/api/servers/${serverId}/onboarding`);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/servers/:sid/onboarding', () => {
    it('saves onboarding config for admin', async () => {
      const res = await request(app)
        .put(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ enabled: true, welcomeMessage: 'Welcome {user}!', defaultRoles: [], questions: [] });
      expect([200, 201]).toContain(res.status);
      expect(res.body.ok || res.body.enabled !== undefined).toBeTruthy();
    });

    it('returns 403 without MANAGE_SERVER', async () => {
      perms.hasPermission.mockReturnValue(false);
      const res = await request(app)
        .put(`/api/servers/${serverId}/onboarding`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/servers/:sid/onboarding/status', () => {
    it('returns completion status for member', async () => {
      const res = await request(app)
        .get(`/api/servers/${serverId}/onboarding/status`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect([200, 404]).toContain(res.status);
    });
  });

  describe('POST /api/servers/:sid/onboarding/complete', () => {
    it('marks onboarding as complete for member', async () => {
      const res = await request(app)
        .post(`/api/servers/${serverId}/onboarding/complete`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ answers: [] });
      expect([200, 201]).toContain(res.status);
    });

    it('returns 403 for non-member', async () => {
      const strangeId = uuidv4();
      await db.users.insert({ _id: strangeId, username: 'x2', displayName: 'X2', tokenVersion: 0 });
      const res = await request(app)
        .post(`/api/servers/${serverId}/onboarding/complete`)
        .set('Authorization', `Bearer ${tok(strangeId)}`)
        .send({ answers: [] });
      expect(res.status).toBe(403);
    });
  });
});

describe('Onboarding canonical scope + idempotent completion', () => {
  let uid: string;
  let sid: string;
  let app2: ReturnType<typeof buildApp>;
  let otherSid: string;
  let auth: string;
  beforeEach(async () => {
    db._reset?.(); jest.clearAllMocks(); app2=buildApp();
    uid=uuidv4(); sid=uuidv4(); otherSid=uuidv4(); auth=tok(uid);
    await db.users.insert({_id:uid,username:'scope-user',displayName:'Scope User',tokenVersion:0});
    await db.servers.insert({_id:sid,name:'Scope',ownerId:uid});
    await db.servers.insert({_id:otherSid,name:'Other',ownerId:'other-owner'});
    await db.members.insert({userId:uid,serverId:sid,roles:[]});
    perms.resolvePermissions.mockResolvedValue(8); perms.hasPermission.mockReturnValue(true);
  });

  it.each([
    { enabled: 'false' },
    { rulesChannelId: 7 },
    { welcomeChannelId: {} },
    { welcomeMessage: 5 },
    { verificationLevel: '3x' },
    { verificationLevel: -1 },
    { defaultRoles: 'role' },
    { defaultRoles: [7] },
    { questions: {} },
    { questions: new Array(6).fill({q:'x'}) },
  ])('rejects malformed configuration %#', async body => {
    const res=await request(app2).put(`/api/servers/${sid}/onboarding`).set('Authorization',`Bearer ${auth}`).send(body);
    expect(res.status).toBe(400);
  });

  it('rejects cross-server or non-text onboarding channel locators', async () => {
    const foreign=uuidv4(); const voice=uuidv4();
    await db.channels.insert({_id:foreign,serverId:otherSid,name:'foreign',type:'text'});
    await db.channels.insert({_id:voice,serverId:sid,name:'voice',type:'voice'});
    const cross=await request(app2).put(`/api/servers/${sid}/onboarding`).set('Authorization',`Bearer ${auth}`).send({enabled:true,welcomeChannelId:foreign});
    expect(cross.status).toBe(400);
    const wrongType=await request(app2).put(`/api/servers/${sid}/onboarding`).set('Authorization',`Bearer ${auth}`).send({enabled:true,welcomeChannelId:voice});
    expect(wrongType.status).toBe(400);
  });

  it('rejects default roles that do not canonically belong to this server', async () => {
    const foreignRole=uuidv4(); await db.roles.insert({_id:foreignRole,serverId:otherSid,name:'foreign',permissions:0,position:1});
    const res=await request(app2).put(`/api/servers/${sid}/onboarding`).set('Authorization',`Bearer ${auth}`).send({enabled:true,defaultRoles:[foreignRole]});
    expect(res.status).toBe(400);
  });

  it('stores only canonical role/channel ids and completes exactly once', async () => {
    const welcome=uuidv4(), role=uuidv4();
    await db.channels.insert({_id:welcome,serverId:sid,name:'welcome',type:'text'});
    await db.roles.insert({_id:role,serverId:sid,name:'newcomer',permissions:0,position:1});
    const put=await request(app2).put(`/api/servers/${sid}/onboarding`).set('Authorization',`Bearer ${auth}`)
      .send({enabled:true,welcomeChannelId:welcome,welcomeMessage:'Welcome {user} to {server}',defaultRoles:[role,role],questions:[{id:'q1'}],verificationLevel:2});
    expect(put.status).toBe(200);

    const first=await request(app2).post(`/api/servers/${sid}/onboarding/complete`).set('Authorization',`Bearer ${auth}`).send({answers:{q1:'yes'}});
    expect(first.status).toBe(200); expect(first.body.alreadyCompleted).toBeUndefined();
    const member=await db.members.findOne({userId:uid,serverId:sid});
    expect(member.roles).toContain(role);
    const welcomeRows=await db.messages.find({channelId:welcome});
    expect(welcomeRows).toHaveLength(1);
    expect(welcomeRows[0].content).toContain('@Scope User');

    const second=await request(app2).post(`/api/servers/${sid}/onboarding/complete`).set('Authorization',`Bearer ${auth}`).send({answers:{q1:'again'}});
    expect(second.status).toBe(200); expect(second.body.alreadyCompleted).toBe(true);
    expect(await db.messages.find({channelId:welcome})).toHaveLength(1);
    const completions=await db.onboardingCompletions.find({serverId:sid,userId:uid});
    expect(completions).toHaveLength(1);
  });

  it('revalidates stale stored role/channel authority at execution time', async () => {
    const foreignWelcome=uuidv4(), foreignRole=uuidv4();
    await db.channels.insert({_id:foreignWelcome,serverId:otherSid,name:'foreign',type:'text'});
    await db.roles.insert({_id:foreignRole,serverId:otherSid,name:'foreign',permissions:0,position:1});
    await db.serverOnboarding.insert({_id:uuidv4(),serverId:sid,enabled:true,welcomeChannelId:foreignWelcome,welcomeMessage:'x',defaultRoles:JSON.stringify([foreignRole]),questions:'[]',createdAt:Date.now()});
    const res=await request(app2).post(`/api/servers/${sid}/onboarding/complete`).set('Authorization',`Bearer ${auth}`).send({answers:{}});
    expect(res.status).toBe(200); expect(res.body.welcomeSkipped).toBe(true);
    const member=await db.members.findOne({userId:uid,serverId:sid});
    expect(member.roles).toEqual([]);
    expect(await db.messages.find({channelId:foreignWelcome})).toHaveLength(0);
  });

  it('reports completion status from the real onboarding_completions owner', async () => {
    await db.serverOnboarding.insert({_id:uuidv4(),serverId:sid,enabled:true,questions:'[]',defaultRoles:'[]',createdAt:Date.now()});
    await db.onboardingCompletions.insert({_id:uuidv4(),serverId:sid,userId:uid,completedAt:123,answers:{}});
    const res=await request(app2).get(`/api/servers/${sid}/onboarding/status`).set('Authorization',`Bearer ${auth}`);
    expect(res.status).toBe(200); expect(res.body).toMatchObject({required:true,completed:true,completedAt:123});
  });
});
