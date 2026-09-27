// server/db/postgres/pool.ts
// PostgreSQL bağlantı havuzu — tek kaynak, tüm DB modülleri buradan import eder.
// Pool nesnesi process boyunca tek instance olarak yaşar (singleton).

import { Pool, PoolClient, types } from 'pg';
import logger from '../../lib/logger';
import { envSafeInt } from '../../lib/envNumbers';

// ── BIGINT (int8) → SAYI (Final21 Faz 19, 19-27) ─────────────────────────────
// node-pg BIGINT'i varsayılan olarak METİN döndürür. Şemadaki BIGINT'ler epoch-ms zaman damgaları
// ve sayaçlardır (kimlikler TEXT'tir; tek BIGSERIAL `sticker_packs.seq` dahili sıralamadır);
// TypeScript tipleri, OpenAPI şeması ve bellek-içi test deposu hepsini SAYI olarak modelliyordu —
// üretim ise metin veriyordu. Ölçülen sonuçlar: kanal geçmişinin geri sayfalaması 400 veriyordu
// (imleç `ts: "1790…"`), konu ve grup DM mesaj saatleri `new Date("1790…")` = "Invalid Date".
// Yalnızca GÜVENLİ tamsayılar dönüştürülür; 2^53 üstü değer metin kalır (hassasiyet kaybı YOK).
const INT8_OID = 20;
export function parseInt8(value: string): number | string {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : value;
}
types.setTypeParser(INT8_OID, parseInt8);

// ── HAVUZ OLUŞTURMA ──────────────────────────────────────────
const pool = new Pool({
  connectionString:        process.env.DATABASE_URL,
  max:                     envSafeInt('PG_POOL_MAX', 20, { min: 1, max: 1_000 }),
  idleTimeoutMillis:       30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err: Error) => {
  logger.error({ event: 'db.pool.error', message: err.message }, '[DB] PostgreSQL pool hatası');
});

// ── SORGU METRİKLERİ (Final21 Faz 9 — F21-9-01) ──────────────────────────────
// Her yeni istemci bir kez enstrümante edilir; `pool.query` ve işlem
// istemcileri (`getClient`) aynı `client.query` yolundan geçtiği için her sorgu
// tam bir kez sayılır. Metrik modülü tembel yüklenir (içe aktarma döngüsü yok);
// yüklenemezse sorgular etkilenmez.
pool.on('connect', (client) => {
  try {
    const metrics = require('../../middleware/metrics') as {
      instrumentPgClient?: (c: unknown) => void;
    };
    metrics.instrumentPgClient?.(client);
  } catch { /* metrikler yoksa sorgu yolu degismez */ }
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
