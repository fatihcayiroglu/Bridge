'use strict';
process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';

const query = jest.fn();
const txQuery = jest.fn();
const db: any = {
  _pool: { query: (...args: unknown[]) => query(...args) },
  _transaction: jest.fn(async (fn: (c: any) => Promise<unknown>) => fn({ query: (...args: unknown[]) => txQuery(...args) })),
};
const users = { findById: jest.fn() };
const auth = { revokeAllForUser: jest.fn(async () => undefined) };
const compare = jest.fn();
const disconnect = jest.fn(async (..._args: unknown[]) => undefined);
const info = jest.fn(), warn = jest.fn(), error = jest.fn();

jest.mock('../db/loader', () => ({ __esModule: true, default: db }));
jest.mock('../db/repositories', () => ({ Users: users, Auth: auth }));
jest.mock('bcryptjs', () => ({ compare: (...args: unknown[]) => compare(...args) }));
jest.mock('../lib/sessionRevocation', () => ({ disconnectLiveUserSessions: (...args: unknown[]) => disconnect(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { info, warn, error } }));
const invalidateTokenCache = jest.fn();
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: () => void) => { req.user = { id: 'me' }; next(); },
  _invalidateTokenCache: (id: string) => invalidateTokenCache(id),
}));
jest.mock('../middleware/rateLimit', () => ({ limits: { write: () => (_req: any, _res: any, next: () => void) => next() } }));
const invalidateChannelMessages = jest.fn(async (_channelId: string) => undefined);
jest.mock('../lib/messageCache', () => ({ invalidateChannelMessages: (id: string) => invalidateChannelMessages(id) }));

import fs from 'fs';
import os from 'os';
import path from 'path';
const UPLOAD_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-account-route-'));
const savedUploadRoot = process.env.BRIDGE_UPLOAD_ROOT;
process.env.BRIDGE_UPLOAD_ROOT = UPLOAD_ROOT;
afterAll(() => {
  fs.rmSync(UPLOAD_ROOT, { recursive: true, force: true });
  if (savedUploadRoot === undefined) delete process.env.BRIDGE_UPLOAD_ROOT; else process.env.BRIDGE_UPLOAD_ROOT = savedUploadRoot;
});

import accountRouter from '../routes/account';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/account', accountRouter);
  return a;
}

const tableRows = (...names: string[]) => names.map(table_name => ({ table_name }));
const colRows = (...names: string[]) => names.map(column_name => ({ column_name }));

function installSqlModel(opts: {
  tables?: string[];
  columns?: Record<string, string[]>;
  serverOwners?: Array<{ _id: string; name: string; cnt: string }>;
  groupOwners?: Array<{ _id: string; cnt: string }>;
  exportRows?: Record<string, unknown[]>;
  referencedKeys?: string[];
} = {}) {
  const tables = opts.tables ?? [];
  const columns = opts.columns ?? {};
  query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('information_schema.tables')) return { rows: tableRows(...tables) };
    if (sql.includes('information_schema.columns')) return { rows: colRows(...(columns[String(params?.[0])] ?? [])) };
    if (sql.includes('FROM servers s WHERE')) return { rows: opts.serverOwners ?? [] };
    if (sql.includes('FROM group_dm_conversations g WHERE')) return { rows: opts.groupOwners ?? [] };
    if (sql.includes('SELECT * FROM friendships')) return { rows: opts.exportRows?.friendships ?? [] };
    if (sql.includes('SELECT * FROM blocks')) return { rows: opts.exportRows?.blocks ?? [] };
    if (sql.includes('WITH upload_refs')) return { rows: [{ referenced: (opts.referencedKeys ?? []).includes(String(params?.[0])) }] };
    const m = sql.match(/SELECT \* FROM "([^"]+)"/);
    if (m) return { rows: opts.exportRows?.[m[1]] ?? [] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  txQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
}

describe('account export/delete production behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._pool = { query: (...args: unknown[]) => query(...args) };
    db._transaction.mockImplementation(async (fn: (c: any) => Promise<unknown>) => fn({ query: (...args: unknown[]) => txQuery(...args) }));
    users.findById.mockResolvedValue({ _id: 'me', username: 'alice', displayName: 'Alice', password: 'hash', email: 'a@example.test' });
    auth.revokeAllForUser.mockResolvedValue(undefined);
    compare.mockResolvedValue(true);
    disconnect.mockResolvedValue(undefined);
    installSqlModel();
  });

  it.each([
    ['GET', '/api/account/export'],
    ['GET', '/api/account/deletion-preflight'],
    ['DELETE', '/api/account'],
  ])('%s %s returns 503 when PostgreSQL pool is unavailable', async (method, path) => {
    db._pool = null;
    const r = method === 'DELETE'
      ? await request(app()).delete(path).send({ confirm: 'DELETE', password: 'pw' })
      : await request(app()).get(path);
    expect(r.status).toBe(503);
  });

  it('export returns 404 when authenticated identity no longer exists', async () => {
    users.findById.mockResolvedValueOnce(null);
    const res = await request(app()).get('/api/account/export');
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('exports only positive-listed profile fields and requester-scoped data', async () => {
    users.findById.mockResolvedValueOnce({
      _id: 'me', username: 'alice', displayName: 'Alice', email: 'a@example.test',
      password: 'MUST-NOT-LEAK', twoFactorSecret: 'NOPE', dmPrivacy: 'friends',
    });
    installSqlModel({
      tables: ['messages', 'friendships', 'blocks', 'saved_messages'],
      columns: { messages: ['userId'], saved_messages: ['otherColumn'] },
      exportRows: {
        messages: [{ _id: 'm1', userId: 'me' }],
        friendships: [{ userId: 'me', friendId: 'f1' }],
        blocks: [{ blockerId: 'me', blockedId: 'b1' }],
      },
    });

    const res = await request(app()).get('/api/account/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('bridge-export-me.json');
    expect(res.body.profile).toEqual(expect.objectContaining({ _id: 'me', username: 'alice', dmPrivacy: 'friends' }));
    expect(res.body.profile.password).toBeUndefined();
    expect(res.body.profile.twoFactorSecret).toBeUndefined();
    expect(res.body.data.messages).toEqual([{ _id: 'm1', userId: 'me' }]);
    expect(res.body.data.savedMessages).toEqual([]); // table exists, scope column does not
    expect(res.body.data.uploads).toEqual([]);       // table absent
    expect(res.body.data.friendships).toHaveLength(1);
    expect(res.body.data.blocksCreated).toHaveLength(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('blocks WHERE "blockedId"'))).toBe(false);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.export.generated' }), expect.any(String));
  });

  it('export fails visibly when PostgreSQL query fails', async () => {
    query.mockRejectedValueOnce(new Error('schema unavailable'));
    const res = await request(app()).get('/api/account/export');
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.export.failed' }), expect.any(String));
  });

  it('preflight reports server and group-DM ownership blockers with member counts', async () => {
    installSqlModel({
      tables: ['servers','members','group_dm_conversations','group_dm_members'],
      serverOwners: [
        { _id: 'solo', name: 'Solo', cnt: '1' },
        { _id: 'community', name: 'Community', cnt: '4' },
        { _id: 'badcount', name: 'Bad', cnt: 'not-a-number' },
      ],
      groupOwners: [{ _id: 'g1', cnt: '2' }, { _id: 'gsolo', cnt: '1' }],
    });
    const res = await request(app()).get('/api/account/deletion-preflight');
    expect(res.status).toBe(200);
    expect(res.body.canDelete).toBe(false);
    expect(res.body.blockers).toEqual([
      { kind: 'server', id: 'community', name: 'Community', memberCount: 4 },
      { kind: 'group_dm', id: 'g1', memberCount: 2 },
    ]);
    expect(res.body.policy.length).toBeGreaterThan(20);
  });

  it('group-DM ownership lookup failure is isolated rather than crashing preflight', async () => {
    installSqlModel({ tables: ['group_dm_conversations','group_dm_members'] });
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema.tables')) return { rows: tableRows('group_dm_conversations','group_dm_members') };
      if (sql.includes('FROM group_dm_conversations')) throw new Error('legacy table drift');
      if (sql.includes('information_schema.columns')) return { rows: colRows(...[]) };
      throw new Error(`unexpected ${sql} ${params}`);
    });
    const res = await request(app()).get('/api/account/deletion-preflight');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ canDelete: true, blockers: [] }));
  });

  it('preflight returns 500 on non-isolated schema failure', async () => {
    query.mockRejectedValueOnce(new Error('db down'));
    const res = await request(app()).get('/api/account/deletion-preflight');
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.preflight.failed' }), expect.any(String));
  });

  it('requires explicit destructive confirmation before reauthentication', async () => {
    const res = await request(app()).delete('/api/account').send({ password: 'pw' });
    expect(res.status).toBe(400);
    expect(users.findById).not.toHaveBeenCalled();
  });

  it('requires an existing user and a supplied password', async () => {
    users.findById.mockResolvedValueOnce(null);
    let res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'pw' });
    expect(res.status).toBe(404);

    users.findById.mockResolvedValueOnce({ _id: 'me', password: 'hash' });
    res = await request(app()).delete('/api/account').send({ confirm: 'DELETE' });
    expect(res.status).toBe(400);
    expect(compare).not.toHaveBeenCalled();
  });

  it('fails wrong-password deletion before any ownership/data mutation', async () => {
    compare.mockResolvedValueOnce(false);
    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'wrong' });
    // 400: yanlış parola oturumun geçersiz olduğu anlamına gelmez; 401 istemciyi çıkışa zorlardı.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Password incorrect' });
    expect(db._transaction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.delete.bad_password' }), expect.any(String));
  });

  it('blocks deletion rather than silently transferring a multi-member server', async () => {
    installSqlModel({ tables: ['servers','members'], serverOwners: [{ _id: 's1', name: 'Community', cnt: '2' }] });
    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(res.status).toBe(409);
    expect(res.body.blockers[0]).toEqual(expect.objectContaining({ kind: 'server', id: 's1' }));
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it('applies DELETE, ANONYMIZE and sole-owner deletion atomically, then revokes live sessions', async () => {
    installSqlModel({
      tables: ['refresh_tokens','messages','audit_logs','servers','members'],
      columns: {
        refresh_tokens: ['userId'], messages: ['userId'], audit_logs: ['actorId','targetId'],
        servers: ['ownerId'], members: ['userId'],
      },
      serverOwners: [{ _id: 'solo', name: 'Solo', cnt: '1' }],
    });
    txQuery.mockImplementation(async () => ({ rows: [], rowCount: 1 }));
    auth.revokeAllForUser.mockRejectedValueOnce(new Error('already removed'));

    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ ok: true, deleted: true }));
    const sqls = txQuery.mock.calls.map(c => String(c[0]));
    expect(sqls.some(s => s.includes('DELETE FROM "refresh_tokens"'))).toBe(true);
    expect(sqls.some(s => s.includes('UPDATE "messages" SET "userId"'))).toBe(true);
    expect(sqls.some(s => s.includes('DELETE FROM "servers"'))).toBe(true);
    expect(sqls.some(s => s.includes('audit_logs'))).toBe(false); // RETAIN
    expect(sqls.at(-1)).toContain('DELETE FROM users');
    expect(disconnect).toHaveBeenCalledWith('me', 'account_deleted');
    // The deleted account's access token must not survive in the token-version cache.
    expect(invalidateTokenCache).toHaveBeenCalledWith('me');
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.deleted' }), expect.any(String));
  });

  it('scrubs author name/avatar snapshots in the identity UPDATE and releases profile files after commit', async () => {
    // Final21 Faz 19: silme yalnızca `userId`'yi değiştiriyordu; ad, avatar ve profil görselleri kalıyordu.
    installSqlModel({
      tables: ['messages', 'dm_messages', 'users', 'members'],
      columns: {
        messages: ['userId', 'channelId', 'replyTo', 'username', 'displayName', 'avatarColor', 'avatarUrl'],
        dm_messages: ['userId', 'displayName', 'avatarColor'],
        users: ['avatarUrl', 'bannerUrl'],
        members: ['userId', 'serverProfile'],
      },
      referencedKeys: ['uploads/avatars/avatar_shared.png'],
    });
    for (const [dir, name] of [['avatars', 'avatar_old.png'], ['avatars', 'avatar_now.png'], ['avatars', 'avatar_shared.png'], ['member-profiles', 'mp_av_1.webp']]) {
      fs.mkdirSync(path.join(UPLOAD_ROOT, dir), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_ROOT, dir, name), 'x');
    }
    txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('array_agg(DISTINCT "channelId")')) {
        return { rows: [{ channels: ['c1', 'c2'], avatars: ['/uploads/avatars/avatar_old.png', '/uploads/avatars/avatar_shared.png', 'https://cdn.example/x.png', '/uploads/avatars/../../secret'] }], rowCount: 1 };
      }
      if (sql.includes('FROM users WHERE _id')) return { rows: [{ avatarUrl: '/uploads/avatars/avatar_now.png', bannerUrl: null }], rowCount: 1 };
      if (sql.includes('FROM members WHERE "userId"')) return { rows: [{ serverProfile: { avatarUrl: '/uploads/member-profiles/mp_av_1.webp', bio: 'x' } }], rowCount: 1 };
      return { rows: [], rowCount: 3 };
    });

    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(res.status).toBe(200);
    const calls = txQuery.mock.calls.map(c => ({ sql: String(c[0]), params: c[1] as unknown[] }));
    const msgUpdate = calls.find(c => c.sql.startsWith('UPDATE "messages" SET "userId" = $2'));
    expect(msgUpdate?.sql).toBe('UPDATE "messages" SET "userId" = $2, "username" = $3, "displayName" = $4, "avatarColor" = $5, "avatarUrl" = $6 WHERE "userId" = $1');
    expect(msgUpdate?.params).toEqual(['me', 'deleted-user', '', '', '#2d9cdb', null]);
    const dmUpdate = calls.find(c => c.sql.startsWith('UPDATE "dm_messages"'));
    expect(dmUpdate?.sql).toBe('UPDATE "dm_messages" SET "userId" = $2, "displayName" = $3, "avatarColor" = $4 WHERE "userId" = $1');
    // Alıntı başlığı, kimlik bağı koparılmadan ÖNCE (satırlar hâlâ `userId` ile bulunurken) temizlenir.
    const replyIdx = calls.findIndex(c => c.sql.includes(`"replyTo" - 'displayName'`));
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeLessThan(calls.indexOf(msgUpdate!));

    // Başvurusu kalmayan profil görselleri silinir; başvurulan KALIR; yabancı/kaçış yolları yok sayılır.
    expect(fs.existsSync(path.join(UPLOAD_ROOT, 'avatars', 'avatar_old.png'))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_ROOT, 'avatars', 'avatar_now.png'))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_ROOT, 'member-profiles', 'mp_av_1.webp'))).toBe(false);
    expect(fs.existsSync(path.join(UPLOAD_ROOT, 'avatars', 'avatar_shared.png'))).toBe(true);
    expect(res.body.profileAssets).toEqual({ removed: 3, alreadyAbsent: 0, stillReferenced: 1, failed: 0 });
    expect(invalidateChannelMessages.mock.calls.map(c => c[0]).sort()).toEqual(['c1', 'c2']);
  });

  it('skips lifecycle columns that do not exist in a partial historical schema', async () => {
    installSqlModel({ tables: ['messages'], columns: { messages: ['differentColumn'] } });
    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(res.status).toBe(200);
    expect(txQuery.mock.calls.map(c => String(c[0])).filter(s => s.includes('messages'))).toHaveLength(0);
  });

  it('returns 500 and does not disconnect sessions when transaction fails', async () => {
    installSqlModel({ tables: ['messages'], columns: { messages: ['userId'] } });
    db._transaction.mockRejectedValueOnce(new Error('transaction aborted'));
    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(res.status).toBe(500);
    expect(disconnect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.delete.failed' }), expect.any(String));
  });
});
