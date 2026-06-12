// server/db/postgres/pool.ts
// PostgreSQL bağlantı havuzu — tek kaynak, tüm DB modülleri buradan import eder.
// Pool nesnesi process boyunca tek instance olarak yaşar (singleton).

import { Pool, PoolClient } from 'pg';
import logger from '../../lib/logger';

// ── HAVUZ OLUŞTURMA ──────────────────────────────────────────
const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     process.env.PG_POOL_MAX ? parseInt(process.env.PG_POOL_MAX) : 20,
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err: Error) => {
  logger.error({ event: 'db.pool.error', message: err.message }, '[DB] PostgreSQL pool hatası');
});

// ── SAĞLIK KONTROLÜ ──────────────────────────────────────────
export async function checkPoolHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ── CLIENT ALMA ───────────────────────────────────────────────
// Doğrudan transaction'lar için; normal sorgular için pool.query kullanın.
export async function getClient(): Promise<PoolClient> {
  return pool.connect();
}

export { pool };
export default pool;
