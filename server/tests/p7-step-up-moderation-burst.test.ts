// server/tests/p7-step-up-moderation-burst.test.ts
//
// P7 B2 — destructive moderation (bans, kicks on both routes, bulk message
// delete) is unprompted up to the measured burst (5 actions / 60 s / actor),
// then needs ONE `moderation-burst` proof, after which the cleanup continues
// for the grant's lifetime. Runs the real routers, the real authMiddleware and
// the REAL route limiters (production defaults: moderation 30/min, roles
// 20/min), so it also proves the step-up fires before any limiter rejects.
// Lab evidence: scripts/stepup-lab (SU-ATK-08, SU-LEG-01, SU-LEG-02).

delete process.env.RL_MODERATION_MAX;
delete process.env.RL_ROLES_MAX;

import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: jest.fn().mockResolvedValue(0) }));

const request = require('supertest');
import db from '../db/loader';
import { makeToken } from '../middleware/auth';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';
import moderationRouter from '../routes/moderation';
import { router as rolesRouter } from '../routes/roles';
import messagesRouter from '../routes/messages';
import stepUpRouter from '../routes/stepUp';
import { STEP_UP_POLICY, mintSignInGrants } from '../lib/stepUp';
import { stepUpHeader } from './helpers/stepUp';
import { _socketRateStore } from '../socket/socketRateLimit';

type Row = Record<string, unknown>;
const store = db as unknown as Record<string, { insert(d: Row): Promise<unknown>; findOne(q: Row): Promise<Row | null> }>;

function buildApp() {
  const app = express();
  app.use(express.json());
  // Production mount order (app/setupRoutes.ts): roles before moderation on /servers.
  app.use('/api/servers', rolesRouter);
  app.use('/api/servers/:serverId', moderationRouter);
  app.use('/api/channels', messagesRouter);
  app.use('/api/step-up', stepUpRouter);
  return app;
}

let PASSWORD_HASH = '';
let app: ReturnType<typeof buildApp>;

interface World { serverId: string; channelId: string; owner: { id: string; token: string }; members: string[] }

async function world(memberCount = 50): Promise<World> {
  const serverId = uuidv4();
  const channelId = uuidv4();
  const ownerId = uuidv4();
  await store.users.insert({ _id: ownerId, username: `mod-${ownerId.slice(0, 6)}`, displayName: 'Mod', password: PASSWORD_HASH, tokenVersion: 0 });
  await store.servers.insert({ _id: serverId, name: 'Raided', ownerId, createdAt: Date.now() });
  await store.channels.insert({ _id: channelId, serverId, name: 'general', type: 'text', createdAt: Date.now() });
  await store.members.insert({ userId: ownerId, serverId, roles: '[]', joinedAt: Date.now() });
  const members: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const id = uuidv4();
    await store.users.insert({ _id: id, username: `raider-${i}-${id.slice(0, 4)}`, displayName: `Raider ${i}`, tokenVersion: 0 });
    await store.members.insert({ userId: id, serverId, roles: '[]', joinedAt: Date.now() });
    members.push(id);
  }
  return { serverId, channelId, owner: { id: ownerId, token: makeToken({ _id: ownerId, username: 'mod', tokenVersion: 0 }) }, members };
}

const ban = (w: World, target: string, headers: Record<string, string> = {}) =>
  request(app).post(`/api/servers/${w.serverId}/bans`).set('Authorization', `Bearer ${w.owner.token}`).set(headers).send({ userId: target });
const kick = (w: World, target: string, headers: Record<string, string> = {}) =>
  request(app).post(`/api/servers/${w.serverId}/members/${target}/kick`).set('Authorization', `Bearer ${w.owner.token}`).set(headers).send({});

async function bulkDelete(w: World, headers: Record<string, string> = {}) {
  const ids = [uuidv4(), uuidv4()];
  for (const _id of ids) {
    await store.messages.insert({ _id, serverId: w.serverId, channelId: w.channelId, userId: w.members[0], content: 'spam', createdAt: Date.now() });
  }
  return request(app).delete('/api/channels/bulk').set('Authorization', `Bearer ${w.owner.token}`).set(headers).send({ ids, serverId: w.serverId });
}

const banned = async (w: World, userId: string) =>
  Boolean(await store.bans?.findOne({ serverId: w.serverId, userId }) ?? null) ||
  !(await store.members.findOne({ serverId: w.serverId, userId }));

beforeAll(async () => { PASSWORD_HASH = await bcrypt.hash('correct horse', 4); delete process.env.REDIS_URL; });
beforeEach(() => {
  _resetRateLimitStoreForTest();
  _socketRateStore.clear();
  app = buildApp();
});

describe('P7 B2 moderation burst (5 destructive actions / 60 s / actor)', () => {
  it('uses the approved threshold, far below the route limiters', () => {
    expect(STEP_UP_POLICY.moderationBurst).toEqual({ max: 5, windowMs: 60_000 });
  });

  it('SU-LEG-01: ordinary moderation (3 bans handling reports) is never asked for a proof', async () => {
    const w = await world(3);
    for (const target of w.members) expect((await ban(w, target)).status).toBe(200);
  });

  it('SU-LEG-02: a raid cleanup is asked ONCE at the 6th action, then continues after one proof', async () => {
    const w = await world(30);
    for (const target of w.members.slice(0, 5)) expect((await ban(w, target)).status).toBe(200);

    const sixth = await ban(w, w.members[5]!);
    expect(sixth.status).toBe(403);
    expect(sixth.body).toEqual({
      error: 'STEP_UP_REQUIRED',
      action: 'moderation.ban',
      scope: 'moderation-burst',
      reasons: ['moderation_burst', 'step_up_missing'],
      why: expect.stringMatching(/stolen moderator session/),
      level: 1,
      methods: ['password', 'sign_in'],
      ttlMs: 600_000,
    });
    expect(await banned(w, w.members[5]!)).toBe(false);

    const proof = await request(app).post('/api/step-up/password').set('Authorization', `Bearer ${w.owner.token}`)
      .send({ password: 'correct horse', scope: 'moderation-burst' }).expect(200);
    const grant = { 'x-bridge-step-up': proof.body.stepUp.token as string };
    // 6 requests so far + 1 proof; the remaining 23 bans fit the unchanged 30/min limiter.
    for (const target of w.members.slice(5, 28)) expect((await ban(w, target, grant)).status).toBe(200);
  });

  it('SU-ATK-08: a stolen moderator session is stopped at 5 — by STEP_UP_REQUIRED, before the 30/min limiter', async () => {
    const w = await world(40);
    const statuses: number[] = [];
    const errors: string[] = [];
    for (const target of w.members) {
      const r = await ban(w, target);
      statuses.push(r.status);
      if (r.status !== 200) errors.push(String(r.body.error));
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    // The 6th..30th requests are explainable step-up refusals; the limiter only takes over after 30.
    expect(statuses.slice(5, 30).every((s) => s === 403)).toBe(true);
    expect(errors.slice(0, 25).every((e) => e === 'STEP_UP_REQUIRED')).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
  });

  it('bans, kicks (roles route) and bulk deletes share one per-actor counter', async () => {
    const w = await world(10);
    expect((await ban(w, w.members[0]!)).status).toBe(200);
    expect((await kick(w, w.members[1]!)).status).toBe(200);
    expect((await bulkDelete(w)).status).toBe(200);
    expect((await ban(w, w.members[2]!)).status).toBe(200);
    expect((await kick(w, w.members[3]!)).status).toBe(200);

    const kicked = await kick(w, w.members[4]!);
    expect(kicked.status).toBe(403);
    expect(kicked.body).toMatchObject({ error: 'STEP_UP_REQUIRED', action: 'moderation.kick', scope: 'moderation-burst' });
    expect(await store.members.findOne({ serverId: w.serverId, userId: w.members[4]! })).not.toBeNull();
    const bulk = await bulkDelete(w);
    expect(bulk.status).toBe(403);
    expect(bulk.body).toMatchObject({ action: 'messages.bulk_delete', scope: 'moderation-burst' });

    const grant = stepUpHeader(w.owner.id, 'moderation-burst', { method: 'password' });
    expect((await kick(w, w.members[4]!, grant)).status).toBe(200);
    expect((await bulkDelete(w, grant)).status).toBe(200);
  });

  it('a fresh sign-in already carries a moderation-burst grant: no friction for a correctly signed-in moderator', async () => {
    const w = await world(12);
    const signIn = mintSignInGrants({ _id: w.owner.id, tokenVersion: 0 }, 'password');
    const grant = { 'x-bridge-step-up': signIn.grants['moderation-burst'] };
    for (const target of w.members) expect((await ban(w, target, grant)).status).toBe(200);
  });

  it('a grant for another scope does not continue the burst', async () => {
    const w = await world(7);
    for (const target of w.members.slice(0, 5)) await ban(w, target);
    const r = await ban(w, w.members[5]!, stepUpHeader(w.owner.id, 'account-security', { method: 'password' }));
    expect(r.status).toBe(403);
    expect(r.body.reasons).toEqual(['moderation_burst', 'step_up_scope_mismatch']);
  });

  it('the counter is per actor: one moderator’s burst does not prompt another', async () => {
    const a = await world(6);
    const b = await world(6);
    for (const target of a.members.slice(0, 5)) await ban(a, target);
    expect((await ban(a, a.members[5]!)).status).toBe(403);
    for (const target of b.members.slice(0, 5)) expect((await ban(b, target)).status).toBe(200);
  });

  it('a member without the permission is told so and is never asked for a proof or counted', async () => {
    const w = await world(10);
    const outsiderId = uuidv4();
    await store.users.insert({ _id: outsiderId, username: 'outsider', displayName: 'Outsider', tokenVersion: 0, password: PASSWORD_HASH });
    await store.members.insert({ userId: outsiderId, serverId: w.serverId, roles: '[]', joinedAt: Date.now() });
    const token = makeToken({ _id: outsiderId, username: 'outsider', tokenVersion: 0 });
    for (const target of w.members.slice(0, 8)) {
      const r = await request(app).post(`/api/servers/${w.serverId}/bans`).set('Authorization', `Bearer ${token}`).send({ userId: target });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('No permission');
    }
  });
});
