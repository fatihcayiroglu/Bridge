// server/tests/admin-user-deletion-route.test.ts
//
// Final21 Faz 19 — routes/admin/users.ts yönetici hesap silme ucunun orkestrasyon sözleşmesi.
// Gerçek PostgreSQL üzerindeki uçtan uca davranış `tests/pg-integration/admin-account-deletion.pgtest.ts`
// içindedir. Burada her dal ölçülür: kök yok (503), sahiplik engeli (409, HİÇBİR silme yok),
// başarı (yönetici temizliği bayrağı, oturum iptali, canlı soket kesme, dosya bırakma hatası
// günlüğü, denetim kaydı) ve uygulayıcı hatası (500, denetim kaydı yok). Aynı yönlendiricideki
// liste/güncelleme/sunucu uçları da dal düzeyinde doğrulanır.

process.env.NODE_ENV = 'test';

const logAction = jest.fn(async () => undefined);
const disconnectLiveUserSessions = jest.fn(async () => undefined);
const ownershipBlockers = jest.fn();
const eraseAccountData = jest.fn();
const releaseAfterErasure = jest.fn();
const logError = jest.fn();
const repos = {
  Users: { findById: jest.fn(), update: jest.fn(async () => undefined), count: jest.fn(), searchPaginated: jest.fn() },
  Servers: { findRecentSorted: jest.fn(), findById: jest.fn(), deleteGraphAtomic: jest.fn() },
  Members: { findByServerIds: jest.fn() },
  Auth: { revokeAllForUser: jest.fn(async () => undefined) },
};
const fakeDb: { _pool?: unknown; _transaction: jest.Mock } = { _pool: undefined, _transaction: jest.fn() };

const invalidateTokenCache = jest.fn();
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'admin1', isAdmin: true }; next(); },
  _invalidateTokenCache: (id: string) => invalidateTokenCache(id),
}));
jest.mock('../lib/authSafe', () => ({ safeCastAuthed: (req: any) => ({ user: req.user }) }));
jest.mock('../middleware/rateLimit', () => ({ limits: { moderation: () => (_req: any, _res: any, next: any) => next() } }));
jest.mock('../routes/admin/middleware', () => ({ adminOnly: (_req: any, _res: any, next: any) => next(), logAction }));
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions }));
jest.mock('../lib/accountDeletion', () => ({ ownershipBlockers, eraseAccountData, releaseAfterErasure }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: logError, warn: jest.fn(), info: jest.fn() } }));
jest.mock('../db/repositories', () => repos);
jest.mock('../db/loader', () => ({ __esModule: true, default: fakeDb }));

import express from 'express';
import request from 'supertest';
import { usersRouter } from '../routes/admin/users';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', usersRouter);
  return a;
}
const pool = { query: jest.fn() };
const plan = { assetUrls: ['/uploads/avatars/a.png'], channelIds: ['c1'], repliesScrubbed: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  fakeDb._pool = pool;
  repos.Users.findById.mockImplementation(async (id: string) => (id === 'missing' ? null : { _id: id, username: `name-${id}` }));
  ownershipBlockers.mockResolvedValue([]);
  eraseAccountData.mockResolvedValue({ applied: [{ table: 'messages', disposition: 'PURGE_BY_ADMIN', rows: 2 }], plan });
  releaseAfterErasure.mockResolvedValue({ removed: 1, alreadyAbsent: 0, stillReferenced: 0, failed: 0 });
});

describe('DELETE /api/admin/users/:id', () => {
  it('404 for an unknown user and 400 for self-deletion — nothing touched', async () => {
    expect((await request(app()).delete('/api/admin/users/missing')).status).toBe(404);
    const self = await request(app()).delete('/api/admin/users/admin1');
    expect(self.status).toBe(400);
    expect(self.body.error).toBe('Cannot delete yourself');
    expect(ownershipBlockers).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED 503 without PostgreSQL (no pool, or a pool without query)', async () => {
    for (const p of [undefined, {}]) {
      fakeDb._pool = p;
      const res = await request(app()).delete('/api/admin/users/u1');
      expect(res.status).toBe(503);
    }
    expect(eraseAccountData).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('409 with blockers when the person still owns a shared server — no erasure, no revoke, no audit', async () => {
    const blockers = [{ kind: 'server', id: 's1', name: 'Team', memberCount: 4 }];
    ownershipBlockers.mockResolvedValue(blockers);
    const res = await request(app()).delete('/api/admin/users/u1');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'Ownership transfer required before deletion', blockers });
    expect(res.body.remedy).toMatch(/DELETE \/api\/admin\/servers/);
    expect(eraseAccountData).not.toHaveBeenCalled();
    expect(repos.Auth.revokeAllForUser).not.toHaveBeenCalled();
    expect(invalidateTokenCache).not.toHaveBeenCalled();
    expect(disconnectLiveUserSessions).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });

  it('success: canonical erasure with admin purge, then revoke → disconnect → release → audit', async () => {
    repos.Auth.revokeAllForUser.mockRejectedValueOnce(new Error('rows already gone'));   // tolerated
    releaseAfterErasure.mockImplementation(async (_p: unknown, _plan: unknown, onError: (url: string, err: unknown) => void) => {
      onError('/uploads/avatars/a.png', new Error('EACCES'));
      return { removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 1 };
    });
    const res = await request(app()).delete('/api/admin/users/u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      applied: [{ table: 'messages', disposition: 'PURGE_BY_ADMIN', rows: 2 }],
      profileAssets: { removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 1 },
    });
    expect(eraseAccountData).toHaveBeenCalledWith(pool, fakeDb._transaction, 'u1', { purgeChannelMessages: true });
    expect(disconnectLiveUserSessions).toHaveBeenCalledWith('u1', 'account_deleted_by_admin');
    // The deleted account's access token must not survive in the token-version cache.
    expect(invalidateTokenCache).toHaveBeenCalledWith('u1');
    expect(releaseAfterErasure).toHaveBeenCalledWith(pool, plan, expect.any(Function));
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ event: 'admin.user_delete.asset_release_failed', url: '/uploads/avatars/a.png' }), expect.any(String));
    expect(logAction).toHaveBeenCalledWith('admin1', 'delete_user', 'u1', { username: 'name-u1' });
    // Order: the account is gone before sessions are cut and files released.
    const order = [eraseAccountData, invalidateTokenCache, repos.Auth.revokeAllForUser, disconnectLiveUserSessions, releaseAfterErasure, logAction]
      .map((m) => m.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('500 when the erasure transaction fails — no session cut, no file release, no audit entry', async () => {
    eraseAccountData.mockRejectedValue(new Error('deadlock'));
    const res = await request(app()).delete('/api/admin/users/u1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Deletion failed' });
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ event: 'admin.user_delete.failed', userId: 'u1' }), expect.any(String));
    expect(disconnectLiveUserSessions).not.toHaveBeenCalled();
    expect(invalidateTokenCache).not.toHaveBeenCalled();
    expect(releaseAfterErasure).not.toHaveBeenCalled();
    expect(logAction).not.toHaveBeenCalled();
  });
});

describe('the rest of the admin users router', () => {
  it('GET /users searches with a regex filter, maps defaults and paginates; bad paging is 400', async () => {
    repos.Users.count.mockResolvedValue(3);
    repos.Users.searchPaginated.mockResolvedValue([
      { _id: 'u1', username: 'a', displayName: 'A', status: 'online', createdAt: 1 },
      { _id: 'u2', username: 'b', displayName: 'B', email: 'b@x', emailVerified: true, isAdmin: true, twoFactorEnabled: true, status: 'idle', createdAt: 2 },
    ]);
    const res = await request(app()).get('/api/admin/users?q=%20a%20&page=2&limit=2');
    expect(res.status).toBe(200);
    expect(repos.Users.count).toHaveBeenCalledWith({ $or: [{ username: { $regex: 'a' } }, { displayName: { $regex: 'a' } }, { email: { $regex: 'a' } }] });
    expect(repos.Users.searchPaginated).toHaveBeenCalledWith(expect.any(Object), { skip: 2, limit: 2 });
    expect(res.body).toMatchObject({ total: 3, page: 2, pages: 2 });
    expect(res.body.users[0]).toEqual({ _id: 'u1', username: 'a', displayName: 'A', email: null, emailVerified: false, isAdmin: false, twoFactorEnabled: false, status: 'online', createdAt: 1 });
    expect(res.body.users[1].isAdmin).toBe(true);

    repos.Users.count.mockClear();
    await request(app()).get('/api/admin/users');
    expect(repos.Users.count).toHaveBeenCalledWith({});
    expect((await request(app()).get('/api/admin/users?page=0')).status).toBe(400);
    expect((await request(app()).get('/api/admin/users?limit=abc')).status).toBe(400);
  });

  it('PATCH /users/:id: 404, self 400, non-boolean 400, success audited', async () => {
    expect((await request(app()).patch('/api/admin/users/missing').send({ isAdmin: true })).status).toBe(404);
    expect((await request(app()).patch('/api/admin/users/admin1').send({ isAdmin: true })).status).toBe(400);
    expect((await request(app()).patch('/api/admin/users/u1').send({ isAdmin: 'yes' })).status).toBe(400);
    expect((await request(app()).patch('/api/admin/users/u1').set('content-type', 'text/plain').send('x')).status).toBe(400);
    expect(repos.Users.update).not.toHaveBeenCalled();
    const ok = await request(app()).patch('/api/admin/users/u1').send({ isAdmin: false });
    expect(ok.status).toBe(200);
    expect(repos.Users.update).toHaveBeenCalledWith('u1', { isAdmin: false });
    expect(logAction).toHaveBeenCalledWith('admin1', 'update_user', 'u1', { updates: { isAdmin: false } });
  });

  it('GET /servers sorts by member count; DELETE /servers/:id uses the atomic graph delete', async () => {
    repos.Servers.findRecentSorted.mockResolvedValue([
      { _id: 's1', name: 'Small', icon: null, discoverable: false, createdAt: 1 },
      { _id: 's2', name: 'Big', icon: 'i', discoverable: true, createdAt: 2 },
    ]);
    repos.Members.findByServerIds.mockResolvedValue([{ serverId: 's2' }, { serverId: 's2' }]);
    const list = await request(app()).get('/api/admin/servers');
    expect(list.body.map((s: { _id: string; memberCount: number }) => [s._id, s.memberCount])).toEqual([['s2', 2], ['s1', 0]]);

    repos.Servers.findById.mockImplementation(async (id: string) => (id === 'none' ? null : { _id: id, name: 'S' }));
    expect((await request(app()).delete('/api/admin/servers/none')).status).toBe(404);
    repos.Servers.deleteGraphAtomic.mockResolvedValueOnce('not_found');
    expect((await request(app()).delete('/api/admin/servers/raced')).status).toBe(404);
    repos.Servers.deleteGraphAtomic.mockResolvedValueOnce('deleted');
    const del = await request(app()).delete('/api/admin/servers/s1');
    expect(del.status).toBe(200);
    expect(logAction).toHaveBeenCalledWith('admin1', 'delete_server', 's1', { name: 'S' });
  });
});
