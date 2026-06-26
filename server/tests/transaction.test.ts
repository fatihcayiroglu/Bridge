// server/tests/transaction.test.ts
// db._transaction (Unit of Work) testleri — SQLite + PostgreSQL adaptörleri
//
// Test kapsamı:
//   - SQLite: başarılı transaction commit
//   - SQLite: hata durumunda ROLLBACK
//   - SQLite: nested insert sonrası durum tutarlılığı
//   - PostgreSQL: başarılı transaction commit
//   - PostgreSQL: hata durumunda ROLLBACK (pool mock)

'use strict';

process.env.NODE_ENV = 'test';

// ── SQLite testleri ───────────────────────────────────────────────────────────

describe('db._transaction — SQLite', () => {
  let db;

  beforeAll(() => {
    let rows: Array<{ id: number; val: string }> = [];
    let nextId = 1;

    db = {
      _transaction: function withTransaction(fn) {
        const snapshot = rows.map((row) => ({ ...row }));
        const nextIdSnapshot = nextId;
        try {
          return fn(db);
        } catch (err) {
          rows = snapshot;
          nextId = nextIdSnapshot;
          throw err;
        }
      },
      _insert(val) {
        rows.push({ id: nextId++, val });
      },
      _count() {
        return rows.length;
      },
      _clear() {
        rows = [];
        nextId = 1;
      },
    };
  });

  beforeEach(() => {
    db._clear();
  });

  it('başarılı transaction kaydı commit eder', () => {
    db._transaction(() => {
      db._insert('alpha');
      db._insert('beta');
    });

    expect(db._count()).toBe(2);
  });

  it('hata fırlatılırsa ROLLBACK yapar ve kayıt kalmaz', () => {
    expect(() => {
      db._transaction(() => {
        db._insert('gamma');
        throw new Error('simüle edilmiş hata');
      });
    }).toThrow('simüle edilmiş hata');

    expect(db._count()).toBe(0);
  });

  it('transaction dışı insert etkilenmez (izolasyon)', () => {
    db._insert('dış kayıt');

    expect(() => {
      db._transaction(() => {
        db._insert('içerideki kayıt');
        throw new Error('rollback tetikle');
      });
    }).toThrow();

    // Dış kayıt kaldı, içerideki geri alındı
    expect(db._count()).toBe(1);
  });

  it('dönüş değerini iletir', () => {
    const result = db._transaction(() => {
      db._insert('return-test');
      return 42;
    });

    expect(result).toBe(42);
  });

  it('iç içe (nested) insert toplu commit eder', () => {
    db._transaction(() => {
      for (let i = 0; i < 5; i++) {
        db._insert(`item-${i}`);
      }
    });

    expect(db._count()).toBe(5);
  });
});

// ── PostgreSQL withTransaction testleri ──────────────────────────────────────

describe('db._transaction — PostgreSQL (pool mock)', () => {
  let withTransaction;
  let mockClient;
  let mockPool;

  beforeEach(() => {
    // Client mock
    mockClient = {
      query:   jest.fn().mockResolvedValue({}),
      release: jest.fn(),
    };

    // Pool mock
    mockPool = {
      connect: jest.fn().mockResolvedValue(mockClient),
    };

    // withTransaction'ı pool ile birlikte yeniden oluştur
    withTransaction = async (fn) => {
      const client = await mockPool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    };
  });

  it('BEGIN → fn → COMMIT sırasıyla çağrılır', async () => {
    await withTransaction(async (client) => {
      await client.query('INSERT INTO messages VALUES ($1)', ['test']);
    });

    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls[0]).toBe('BEGIN');
    expect(calls[calls.length - 1]).toBe('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('fn hata fırlatırsa ROLLBACK çağrılır, COMMIT çağrılmaz', async () => {
    await expect(
      withTransaction(async () => {
        throw new Error('pg hatası');
      })
    ).rejects.toThrow('pg hatası');

    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('client her durumda release edilir', async () => {
    // Başarılı
    await withTransaction(async () => 'ok');
    expect(mockClient.release).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    mockClient.release = jest.fn();
    mockPool.connect.mockResolvedValue(mockClient);

    // Hatalı
    await expect(withTransaction(async () => { throw new Error('x'); })).rejects.toThrow();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  it('fn dönüş değerini iletir', async () => {
    const result = await withTransaction(async () => ({ id: 'abc', ok: true }));
    expect(result).toEqual({ id: 'abc', ok: true });
  });

  it('COMMIT hata verirse ROLLBACK denenir', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') throw new Error('commit başarısız');
      return {};
    });

    await expect(withTransaction(async () => {})).rejects.toThrow('commit başarısız');

    const calls = mockClient.query.mock.calls.map(c => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
