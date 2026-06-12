// server/tests/pgCollection-injection.test.ts
// pgCollection column whitelist injection koruması testleri

process.env.NODE_ENV = 'test';

// pg pool mock
jest.mock('pg', () => {
  const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const mockRelease = jest.fn();
  const mockConnect = jest.fn().mockResolvedValue({ query: mockQuery, release: mockRelease });
  return {
    Pool: jest.fn().mockImplementation(() => ({ connect: mockConnect })),
    _mockQuery: mockQuery,
  };
});

import { PgCollection, buildWhere } from '../db/postgres/pgCollection';
import pg from 'pg';

function makeCollection() {
  const pool = new pg.Pool();
  return new PgCollection(pool, 'users');
}

// ── buildWhere whitelist ────────────────────────────────────────
describe('buildWhere column whitelist', () => {
  test('geçerli kolon adı geçer', () => {
    expect(() => buildWhere({ _id: 'abc' })).not.toThrow();
    expect(() => buildWhere({ email: 'x@y.com' })).not.toThrow();
    expect(() => buildWhere({ serverId: 'srv-1', channelId: 'ch-1' })).not.toThrow();
  });

  test('bilinmeyen kolon adı hata fırlatır', () => {
    expect(() => buildWhere({ '__proto__': 'x' })).toThrow(/Unknown column/);
    expect(() => buildWhere({ 'DROP TABLE': '1' })).toThrow(/Unknown column/);
    expect(() => buildWhere({ 'injected; --': 'x' })).toThrow(/Unknown column/);
    expect(() => buildWhere({ constructor: 'x' })).toThrow(/Unknown column/);
  });

  test('$or içindeki alt sorgu da doğrulanır', () => {
    expect(() => buildWhere({ $or: [{ _id: 'a' }, { email: 'b' }] })).not.toThrow();
    expect(() => buildWhere({ $or: [{ malicious: 'x' }] })).toThrow(/Unknown column/);
  });

  test('$in operatörü geçerli kolonla çalışır', () => {
    expect(() => buildWhere({ _id: { $in: ['a', 'b'] } })).not.toThrow();
  });

  test('$in operatörü geçersiz kolonla hata fırlatır', () => {
    expect(() => buildWhere({ 'hack;': { $in: ['a'] } })).toThrow(/Unknown column/);
  });
});

// ── insert whitelist ────────────────────────────────────────────
describe('insert column whitelist', () => {
  test('geçerli doc insert edilir', async () => {
    const col = makeCollection();
    await expect(
      col.insert({ _id: 'u1', username: 'alice', displayName: 'Alice', password: 'x',
                   avatarColor: '#fff', email: 'a@b.c', createdAt: Date.now() })
    ).resolves.not.toThrow();
  });

  test('bilinmeyen kolon adıyla insert hata fırlatır', async () => {
    const col = makeCollection();
    await expect(
      col.insert({ _id: 'u2', username: 'bob', 'DROP TABLE users; --': 'x' })
    ).rejects.toThrow(/Unknown column/);
  });
});

// ── update whitelist ────────────────────────────────────────────
describe('update column whitelist', () => {
  test('$set geçerli kolon', async () => {
    const col = makeCollection();
    pg._mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(
      col.update({ _id: 'u1' }, { $set: { status: 'online' } })
    ).resolves.not.toThrow();
  });

  test('$set bilinmeyen kolon hata fırlatır', async () => {
    const col = makeCollection();
    await expect(
      col.update({ _id: 'u1' }, { $set: { 'evil; DROP TABLE': 'x' } })
    ).rejects.toThrow(/Unknown column/);
  });

  test('$inc geçerli kolon', async () => {
    const col = makeCollection();
    await expect(
      col.update({ _id: 'u1' }, { $inc: { count: 1 } })
    ).resolves.not.toThrow();
  });

  test('$inc bilinmeyen kolon hata fırlatır', async () => {
    const col = makeCollection();
    await expect(
      col.update({ _id: 'u1' }, { $inc: { 'badcol': 1 } })
    ).rejects.toThrow(/Unknown column/);
  });
});

// ── find().sort() whitelist ─────────────────────────────────────
describe('find().sort() column whitelist', () => {
  test('geçerli kolon ile sort', async () => {
    const col = makeCollection();
    pg._mockQuery.mockResolvedValue({ rows: [] });
    await expect(col.find({}).sort({ createdAt: -1 })).resolves.not.toThrow();
  });

  test('bilinmeyen kolon ile sort hata fırlatır', async () => {
    const col = makeCollection();
    await expect(
      col.find({}).sort({ 'injected ORDER BY password; --': 1 })
    ).rejects.toThrow(/Unknown column/);
  });
});
