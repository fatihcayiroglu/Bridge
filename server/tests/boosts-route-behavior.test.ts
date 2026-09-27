process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';

const boostMocks = {
  getServerBoostInfo: jest.fn(), getBoosters: jest.fn(), getActiveBoost: jest.fn(),
  addBoost: jest.fn(), countActiveBoosts: jest.fn(), updateBoostStats: jest.fn(),
  removeBoost: jest.fn(), getByVanityUrl: jest.fn(), getServerOwnerAndTier: jest.fn(),
  checkVanityConflict: jest.fn(), getHighestActiveTierForUser: jest.fn(),
  mutateVanityAtomic: jest.fn(), getLiveVanityServer: jest.fn(),
};
const memberFindOne = jest.fn();

jest.mock('../db/repositories/BoostRepository.js', () => ({ Boosts: boostMocks }));
jest.mock('../db/repositories/MemberRepository', () => ({ __esModule: true, default: { findOne: memberFindOne } }));
jest.mock('../middleware/rateLimit', () => ({ limits: { api: () => (_req: unknown, _res: unknown, next: () => void) => next() } }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (
    // `x-user` basligi da OKUNUYOR; yuzey bunu yazmali.
    req: { headers: { authorization?: string }; header(name: string): string | undefined; user?: unknown },
    res: { status: (c: number) => { json: (b: unknown) => unknown } },
    next: () => void,
  ) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'No token' });
    // `req.header(name)` HTTP semantigine uygun (buyuk/kucuk harf duyarsiz)
    // ve tipi `string | undefined`; sozluk indekslemesi ortuk `any` veriyordu.
    req.user = { id: req.header('x-user') ?? 'user-1', username: 'u', v: 0 };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { router } from '../routes/boosts';

const app = express();
app.use(express.json());
app.use('/api/servers', router);
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));

const authed = (r: request.Test, user='user-1') => r.set('Authorization','Bearer x').set('x-user', user);

beforeEach(() => {
  jest.clearAllMocks();
  boostMocks.getServerBoostInfo.mockResolvedValue({ boostCount: 0, boostTier: 0 });
  boostMocks.getBoosters.mockResolvedValue([]);
  boostMocks.getActiveBoost.mockResolvedValue(null);
  boostMocks.addBoost.mockResolvedValue(true);
  boostMocks.countActiveBoosts.mockResolvedValue(1);
  boostMocks.updateBoostStats.mockResolvedValue(undefined);
  boostMocks.removeBoost.mockResolvedValue(undefined);
  boostMocks.getServerOwnerAndTier.mockResolvedValue({ ownerId: 'user-1', boostTier: 3 });
  boostMocks.checkVanityConflict.mockResolvedValue(false);
  boostMocks.mutateVanityAtomic.mockResolvedValue('ok');
  memberFindOne.mockResolvedValue({ userId: 'user-1', serverId: 'srv' });
});

describe('boost route authority and live-tier contract', () => {
  it('requires auth and current membership to list boosters', async () => {
    expect((await request(app).get('/api/servers/srv/boosts')).status).toBe(401);
    memberFindOne.mockResolvedValueOnce(null);
    expect((await authed(request(app).get('/api/servers/srv/boosts'))).status).toBe(403);
    memberFindOne.mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv', banned: true });
    expect((await authed(request(app).get('/api/servers/srv/boosts'))).status).toBe(403);
    expect(boostMocks.getBoosters).not.toHaveBeenCalled();
  });

  it('lists live boost info for a member', async () => {
    boostMocks.getServerBoostInfo.mockResolvedValueOnce({ boostCount: 7, boostTier: 2 });
    boostMocks.getBoosters.mockResolvedValueOnce([{ userId: 'a', boostedAt: 1 }]);
    const res = await authed(request(app).get('/api/servers/srv/boosts'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 7, tier: 2, uploadLimitMB: 50, audioBitrate: 256 });
  });

  it('requires server existence and membership before creating a boost', async () => {
    boostMocks.getServerBoostInfo.mockResolvedValueOnce(null);
    expect((await authed(request(app).post('/api/servers/missing/boosts'))).status).toBe(404);
    memberFindOne.mockResolvedValueOnce(null);
    expect((await authed(request(app).post('/api/servers/srv/boosts'))).status).toBe(403);
    memberFindOne.mockResolvedValueOnce({ userId: 'user-1', serverId: 'srv', banned: true });
    expect((await authed(request(app).post('/api/servers/srv/boosts'))).status).toBe(403);
    expect(boostMocks.addBoost).not.toHaveBeenCalled();
  });

  it('rejects an existing boost and also rejects the concurrent insert loser', async () => {
    boostMocks.getActiveBoost.mockResolvedValueOnce({ _id: 'b1' });
    expect((await authed(request(app).post('/api/servers/srv/boosts'))).status).toBe(409);
    boostMocks.getActiveBoost.mockResolvedValueOnce(null);
    boostMocks.addBoost.mockResolvedValueOnce(false);
    expect((await authed(request(app).post('/api/servers/srv/boosts'))).status).toBe(409);
  });

  it('creates a boost and recomputes tier from live count', async () => {
    boostMocks.countActiveBoosts.mockResolvedValueOnce(14);
    const res = await authed(request(app).post('/api/servers/srv/boosts'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 14, tier: 3 });
    expect(boostMocks.updateBoostStats).toHaveBeenCalledWith('srv', 14, 3);
    expect(boostMocks.addBoost.mock.calls[0][2]).toBeGreaterThan(Date.now() + 29 * 24 * 60 * 60 * 1000);
  });

  it('allows a former member to cancel their own boost but rejects a missing server', async () => {
    memberFindOne.mockResolvedValue(null);
    const ok = await authed(request(app).delete('/api/servers/srv/boosts'));
    expect(ok.status).toBe(200);
    expect(boostMocks.removeBoost).toHaveBeenCalledWith('srv', 'user-1');
    boostMocks.getServerBoostInfo.mockResolvedValueOnce(null);
    expect((await authed(request(app).delete('/api/servers/nope/boosts'))).status).toBe(404);
  });

  it('normalizes public vanity lookup and returns 404 when absent', async () => {
    boostMocks.getByVanityUrl.mockResolvedValueOnce({ _id:'srv', name:'S', icon:'', description:'' });
    expect((await request(app).get('/api/servers/vanity/My-Slug')).status).toBe(200);
    expect(boostMocks.getByVanityUrl).toHaveBeenCalledWith('my-slug');
    boostMocks.getByVanityUrl.mockResolvedValueOnce(null);
    expect((await request(app).get('/api/servers/vanity/nope')).status).toBe(404);
  });

  it('maps atomic vanity authority/entitlement outcomes and strictly validates body', async () => {
    boostMocks.mutateVanityAtomic.mockResolvedValueOnce('not_found');
    expect((await authed(request(app).patch('/api/servers/x/vanity').send({ vanityUrl:'abc' }))).status).toBe(404);
    boostMocks.mutateVanityAtomic.mockResolvedValueOnce('forbidden');
    expect((await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'abc' }))).status).toBe(403);
    boostMocks.mutateVanityAtomic.mockResolvedValueOnce('boost_required');
    const tier = await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'abc' }));
    expect(tier.status).toBe(403);
    expect(tier.body.code).toBe('BOOST_REQUIRED');
    expect((await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:{x:1} }))).status).toBe(400);
    expect((await authed(request(app).patch('/api/servers/srv/vanity').send({}))).status).toBe(400);
    expect((await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'' }))).status).toBe(400);
  });

  it('allows clear without tier, rejects invalid/reserved/conflicting vanity, and stores canonical slug atomically', async () => {
    let res = await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:null }));
    expect(res.status).toBe(200);
    expect(boostMocks.mutateVanityAtomic).toHaveBeenCalledWith('srv', 'user-1', null);

    res = await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'A!' }));
    expect(res.status).toBe(400);
    res = await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'admin' }));
    expect(res.status).toBe(400);
    boostMocks.mutateVanityAtomic.mockResolvedValueOnce('conflict');
    res = await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'Taken-Slug' }));
    expect(res.status).toBe(409);
    res = await authed(request(app).patch('/api/servers/srv/vanity').send({ vanityUrl:'  Nice-Slug  ' }));
    expect(res.status).toBe(200);
    expect(boostMocks.mutateVanityAtomic).toHaveBeenLastCalledWith('srv','user-1','nice-slug');
  });
});
