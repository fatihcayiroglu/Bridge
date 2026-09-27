// server/tests/pgcollection-chain-and-insert-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PgCollection — SORGU ZİNCİRİ, SATIR DÖNÜŞÜMÜ VE EKLEME ÇAKIŞMASI
// ════════════════════════════════════════════════════════════════════════════
//
// Kardeş paketler `buildWhere`in ANLAMINI (`pgcollection-where-operators`),
// enjeksiyonu (`pgCollection-injection`) ve kolon beyaz listesini ölçer. Bu
// dosya geriye kalanı ölçer: `find()` zinciri, satır dönüşümü ve `insert`in
// çakışma kurtarması.
//
// Neden önemli — hepsi SESSİZ bozulma sınıfı:
//
//   · SIRALAMA/SAYFALAMA. `sort`/`limit`/`skip` SQL'e yanlış yansırsa sorgu
//     hata VERMEZ; yalnızca yanlış ya da eksik satır döner. Sonsuz kaydırma
//     satır atlar veya aynı satırı tekrarlar.
//   · SATIR DÖNÜŞÜMÜ. `undefined` bir alan sütun listesine girerse INSERT
//     `NULL` yazar ve "alanı değiştirme" niyeti sessizce "alanı sil"e döner.
//   · ÇAKIŞMA KURTARMASI. `ON CONFLICT DO NOTHING` hiçbir satır yazmaz. Bu
//     durumda çağırana ÇAĞIRANIN GÖNDERDİĞİ nesne verilirse, üst katman
//     hiç kalıcı olmamış alanları kalıcıymış gibi görür. Var olan satır
//     yüklenemiyorsa açık bir hata, sessiz bir yalandan iyidir.

'use strict';
process.env.NODE_ENV = 'test';

import { PgCollection } from '../db/postgres/pgCollection';

const clientQuery = jest.fn();
const release = jest.fn();
const connect = jest.fn(async () => ({ query: clientQuery, release }));
const pool = { connect } as unknown as import('pg').Pool;

function users() {
  return new PgCollection<Record<string, unknown>>(pool, 'users');
}

/** The SQL text of every statement this test issued, in order. */
function sqls(): string[] {
  return clientQuery.mock.calls.map(([sql]: unknown[]) => String(sql).replace(/\s+/g, ' ').trim());
}

beforeEach(() => {
  jest.clearAllMocks();
  clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('every statement borrows and returns exactly one pooled connection', () => {
  it('releases the client even when the query rejects', async () => {
    clientQuery.mockRejectedValueOnce(new Error('syntax error'));
    await expect(users()._query('SELECT 1')).rejects.toThrow('syntax error');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a parameterless statement is issued without a params array of its own', async () => {
    await users()._query('SELECT now()');
    expect(clientQuery).toHaveBeenCalledWith('SELECT now()', []);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('reads with no query at all match every row explicitly', () => {
  it('findOne, find, remove and count all render WHERE TRUE', async () => {
    const table = users();
    await table.findOne();
    await table.find();
    await table.remove();
    await table.count();

    const statements = sqls();
    expect(statements[0]).toBe('SELECT * FROM "users" WHERE TRUE LIMIT 1');
    expect(statements[1]).toBe('SELECT * FROM "users" WHERE TRUE');
    expect(statements[2]).toBe('DELETE FROM "users" WHERE TRUE');
    expect(statements[3]).toBe('SELECT COUNT(*) AS n FROM "users" WHERE TRUE');
    expect(clientQuery.mock.calls.every(([, params]: unknown[]) => Array.isArray(params) && params.length === 0)).toBe(true);
  });

  it('a count over an empty result set is zero, not NaN', async () => {
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(users().count()).resolves.toBe(0);
  });

  it('a count reads the driver-supplied text total', async () => {
    clientQuery.mockResolvedValue({ rows: [{ n: '42' }], rowCount: 1 });
    await expect(users().count({ username: 'a' })).resolves.toBe(42);
  });

  it('remove and update report the driver row count verbatim, including null', async () => {
    clientQuery.mockResolvedValue({ rows: [], rowCount: null });
    await expect(users().remove({ _id: 'x' })).resolves.toEqual({ deleted: null });
    await expect(users().update({ _id: 'x' }, { $set: { username: 'y' } })).resolves.toEqual({ updated: null });
  });
});

describe('the find chain renders sort, limit and skip', () => {
  it('accepts both the numeric and the textual direction and defaults to ASC', async () => {
    await users().find({}).sort({ createdAt: -1, username: 'desc', _id: 1 });
    expect(sqls()[0]).toBe('SELECT * FROM "users" WHERE TRUE ORDER BY "createdAt" DESC, "username" DESC, "_id" ASC');
  });

  it('an empty sort specification adds no ORDER BY clause', async () => {
    await users().find({}).sort({});
    expect(sqls()[0]).toBe('SELECT * FROM "users" WHERE TRUE');
  });

  it('limit alone, skip alone and both together each render once', async () => {
    const table = users();
    await table.find({}).limit(10);
    await table.find({}).skip(5);
    await table.find({}).sort({ _id: 1 }).skip(5).limit(10);
    await table.find({});

    expect(sqls()).toEqual([
      'SELECT * FROM "users" WHERE TRUE LIMIT 10',
      'SELECT * FROM "users" WHERE TRUE OFFSET 5',
      'SELECT * FROM "users" WHERE TRUE ORDER BY "_id" ASC LIMIT 10 OFFSET 5',
      'SELECT * FROM "users" WHERE TRUE',
    ]);
  });

  it('a zero skip is not rendered, because OFFSET 0 is noise', async () => {
    await users().find({}).skip(0);
    expect(sqls()[0]).toBe('SELECT * FROM "users" WHERE TRUE');
  });

  it('a zero limit is rendered, because LIMIT 0 is a real request for no rows', async () => {
    await users().find({}).limit(0);
    expect(sqls()[0]).toBe('SELECT * FROM "users" WHERE TRUE LIMIT 0');
  });

  const boundsCases: Array<[string, number]> = [
    ['a negative value', -1],
    ['a fractional value', 1.5],
    ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
    ['not a number at all', Number.NaN],
  ];
  for (const [name, value] of boundsCases) {
    it(`rejects ${name} for limit and skip before any SQL is built`, () => {
      // An unchecked value here would be interpolated straight into the SQL
      // text, since LIMIT/OFFSET cannot be bound as parameters.
      expect(() => users().find({}).limit(value)).toThrow(RangeError);
      expect(() => users().find({}).skip(value)).toThrow(RangeError);
      expect(clientQuery).not.toHaveBeenCalled();
    });
  }

  it('an unknown sort column is refused rather than quoted into the SQL', () => {
    expect(() => users().find({}).sort({ 'created_at"; DROP TABLE users; --': 1 }))
      .toThrow(/Unknown column name/);
    expect(clientQuery).not.toHaveBeenCalled();
  });
});

describe('the find chain is a complete promise, not just a thenable', () => {
  it('then() with no handlers still resolves to the mapped rows', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'a' }, { _id: 'b' }], rowCount: 2 });
    await expect(users().find({}).then()).resolves.toEqual([{ _id: 'a' }, { _id: 'b' }]);
  });

  it('then() with only a rejection handler surfaces a query failure', async () => {
    clientQuery.mockRejectedValue(new Error('connection reset'));
    const reason = await users().find({}).then(null, (err: unknown) => (err as Error).message);
    expect(reason).toBe('connection reset');
  });

  it('catch() handles a failure and catch() with no handler still rejects', async () => {
    clientQuery.mockRejectedValue(new Error('connection reset'));
    await expect(users().find({}).catch((err: unknown) => (err as Error).message))
      .resolves.toBe('connection reset');
    await expect(users().find({}).catch()).rejects.toThrow('connection reset');
  });

  it('finally() runs its callback and finally() with no callback is a no-op', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'a' }], rowCount: 1 });
    const after = jest.fn();
    await expect(users().find({}).finally(after)).resolves.toEqual([{ _id: 'a' }]);
    expect(after).toHaveBeenCalledTimes(1);
    await expect(users().find({}).finally()).resolves.toEqual([{ _id: 'a' }]);
  });

  it('for-await streams the same rows and skips a null row instead of yielding it', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'a' }, null, { _id: 'b' }], rowCount: 3 });
    const seen: unknown[] = [];
    for await (const row of users().find({}).sort({ _id: 1 }).limit(3).skip(1)) seen.push(row);
    expect(seen).toEqual([{ _id: 'a' }, { _id: 'b' }]);
    expect(sqls()[0]).toBe('SELECT * FROM "users" WHERE TRUE ORDER BY "_id" ASC LIMIT 3 OFFSET 1');
  });

  it('for-await over an unfiltered collection still renders WHERE TRUE', async () => {
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    for await (const _row of users().find()) { /* no rows */ }
    expect(sqls()[0]).toBe('SELECT * FROM "users" WHERE TRUE');
  });
});

describe('row conversion in both directions', () => {
  it('an undefined field is omitted from the write instead of becoming NULL', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'a' }], rowCount: 1 });
    await users().insert({ _id: 'a', username: 'ada', displayName: undefined });
    const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('"_id", "username"');
    expect(sql).not.toContain('displayName');
    expect(params).toEqual(['a', 'ada']);
  });

  it('a JSONB column is serialized on write and parsed back on read', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'd1', readAt: '{"u1":5}' }], rowCount: 1 });
    const row = await users().insert({ _id: 'd1', readAt: { u1: 5 } });
    expect((clientQuery.mock.calls[0]![1] as unknown[])[1]).toBe('{"u1":5}');
    expect(row.readAt).toEqual({ u1: 5 });
  });

  it('a JSONB column that is not valid JSON is passed through untouched', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'd1', readAt: 'not json' }], rowCount: 1 });
    const row = await users().findOne({ _id: 'd1' });
    expect(row!.readAt).toBe('not json');
  });

  it('booleans and nulls survive the round trip as themselves', async () => {
    clientQuery.mockResolvedValue({
      rows: [{ _id: 'a', isAdmin: true, emailVerified: false, bio: null }], rowCount: 1,
    });
    const row = await users().findOne({ _id: 'a' });
    expect(row).toEqual({ _id: 'a', isAdmin: true, emailVerified: false, bio: null });
  });

  it('a missing row reads as null rather than undefined', async () => {
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(users().findOne({ _id: 'nope' })).resolves.toBeNull();
  });
});

describe('insert generates a primary key and recovers from a conflict', () => {
  const generatedCases: Array<[string, Record<string, unknown>]> = [
    ['no _id at all', { username: 'ada' }],
    ['an undefined _id', { _id: undefined, username: 'ada' }],
    ['a null _id', { _id: null, username: 'ada' }],
    ['an empty _id', { _id: '', username: 'ada' }],
  ];
  for (const [name, doc] of generatedCases) {
    it(`generates a uuid for a document with ${name}`, async () => {
      clientQuery.mockResolvedValue({ rows: [{ _id: 'returned' }], rowCount: 1 });
      await users().insert(doc);
      const [sql, params] = clientQuery.mock.calls[0] as [string, unknown[]];
      // The generated key is appended, so locate it by its column position
      // rather than assuming it leads the tuple.
      const columns = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map(c => c.trim().replace(/"/g, ''));
      expect(columns).toContain('_id');
      expect(params[columns.indexOf('_id')])
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  }

  it('keeps a caller-supplied primary key', async () => {
    clientQuery.mockResolvedValue({ rows: [{ _id: 'chosen' }], rowCount: 1 });
    await users().insert({ _id: 'chosen', username: 'ada' });
    expect((clientQuery.mock.calls[0]![1] as unknown[])[0]).toBe('chosen');
  });

  it('a replayed insert returns the row that actually exists, not the submitted document', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                                   // DO NOTHING
      .mockResolvedValueOnce({ rows: [{ _id: 'a', username: 'persisted' }], rowCount: 1 }); // recovery read

    const row = await users().insert({ _id: 'a', username: 'submitted' });

    expect(row).toEqual({ _id: 'a', username: 'persisted' });
    expect(sqls()[1]).toBe('SELECT * FROM "users" WHERE "_id" = $1 LIMIT 1');
    expect(clientQuery.mock.calls[1]![1]).toEqual(['a']);
  });

  it('a conflict whose existing row cannot be loaded is an explicit failure', async () => {
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(users().insert({ _id: 'a', username: 'ada' }))
      .rejects.toThrow(/reported a conflict but the existing primary-key row could not be loaded/);
  });

  it('a composite-key table recovers using every key column', async () => {
    const members = new PgCollection<Record<string, unknown>>(pool, 'members');
    clientQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ userId: 'u1', serverId: 's1' }], rowCount: 1 });

    const row = await members.insert({ userId: 'u1', serverId: 's1', roles: [] });

    expect(row).toEqual({ userId: 'u1', serverId: 's1' });
    expect(sqls()[0]).toContain('ON CONFLICT ("userId", "serverId") DO NOTHING');
    // No surrogate _id is invented for a table that does not have one.
    expect(sqls()[0]).not.toContain('"_id"');
    expect(clientQuery.mock.calls[1]![1]).toEqual(['u1', 's1']);
  });

  it('a composite-key conflict with a blank key column fails loudly', async () => {
    const members = new PgCollection<Record<string, unknown>>(pool, 'members');
    clientQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(members.insert({ userId: 'u1', serverId: '' }))
      .rejects.toThrow(/Missing primary key serverId for members insert conflict recovery/);
  });

  it('an unknown column is refused before the statement is built', async () => {
    await expect(users().insert({ _id: 'a', 'username"; DROP TABLE users; --': 'x' }))
      .rejects.toThrow(/Unknown column name/);
    expect(clientQuery).not.toHaveBeenCalled();
  });
});
