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
import { stepUpHeader } from './helpers/stepUp';
import * as stepUp from '../lib/stepUp';

// P7 B2: export needs a `sensitive-export` grant, deletion a `destructive-admin` grant or (for a
// password account without 2FA) the existing inline password.
const EXPORT_PROOF = () => stepUpHeader('me', 'sensitive-export');

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
      : await request(app()).get(path).set(EXPORT_PROOF());
    expect(r.status).toBe(503);
  });

  it('export returns 404 when authenticated identity no longer exists', async () => {
    // The step-up guard reads the account first; it vanishes before the export reads it.
    users.findById.mockResolvedValueOnce({ _id: 'me', password: 'hash' }).mockResolvedValueOnce(null);
    const res = await request(app()).get('/api/account/export').set(EXPORT_PROOF());
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('exports only positive-listed profile fields and requester-scoped data', async () => {
    users.findById.mockResolvedValue({
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

    const res = await request(app()).get('/api/account/export').set(EXPORT_PROOF());
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
    const res = await request(app()).get('/api/account/export').set(EXPORT_PROOF());
    expect(res.status).toBe(500);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.export.failed' }), expect.any(String));
  });

  it('P7 C1: portable identity export requires the existing sensitive-export step-up grant', async () => {
    const refused = await request(app()).get('/api/account/portable-export');
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'sensitive-export', action: 'account.export' });
    expect(query).not.toHaveBeenCalled();

    const mismatch = await request(app()).get('/api/account/portable-export')
      .set(stepUpHeader('me', 'destructive-admin'));
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.reasons).toEqual(['step_up_scope_mismatch']);
    expect(query).not.toHaveBeenCalled();
  });

  it('P7 C1: portable snapshot exports only allowlisted identity fields and a reproducible digest', async () => {
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    users.findById.mockResolvedValue({
      _id: 'me', username: 'alice', displayName: 'Alice', bio: 'Hello', website: 'https://example.test',
      pronouns: 'she/her', avatarColor: '#123456', bannerColor: '#654321',
      password: 'SHOULD-NOT-LEAK', twoFactorSecret: 'SHOULD-NOT-LEAK',
      email: 'PRIVATE@example.test', location: 'PRIVATE GPS', refreshToken: 'SHOULD-NOT-LEAK',
      avatarUrl: 'https://source.example/private.png',
    });
    const res = await request(app()).get('/api/account/portable-export').set(EXPORT_PROOF());
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('bridge-portable-identity-v1.json');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({
      format: 'bridge-portable-identity', version: 1,
      identity: { sourceUserId: 'me', username: 'alice', displayName: 'Alice', bio: 'Hello' },
      integrity: { algorithm: 'sha256', canonicalization: 'ordered-json-v1' },
      portability: { importSupported: false },
    });
    expect(Object.keys(res.body.identity).sort()).toEqual([
      'avatarColor', 'bannerColor', 'bio', 'displayName', 'pronouns',
      'sourceUserId', 'username', 'website',
    ].sort());
    const responseText = JSON.stringify(res.body);
    for (const forbidden of ['SHOULD-NOT-LEAK', 'PRIVATE@example.test', 'PRIVATE GPS', 'private.png']) {
      expect(responseText).not.toContain(forbidden);
    }
    const { format, version, exportedAt, identity } = res.body;
    expect(res.body.integrity.digest).toBe(
      createHash('sha256').update(JSON.stringify({ format, version, exportedAt, identity }), 'utf8').digest('hex'),
    );
    expect(query).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'account.portable_export.generated' }), expect.any(String));
  });

  it('P7 C1: cannot generate a portable snapshot for an account deleted after step-up', async () => {
    users.findById.mockResolvedValueOnce({ _id: 'me', password: 'hash' }).mockResolvedValueOnce(null);
    const res = await request(app()).get('/api/account/portable-export').set(EXPORT_PROOF());
    expect(res.status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it('P7 C3: portable import preview requires a scoped proof and cannot mutate target state', async () => {
    const { buildPortableIdentityExport } = require('../lib/portableIdentity') as typeof import('../lib/portableIdentity');
    const source = buildPortableIdentityExport('foreign-instance-user', {
      username: 'origin', displayName: 'Origin', bio: 'Imported bio', website: 'https://example.test',
    }, '2026-10-11T12:00:00.000Z');
    const refused = await request(app()).post('/api/account/portable-import/preview').send(source);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'sensitive-export', action: 'account.export' });
    const mismatched = await request(app()).post('/api/account/portable-import/preview')
      .set(stepUpHeader('me', 'account-security')).send(source);
    expect(mismatched.status).toBe(403);
    expect(query).not.toHaveBeenCalled();

    const res = await request(app()).post('/api/account/portable-import/preview')
      .set(EXPORT_PROOF()).send(source);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({
      dryRun: true, applied: false, checksumVerified: true,
      mapping: { sourceUserId: 'foreign-instance-user', targetUserId: 'me', strategy: 'map-to-authenticated-account' },
    });
    expect(res.body.fields).toContainEqual({
      field: 'bio', current: '', proposed: 'Imported bio', changed: true,
    });
    expect(res.body.unsupportedFields.join(' ')).toContain('username');
    expect(query).not.toHaveBeenCalled();
    expect(txQuery).not.toHaveBeenCalled();
    expect(db._transaction).not.toHaveBeenCalled();
    expect(users.findById).toHaveBeenCalled();
  });

  it('P7 C3: damaged checksums, secret-bearing fields, unknown versions and oversized files fail closed', async () => {
    const { buildPortableIdentityExport } = require('../lib/portableIdentity') as typeof import('../lib/portableIdentity');
    const correct = buildPortableIdentityExport('origin', { username: 'alice', displayName: 'Alice' });
    const probes = [
      { ...correct, identity: { ...correct.identity, bio: 'tampered' } },
      { ...correct, identity: { ...correct.identity, password: 'secret' } },
      { ...correct, version: 999 },
      { ...correct, extra: 'unlisted field' },
      { ...correct, integrity: { ...correct.integrity, digest: '0'.repeat(64) } },
      { ...correct, portability: { ...correct.portability, importSupported: true } },
      { ...correct, identity: { ...correct.identity, bio: 'x'.repeat(17000) } },
    ];
    for (const bad of probes) {
      const response = await request(app()).post('/api/account/portable-import/preview')
        .set(EXPORT_PROOF()).send(bad);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('PORTABLE_IDENTITY_INVALID');
      expect(response.body.error).toBeTruthy();
    }
    expect(txQuery).not.toHaveBeenCalled();
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it('P7 C3: checksum-valid legacy profile values never produce a falsely actionable preview', async () => {
    const { buildPortableIdentityExport, portableIdentityDigest } =
      require('../lib/portableIdentity') as typeof import('../lib/portableIdentity');
    const source = buildPortableIdentityExport('foreign-account', {
      username: 'foreign', displayName: 'Origin', bio: 'short bio',
      website: 'https://example.test', pronouns: 'they/them',
      avatarColor: '#2d9cdb', bannerColor: '#123456',
    }, '2026-10-11T12:00:00.000Z');

    // These are checksum-correct documents, not ordinary corruption. Every
    // value below would be silently transformed or rejected by /api/me.
    const incompatible = [
      { displayName: 'Ad\u200bmin' },
      { displayName: 'X'.repeat(33) },
      { displayName: '  Padded name  ' },
      { displayName: '' },
      { bio: 'x'.repeat(181) },
      { bio: 'Padded bio ' },
      { website: 'x'.repeat(121) },
      { website: ' https://example.test' },
      { pronouns: 'x'.repeat(41) },
      { pronouns: ' they/them ' },
      { avatarColor: 'url(https://attacker.invalid/track)' },
      { bannerColor: 'red' },
    ];
    for (const changed of incompatible) {
      const identity = { ...source.identity, ...changed };
      const invalid = {
        ...source,
        identity,
        integrity: { ...source.integrity, digest: portableIdentityDigest({ ...source, identity }) },
      };
      const res = await request(app()).post('/api/account/portable-import/preview')
        .set(EXPORT_PROOF()).send(invalid);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('PORTABLE_IDENTITY_INVALID');
      expect(res.body.error).toContain('cannot be applied losslessly');
    }

    // A valid checksum and a destination-compatible profile still preview.
    const accepted = await request(app()).post('/api/account/portable-import/preview')
      .set(EXPORT_PROOF()).send(source);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ dryRun: true, applied: false, checksumVerified: true });
    expect(accepted.body.fields).toContainEqual({
      field: 'bio', current: '', proposed: 'short bio', changed: true,
    });
    expect(query).not.toHaveBeenCalled();
    expect(txQuery).not.toHaveBeenCalled();
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it('P7 C3 apply: confirmed profile writes only allowlisted columns under atomic stale-state guards', async () => {
    const { buildPortableIdentityExport } = require('../lib/portableIdentity') as typeof import('../lib/portableIdentity');
    const source = buildPortableIdentityExport('foreign-id', {
      username: 'source_login', displayName: 'Migrated Name', bio: 'New biography',
      website: 'https://profile.example', pronouns: 'they/them',
      avatarColor: '', bannerColor: '#123456',
      email: 'never.import@example.test', password: 'never-import',
    }, '2026-10-11T12:00:00.000Z');
    const expected = {
      displayName: 'Alice', bio: '', website: '', pronouns: '',
      avatarColor: '#2d9cdb', bannerColor: '#abcdef',
    };
    const body = { document: source, expected, confirm: 'APPLY_PORTABLE_PROFILE' };
    const noStepUp = await request(app()).post('/api/account/portable-import/apply').send(body);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    expect(query).not.toHaveBeenCalled();
    // A read-only export grant must NEVER authorize a profile mutation.
    const wrongScope = await request(app()).post('/api/account/portable-import/apply')
      .set(EXPORT_PROOF()).send(body);
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'account-security' });
    expect(query).not.toHaveBeenCalled();

    // SQL mocks must not throw Jest assertion errors *inside* the route's
    // catch block: that converts a useful SQL-contract failure into an opaque
    // HTTP 500. Assert exact statement and parameter contract after the call.
    query.mockResolvedValue({ rows: [{ _id: 'me' }], rowCount: 1 });
    const res = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader('me', 'account-security')).send(body);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.body).toMatchObject({
      ok: true, applied: true, targetUserId: 'me', version: 1,
      appliedFields: ['displayName', 'bio', 'website', 'pronouns', 'bannerColor'],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/^UPDATE users SET /);
    expect(sql).toContain('WHERE _id=$1 AND');
    expect(sql).toContain('COALESCE("displayName", \'\')=$8');
    expect(sql).toContain('COALESCE("bannerColor", \'\')=$13');
    expect(sql).not.toMatch(/username|password|email|token|sourceUserId|avatarUrl|membership/i);
    expect(params).toEqual([
      'me', 'Migrated Name', 'New biography', 'https://profile.example',
      'they/them', '#2d9cdb', '#123456',
      'Alice', '', '', '', '#2d9cdb', '#abcdef',
    ]);
    expect(txQuery).not.toHaveBeenCalled();
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it('P7 C3 apply: confirmation and exact current-state snapshot are mandatory', async () => {
    const { buildPortableIdentityExport } = require('../lib/portableIdentity') as typeof import('../lib/portableIdentity');
    const source = buildPortableIdentityExport('origin', { username: 'origin', displayName: 'Origin' });
    const expected = {
      displayName: 'Alice', bio: '', website: '', pronouns: '', avatarColor: '', bannerColor: '',
    };
    for (const bad of [
      { document: source, expected },
      { document: source, expected, confirm: 'yes' },
      { document: source, expected, confirm: 'APPLY_PORTABLE_PROFILE', targetUserId: 'someone-else' },
    ]) {
      const res = await request(app()).post('/api/account/portable-import/apply')
        .set(stepUpHeader('me', 'account-security')).send(bad);
      expect(res.status).toBe(400);
    }
    const malformed = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader('me', 'account-security')).send({
        document: source,
        expected: { ...expected, password: 'attack' },
        confirm: 'APPLY_PORTABLE_PROFILE',
      });
    expect(malformed.status).toBe(422);
    expect(malformed.body.code).toBe('PORTABLE_IDENTITY_INVALID');
    expect(query).not.toHaveBeenCalled();
  });

  it('P7 C3 apply: concurrent profile edits fail 409 without partial import; DB failures fail visibly', async () => {
    const { buildPortableIdentityExport } = require('../lib/portableIdentity') as typeof import('../lib/portableIdentity');
    const source = buildPortableIdentityExport('origin', { username: 'origin', displayName: 'Origin' });
    const body = {
      document: source, confirm: 'APPLY_PORTABLE_PROFILE',
      expected: { displayName: 'Alice', bio: '', website: '', pronouns: '', avatarColor: '', bannerColor: '' },
    };
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const conflict = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader('me', 'account-security')).send(body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('PORTABLE_PROFILE_CONFLICT');
    query.mockRejectedValueOnce(new Error('update failed; statement rolled back'));
    const unavailable = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader('me', 'account-security')).send(body);
    expect(unavailable.status).toBe(500);
    db._pool = null;
    const noPg = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader('me', 'account-security')).send(body);
    expect(noPg.status).toBe(503);
    expect(txQuery).not.toHaveBeenCalled();
    expect(db._transaction).not.toHaveBeenCalled();
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
  it('P7 B2: export without a sensitive-export proof is refused before any data is read', async () => {
    const res = await request(app()).get('/api/account/export');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'STEP_UP_REQUIRED', action: 'account.export', scope: 'sensitive-export' });
    expect(query).not.toHaveBeenCalled();
    // A grant for another scope does not open the export.
    const wrong = await request(app()).get('/api/account/export').set(stepUpHeader('me', 'destructive-admin'));
    expect(wrong.status).toBe(403);
    expect(wrong.body.reasons).toEqual(['step_up_scope_mismatch']);
  });

  it('P7 B2: a destructive-admin grant deletes without the password — the SSO-only account path', async () => {
    users.findById.mockResolvedValue({ _id: 'me', username: 'alice', password: '' });
    const refused = await request(app()).delete('/api/account').send({ confirm: 'DELETE' });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'STEP_UP_REQUIRED', scope: 'destructive-admin', methods: ['sign_in'] });
    const res = await request(app()).delete('/api/account')
      .set(stepUpHeader('me', 'destructive-admin', { method: 'sso' }))
      .send({ confirm: 'DELETE' });
    expect(res.status).toBe(200);
    expect(compare).not.toHaveBeenCalled();
  });

  it('P7 B2: an account with 2FA cannot be deleted with the password alone', async () => {
    users.findById.mockResolvedValue({ _id: 'me', username: 'alice', password: 'hash', twoFactorEnabled: true });
    const res = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'STEP_UP_REQUIRED', level: 2, methods: ['totp', 'backup_code', 'sign_in'] });
    // The supplied password is still verified (it was right), but it is not this account's full strength.
    expect(compare).toHaveBeenCalledWith('correct', 'hash');
    expect(db._transaction).not.toHaveBeenCalled();
    const l1 = await request(app()).delete('/api/account')
      .set(stepUpHeader('me', 'destructive-admin', { method: 'password' }))
      .send({ confirm: 'DELETE', password: 'correct' });
    expect(l1.status).toBe(403);
    expect(l1.body.reasons).toEqual(['step_up_level']);
    const l2 = await request(app()).delete('/api/account')
      .set(stepUpHeader('me', 'destructive-admin'))
      .send({ confirm: 'DELETE' });
    expect(l2.status).toBe(200);
  });

  it('P7 B2: deletion fails closed when the step-up check cannot run, and a vanished account is 401', async () => {
    jest.spyOn(stepUp, 'evaluateStepUp').mockRejectedValueOnce(new Error('counter offline'));
    const unavailable = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toEqual({ error: 'STEP_UP_UNAVAILABLE', action: 'account.delete' });
    jest.spyOn(stepUp, 'evaluateStepUp').mockRejectedValueOnce('string failure');
    expect((await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' })).status).toBe(503);
    users.findById.mockResolvedValueOnce({ _id: 'me', password: 'hash' }).mockResolvedValueOnce(null);
    const gone = await request(app()).delete('/api/account').send({ confirm: 'DELETE', password: 'correct' });
    expect(gone.status).toBe(401);
    expect(db._transaction).not.toHaveBeenCalled();
  });
});

describe('P7 B2 — a supplied deletion password is always verified', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db._pool = { query: (...args: unknown[]) => query(...args) };
    users.findById.mockResolvedValue({ _id: 'me', username: 'alice', password: 'hash' });
    installSqlModel();
  });

  it('a wrong password is refused even beside a valid destructive-admin grant', async () => {
    compare.mockResolvedValueOnce(false);
    const res = await request(app()).delete('/api/account')
      .set(stepUpHeader('me', 'destructive-admin', { method: 'password' }))
      .send({ confirm: 'DELETE', password: 'wrong' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Password incorrect' });
    expect(db._transaction).not.toHaveBeenCalled();
  });

  it('the right password beside a grant deletes; a grant alone (no password sent) also deletes', async () => {
    compare.mockResolvedValueOnce(true);
    const withPassword = await request(app()).delete('/api/account')
      .set(stepUpHeader('me', 'destructive-admin', { method: 'password' }))
      .send({ confirm: 'DELETE', password: 'correct' });
    expect(withPassword.status).toBe(200);
    const grantOnly = await request(app()).delete('/api/account')
      .set(stepUpHeader('me', 'destructive-admin', { method: 'password' }))
      .send({ confirm: 'DELETE' });
    expect(grantOnly.status).toBe(200);
  });
});
