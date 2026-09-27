// server/tests/pg-integration/pool-checked-out-client-loss.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÖDÜNÇ ALINMIŞ İSTEMCİNİN BAĞLANTISI KOPARSA SÜREÇ DÜŞMEMELİ
// ════════════════════════════════════════════════════════════════════════════
// Çok-düğüm düzeneğinde (scripts/multinode, PG-01) ölçüldü: PostgreSQL
// durdurulduğunda o anda havuzdan istemci ödünç almış Bridge düğümü
// "Unhandled 'error' event" ile çöktü. pg-pool ödünç verdiği istemciden kendi
// hata dinleyicisini kaldırır; bağlantı o sırada kapanırsa pg istemcide 'error'
// yayar ve dinleyicisiz 'error' süreci sonlandırır.
//
// Burada gerçek sunucu tarafı sonlandırma (pg_terminate_backend) kullanılır:
//   · ödünç alınmış istemcinin bir 'error' dinleyicisi vardır (düzeltme öncesi 0),
//   · bağlantı koptuğunda yakalanmamış istisna OLUŞMAZ,
//   · çağıran hatayı sorgusunda görür (sessiz başarı yok),
//   · havuz ölü istemciyi atar ve yeni sorgular başarılı olur,
//   · ROLLBACK'i başarısız olan işlem istemcisi havuza geri DÖNMEZ.
// Negatif kontrol: ayrı, düzeltmesiz bir pg.Pool'dan ödünç alınan istemcinin
// dinleyicisi yoktur — test, düzeltme olmadan kırmızıya döner.

import { Pool } from 'pg';

const RUN = process.env.PG_TEST_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../../db/postgres/pool') as typeof import('../../db/postgres/pool');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { withTransaction } = require('../../db/postgres/transaction') as typeof import('../../db/postgres/transaction');

const waitForEnd = (client: { once(ev: 'end', cb: () => void): unknown }) =>
  new Promise<void>((resolve) => { client.once('end', resolve); });

RUN('PostgreSQL pool — checked-out client losing its connection', () => {
  afterAll(async () => { await pool.end().catch(() => undefined); });

  it('negative control: a bare pg.Pool leaves a checked-out client with no error listener', async () => {
    const bare = new Pool({ connectionString: process.env.PG_TEST_URL, max: 1 });
    const client = await bare.connect();
    try {
      expect(client.listenerCount('error')).toBe(0);
    } finally {
      client.release();
      await bare.end();
    }
  });

  it('survives a server-side termination while a client is checked out, surfaces the error to the caller and recovers', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      const client = await pool.connect();
      expect(client.listenerCount('error')).toBeGreaterThanOrEqual(1);
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const ended = waitForEnd(client);
      const killed = await pool.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [rows[0].pid]);
      expect(killed.rows[0].ok).toBe(true);
      await ended;
      await new Promise((r) => setImmediate(r));
      expect(uncaught).toEqual([]);

      await expect(client.query('SELECT 1')).rejects.toThrow();
      client.release();

      const after = await pool.query<{ one: number }>('SELECT 1 AS one');
      expect(after.rows[0].one).toBe(1);
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });

  it('withTransaction whose backend is terminated mid-transaction rejects, and the next caller gets a healthy client', async () => {
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    try {
      await expect(withTransaction(async (client) => {
        const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const slow = client.query('SELECT pg_sleep(10)');
        await new Promise((r) => setTimeout(r, 100));
        await pool.query('SELECT pg_terminate_backend($1)', [rows[0].pid]);
        await slow;
      })).rejects.toThrow();
      expect(uncaught).toEqual([]);
      // Every client the pool hands out next must work: no doomed client re-enters the pool.
      for (let i = 0; i < 5; i++) {
        const after = await pool.query<{ one: number }>('SELECT 1 AS one');
        expect(after.rows[0].one).toBe(1);
      }
    } finally {
      process.removeListener('uncaughtException', onUncaught);
    }
  });
});
