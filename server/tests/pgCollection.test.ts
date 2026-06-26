// server/tests/pgCollection.test.ts
// PgCollection adapter testleri — gerçek PG yerine mock pool kullanır.
// Test edilen: findOne, find (sort/skip/limit), insert, update ($set/$inc/$push), remove, count
// + buildWhere: $in, $nin, $gt, $lt, $ne, $exists, $regex, $or

'use strict';

import { PgCollection, buildWhere } from '../db/postgres/pgCollection';

// ── Mock Pool ─────────────────────────────────────────────────────────────────
function makeMockPool(rows = []) {
  const store = [...rows];
  const queries = [];

  const client = {
    query: jest.fn(async (sql, params = []) => {
      queries.push({ sql, params });
      // Basit in-memory execute
      if (sql.includes('SELECT COUNT(*)')) {
        return { rows: [{ n: store.length }] };
      }
      if (sql.startsWith('SELECT')) {
        return { rows: [...store] };
      }
      if (sql.startsWith('INSERT')) {
        // Extract values and add to store
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('DELETE')) return { rows: [], rowCount: store.length };
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };

  const pool = {
    connect: jest.fn(async () => client),
    _queries: queries,
    _store:   store,
    _client:  client,
  };

  return pool;
}

// ── buildWhere testleri ───────────────────────────────────────────────────────
describe('buildWhere', () => {
  it('boş query → TRUE', () => {
    const { sql, params } = buildWhere({});
    expect(sql).toBe('TRUE');
    expect(params).toHaveLength(0);
  });

  it('basit eşitlik', () => {
    const { sql, params } = buildWhere({ username: 'alice' });
    expect(sql).toContain('"username" = $1');
    expect(params).toEqual(['alice']);
  });

  it('$gt/$lt', () => {
    const { sql, params } = buildWhere({ createdAt: { $gt: 1000, $lt: 9999 } });
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(params).toContain(1000);
    expect(params).toContain(9999);
  });

  it('$in', () => {
    const { sql, params } = buildWhere({ status: { $in: ['online', 'idle'] } });
    expect(sql).toContain('= ANY(');
    expect(params[0]).toEqual(['online', 'idle']);
  });

  it('$ne', () => {
    const { sql, params } = buildWhere({ type: { $ne: 'system' } });
    expect(sql).toContain('!=');
    expect(params).toContain('system');
  });

  it('$exists true', () => {
    const { sql } = buildWhere({ avatarUrl: { $exists: true } });
    expect(sql).toContain('IS NOT NULL');
  });

  it('$exists false', () => {
    const { sql } = buildWhere({ avatarUrl: { $exists: false } });
    expect(sql).toContain('IS NULL');
  });

  it('null değer → IS NULL', () => {
    const { sql } = buildWhere({ bannerUrl: null });
    expect(sql).toContain('IS NULL');
  });

  it('$regex → ILIKE', () => {
    const { sql, params } = buildWhere({ content: { $regex: 'merhaba' } });
    expect(sql).toContain('ILIKE');
    expect(params[0]).toContain('merhaba');
  });

  it('$or', () => {
    const { sql } = buildWhere({ $or: [{ status: 'online' }, { status: 'idle' }] });
    expect(sql).toContain('OR');
  });

  it('çoklu koşullar AND ile birleşir', () => {
    const { sql } = buildWhere({ serverId: 'srv1', type: 'text' });
    expect(sql.split('AND')).toHaveLength(2);
  });

  it('boş $in → FALSE', () => {
    const { sql } = buildWhere({ _id: { $in: [] } });
    expect(sql).toContain('FALSE');
  });
});

// ── PgCollection CRUD testleri ────────────────────────────────────────────────
describe('PgCollection — findOne', () => {
  it('SELECT sorgusu gönderir ve fromRow çağırır', async () => {
    const pool = makeMockPool([{ _id: 'u1', username: 'alice', reactions: '{}' }]);
    const col  = new PgCollection(pool, 'users');
    pool._client.query.mockResolvedValueOnce({ rows: [{ _id: 'u1', username: 'alice', reactions: '{}' }] });

    const result = await col.findOne({ username: 'alice' });
    expect(result).not.toBeNull();
    expect(pool._client.query).toHaveBeenCalledWith(
      expect.stringContaining('SELECT * FROM "users"'),
      expect.any(Array)
    );
  });

  it('sonuç yoksa null döner', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [] });
    const col = new PgCollection(pool, 'users');
    const res = await col.findOne({ username: 'ghost' });
    expect(res).toBeNull();
  });
});

describe('PgCollection — find', () => {
  it('sonuçları dizi olarak döner', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [{ _id: 'u1' }, { _id: 'u2' }] });
    const col = new PgCollection(pool, 'messages');
    const rows = await col.find({});
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('sort ORDER BY oluşturur', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [] });
    const col = new PgCollection(pool, 'messages');
    await col.find({}).sort({ createdAt: -1 });
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('ORDER BY');
    expect(call).toContain('DESC');
  });

  it('limit ve skip SQL\'e yansır', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [] });
    const col = new PgCollection(pool, 'messages');
    await col.find({}).limit(10).skip(20);
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('LIMIT 10');
    expect(call).toContain('OFFSET 20');
  });
});

describe('PgCollection — insert', () => {
  it('INSERT sorgusu oluşturur', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const col = new PgCollection(pool, 'users');
    const doc = await col.insert({ username: 'bob', displayName: 'Bob' });
    expect(doc._id).toBeDefined();
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('INSERT INTO "users"');
    expect(call).toContain('ON CONFLICT ("_id") DO NOTHING');
  });

  it('_id verilmişse kullanır', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const col = new PgCollection(pool, 'users');
    const doc = await col.insert({ _id: 'custom-id', username: 'carol' });
    expect(doc._id).toBe('custom-id');
  });

  it('JSONB sütunlar serialize edilir', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const col = new PgCollection(pool, 'messages');
    await col.insert({ _id: 'm1', reactions: { '👍': ['u1'] }, content: 'hi' });
    const params = pool._client.query.mock.calls[0][1];
    const reactionsParam = params.find(p => typeof p === 'string' && p.includes('👍'));
    expect(reactionsParam).toBeDefined();
  });
});

describe('PgCollection — update', () => {
  it('$set UPDATE sorgusu oluşturur', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const col = new PgCollection(pool, 'users');
    const res = await col.update({ _id: 'u1' }, { $set: { status: 'online' } });
    expect(res.updated).toBe(1);
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('UPDATE "users"');
    expect(call).toContain('SET');
  });

  it('$inc COALESCE kullanır', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const col = new PgCollection(pool, 'unread_counts');
    await col.update({ _id: 'x' }, { $inc: { count: 1 } });
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('COALESCE');
  });

  it('$push JSONB || kullanır', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const col = new PgCollection(pool, 'dm_conversations');
    await col.update({ _id: 'dm1' }, { $push: { participants: 'u1' } });
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('||');
  });

  it('boş update → 0 döner', async () => {
    const pool = makeMockPool();
    const col = new PgCollection(pool, 'users');
    const res = await col.update({ _id: 'u1' }, {});
    expect(res.updated).toBe(0);
    expect(pool._client.query).not.toHaveBeenCalled();
  });
});

describe('PgCollection — remove', () => {
  it('DELETE sorgusu oluşturur', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const col = new PgCollection(pool, 'messages');
    const res = await col.remove({ serverId: 's1' });
    expect(res.deleted).toBe(2);
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('DELETE FROM "messages"');
  });
});

describe('PgCollection — count', () => {
  it('COUNT sorgusu gönderir ve sayı döner', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({ rows: [{ n: '42' }] });
    const col = new PgCollection(pool, 'users');
    const n = await col.count({});
    expect(n).toBe(42);
    const call = pool._client.query.mock.calls[0][0];
    expect(call).toContain('COUNT(*)');
  });
});

// ── fromRow JSONB deserialize ─────────────────────────────────────────────────
describe('fromRow — JSONB deserialize', () => {
  it('string JSONB → obje dönüştürülür', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({
      rows: [{ _id: 'm1', content: 'hi', reactions: '{"👍":["u1"]}' }],
    });
    const col = new PgCollection(pool, 'messages');
    const res = await col.findOne({ _id: 'm1' });
    expect(typeof res.reactions).toBe('object');
    expect(res.reactions['👍']).toContain('u1');
  });

  it('PostgreSQL parse edilmiş JSONB obje olarak gelirse korunur', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValueOnce({
      rows: [{ _id: 'm2', reactions: { '❤️': ['u2'] } }],
    });
    const col = new PgCollection(pool, 'messages');
    const res = await col.findOne({ _id: 'm2' });
    expect(res.reactions['❤️']).toContain('u2');
  });
});

// ── Connection yönetimi ───────────────────────────────────────────────────────
describe('Connection management', () => {
  it('her sorgudan sonra client.release çağırılır', async () => {
    const pool = makeMockPool();
    pool._client.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const col = new PgCollection(pool, 'users');
    await col.findOne({});
    expect(pool._client.release).toHaveBeenCalled();
  });

  it('hata olsa bile release çağırılır', async () => {
    const pool = makeMockPool();
    pool._client.query.mockRejectedValueOnce(new Error('DB error'));
    const col = new PgCollection(pool, 'users');
    await expect(col.findOne({})).rejects.toThrow('DB error');
    expect(pool._client.release).toHaveBeenCalled();
  });
});
