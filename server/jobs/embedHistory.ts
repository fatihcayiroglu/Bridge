// server/jobs/embedHistory.ts
// Sprint 113 — pgvector Faz 2: Geçmiş Mesaj Batch Embed Job
//
// ADR-0009 / ADR-0011 uyarınca Sprint 113 hedefi:
//   Mevcut (embedding=NULL) mesajları toplu olarak embed et.
//
// Çalışma mantığı:
//   1. `embedding IS NULL` olan mesajları sayfalı (batch) olarak al.
//   2. Her mesaj için generateEmbedding() çağır.
//   3. messages.embedding kolonunu güncelle.
//   4. Rate limit için her batch arasında BATCH_DELAY_MS bekle.
//   5. Job yeniden başlatılabilir (idempotent) — zaten embed edilmiş satırları atlar.
//
// Tetikleme:
//   - scheduleEmbedHistoryJob(): cron ile her sabah 03:00'da çalıştır.
//   - runEmbedHistoryOnce(): tek seferlik CLI çalıştırma.
//
// Env:
//   PGVECTOR_ENABLED = true    (gerekli)
//   EMBED_BATCH_SIZE = 50      (varsayılan)
//   EMBED_BATCH_DELAY_MS = 200 (varsayılan)
//   EMBED_HISTORY_LIMIT = 0    (0 = tümü, >0 = ilk N mesaj)
//
// Sprint 113

import type { DirectQueryingPool } from '../db/postgres/pool-contracts';
import { generateEmbedding, PGVECTOR_ENABLED } from '../lib/pgvector';
import logger from '../lib/logger';
import { envSafeInt } from '../lib/envNumbers';
import { cache } from '../lib/redisAdapter';

// ── Konfigürasyon ─────────────────────────────────────────────────────────

const BATCH_SIZE = envSafeInt('EMBED_BATCH_SIZE', 50, { min: 1, max: 10_000 });
const BATCH_DELAY_MS = envSafeInt('EMBED_BATCH_DELAY_MS', 200, { min: 0, max: 60 * 60_000 });
const HISTORY_LIMIT = envSafeInt('EMBED_HISTORY_LIMIT', 0, { min: 0, max: 10_000_000 }); // 0 = sınırsız
const DAILY_CLAIM_TTL_SECONDS = 26 * 60 * 60; // survives the whole UTC day + scheduler skew

// ── Tipler ────────────────────────────────────────────────────────────────

export interface EmbedJobStats {
  processed: number;
  embedded:  number;
  failed:    number;
  skipped:   number;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
}

// ── NEDEN `Pick<Pool, 'query'>` DEĞİL ────────────────────────────────────────
// `pg.Pool.query` ağır biçimde aşırı yüklenmiş ve jeneriktir; hiçbir test ikizi
// o imzayı karşılayamaz. Ölçüldü: tek bu sebep `tests/embedHistory.test.ts`
// içinde 18 strict hatası üretiyordu. Bu iş havuzdan yalnızca
// `query(sql, params) -> { rows }` kullanır; sözleşme onu yazar ve gerçek
// `pg.Pool`un uyumu `db/postgres/pool-contracts.ts` içinde derleme zamanında
// kanıtlanır.
type DbPool = DirectQueryingPool;

/**
 * Batch satirinin ACIK tipi. Onceden yalnizca `db.query<{...}>` cagri yerinde
 * satir ici verilmisti ve TypeScript `batchResult` / `rows` / `row` icin
 * TS7022 ("kendi baslaticisinda dolayli olarak kendine referans") uretiyordu;
 * ucu de sessizce `any`e dusuyordu. Yani bu dongude satir alanlari
 * TIPSIZDI — `row.content` yazim hatasi bile yakalanmazdi.
 */
interface EmbedBatchRow {
  _id: string;
  content: string;
  createdAt: number;
}

// ── Yardımcı ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Batch embed çekirdeği ─────────────────────────────────────────────────

/**
 * Tüm embed edilmemiş mesajları toplu olarak işler.
 *
 * @param db     pg Pool instance
 * @param opts   isteğe bağlı override seçenekleri
 */
export async function runEmbedHistoryJob(
  db: DbPool,
  opts: {
    batchSize?:    number;
    batchDelayMs?: number;
    historyLimit?: number;
    onProgress?:   (stats: EmbedJobStats) => void;
    signal?:       AbortSignal;
  } = {},
): Promise<EmbedJobStats> {
  const batchSize    = opts.batchSize    ?? BATCH_SIZE;
  const batchDelayMs = opts.batchDelayMs ?? BATCH_DELAY_MS;
  const historyLimit = opts.historyLimit ?? HISTORY_LIMIT;
  const onProgress   = opts.onProgress;
  const signal       = opts.signal;

  const stats: EmbedJobStats = {
    processed: 0,
    embedded:  0,
    failed:    0,
    skipped:   0,
    startedAt: new Date(),
  };

  if (!PGVECTOR_ENABLED) {
    logger.info('[embedHistory] PGVECTOR_ENABLED=false — job atlandı.');
    stats.finishedAt = new Date();
    stats.durationMs = 0;
    return stats;
  }

  logger.info(
    { batchSize, batchDelayMs, historyLimit },
    '[embedHistory] Batch embed job başladı.',
  );

  let cursorCreatedAt: number | null = null;
  let cursorId = '';

  while (true) {
    // Abort sinyali kontrolü
    if (signal?.aborted) {
      logger.info({ stats }, '[embedHistory] Job iptal edildi (AbortSignal).');
      break;
    }

    // historyLimit: kalan kota varsa batch boyutunu küçült; 0 = sınırsız
    const effectiveBatch = historyLimit > 0
      ? Math.min(batchSize, historyLimit - stats.processed)
      : batchSize;

    // Kota dolmuşsa döngüden çık
    if (effectiveBatch <= 0) {
      logger.info({ stats }, '[embedHistory] historyLimit doldu, durduruluyor.');
      break;
    }

    // Sonraki batch: embedding=NULL olan mesajları çek
    // P6 AI-11 / per-server opt-out: never embed a deleted message's
    // placeholder, an E2EE payload, or anything from a server whose owner
    // turned AI off (the text would be sent to the embedding provider).
    const batchResult = await db.query(
      `SELECT _id, content, "createdAt" AS "createdAt"
       FROM messages
       WHERE embedding IS NULL
         AND content IS NOT NULL
         AND content != ''
         AND (type IS NULL OR type != 'system')
         AND "deletedAt" IS NULL
         AND "encryptedContent" IS NULL
         AND content NOT LIKE '🔒e2e:%'
         AND EXISTS (SELECT 1 FROM servers s WHERE s._id = messages."serverId" AND s."aiEnabled" = TRUE)
         AND (
           $2::bigint IS NULL
           OR "createdAt" > $2
           OR ("createdAt" = $2 AND _id > $3)
         )
       ORDER BY "createdAt" ASC, _id ASC
       LIMIT $1`,
      [effectiveBatch, cursorCreatedAt, cursorId],
    );

    // Havuz sözleşmesi satırları `QueryResultRow` olarak verir (sürücünün kendi
    // açık indeks imzalı satır tipi). Beklenen alanlar BURADA doğrulanır: eksik
    // ya da yanlış tipli bir satır sessizce geçmek yerine atlanır ve sayılır.
    const rows: EmbedBatchRow[] = [];
    let malformedRows = 0;
    for (const raw of batchResult.rows) {
      const id = raw._id;
      const content = raw.content;
      const createdAt = raw.createdAt;
      if (typeof id !== 'string' || typeof content !== 'string' || typeof createdAt !== 'number') {
        malformedRows += 1;
        continue;
      }
      rows.push({ _id: id, content, createdAt });
    }
    if (malformedRows > 0) {
      logger.warn(
        { malformedRows, event: 'embedHistory.row.malformed' },
        '[embedHistory] Beklenen sekilde olmayan satirlar atlandi.',
      );
    }

    if (rows.length === 0) {
      logger.info({ stats }, '[embedHistory] Embed edilecek mesaj kalmadı.');
      break;
    }

    logger.info({ cursorCreatedAt, cursorId, batchCount: rows.length }, '[embedHistory] Batch işleniyor…');

    for (const row of rows) {
      if (signal?.aborted) break;

      stats.processed++;

      try {
        const embedding = await generateEmbedding(row.content);

        if (!embedding) {
          stats.skipped++;
          logger.debug({ messageId: row._id }, '[embedHistory] Embedding null döndü, atlandı.');
          continue;
        }

        const vectorLiteral = `[${embedding.join(',')}]`;
        await db.query(
          `UPDATE messages SET embedding = $1::vector WHERE _id = $2`,
          [vectorLiteral, row._id],
        );

        stats.embedded++;

        if (stats.embedded % 100 === 0) {
          logger.info({ embedded: stats.embedded, failed: stats.failed }, '[embedHistory] İlerleme…');
        }
      } catch (err) {
        stats.failed++;
        logger.warn(
          { err, messageId: row._id, event: 'embedHistory.embed.failed' },
          '[embedHistory] Mesaj embed edilemedi.',
        );
      }

      onProgress?.(stats);

      // Advance the immutable keyset cursor even when embedding generation or
      // persistence fails. Failed rows remain embedding=NULL and are retried on
      // the next job run, while later rows in this run are not starved.
      cursorCreatedAt = row.createdAt;
      cursorId = row._id;
    }

    // Rate limit: her batch sonrası bekle
    if (rows.length === effectiveBatch && effectiveBatch === batchSize) {
      await sleep(batchDelayMs);
    } else {
      // Son batch (kısmi) veya historyLimit kesilmesi — döngüden çık
      break;
    }
  }

  stats.finishedAt = new Date();
  stats.durationMs = stats.finishedAt.getTime() - stats.startedAt.getTime();

  logger.info(
    { stats },
    `[embedHistory] Job tamamlandı. ${stats.embedded} mesaj embed edildi, ${stats.failed} başarısız, ${stats.skipped} atlandı. (${stats.durationMs}ms)`,
  );

  return stats;
}

// ── Cron scheduler ───────────────────────────────────────────────────────

let _cronHandle: ReturnType<typeof setInterval> | null = null;
let _abortController: AbortController | null = null;

/**
 * Her gün 03:00'da çalışacak cron-style job scheduler.
 * startScheduledJobs() tarafından çağrılır.
 *
 * @param db  pg Pool instance
 */
export function scheduleEmbedHistoryJob(db: DbPool | null | undefined): void {
  if (!PGVECTOR_ENABLED) return;

  // PostgreSQL havuzu YOKSA is zaten calisamaz (gecmis mesajlar oradan
  // okunuyor). Zamanlayiciyi hic kurmamak, saatte bir uyanip cokmesinden
  // daha durustur — ve operatore sebebi ACIKCA soylenir.
  if (!db) {
    logger.warn({ event: 'embedHistory.schedule.skipped_no_pool' },
      '[embedHistory] PostgreSQL havuzu yok — gunluk embed job zamanlanmadi.');
    return;
  }

  if (_cronHandle) {
    clearInterval(_cronHandle);
    _cronHandle = null;
  }

  // Her saatte bir kontrol et — 03:00'a gelince çalıştır
  _cronHandle = setInterval(async () => {
    const now = new Date();
    // The public contract and operator logs say UTC. Never inherit the host
    // timezone here: cluster nodes may run with different local TZ settings.
    if (now.getUTCHours() !== 3) return;         // yalnızca 03:xx UTC
    if (now.getUTCMinutes() > 5) return;         // 03:00–03:05 UTC arası

    if (_abortController) {
      logger.info('[embedHistory] Önceki job hâlâ çalışıyor, atlıyorum.');
      return;
    }

    const utcDay = now.toISOString().slice(0, 10);
    const claimKey = `jobs:embed-history:daily:${utcDay}`;
    try {
      // One cluster-wide claim prevents every pod (and every minute in the
      // 03:00-03:05 window) from repeating the same expensive provider/DB
      // work. When REDIS_URL is configured this primitive is authoritative and
      // fails closed instead of silently degrading to one claim per process.
      const claimed = await cache.setIfAbsentAuthoritative(
        claimKey,
        { claimedAt: now.toISOString() },
        DAILY_CLAIM_TTL_SECONDS,
      );
      if (!claimed) {
        logger.info({ utcDay, event: 'embedHistory.daily.already_claimed' }, '[embedHistory] Günlük job başka bir worker tarafından alındı.');
        return;
      }
    } catch (err) {
      logger.error(
        { err, utcDay, event: 'embedHistory.daily.claim_failed' },
        '[embedHistory] Günlük cluster claim alınamadı; duplicate execution yerine job atlanıyor.',
      );
      return;
    }

    _abortController = new AbortController();
    try {
      await runEmbedHistoryJob(db, { signal: _abortController.signal });
    } catch (err) {
      // The daily claim intentionally remains until expiry. A partial run is
      // idempotently resumed on the next daily window; immediately releasing a
      // claim after an uncertain failure could let several pods stampede the
      // same upstream provider.
      logger.error({ err, utcDay, event: 'embedHistory.daily.run_failed' }, '[embedHistory] Günlük job başarısız oldu.');
    } finally {
      _abortController = null;
    }
  }, 60 * 1000); // 1 dakikada bir kontrol

  _cronHandle.unref?.();

  logger.info('[embedHistory] Cron schedule aktif — her gün 03:00 UTC çalışır.');
}

/**
 * Cron job'u iptal eder (graceful shutdown için).
 */
export function cancelEmbedHistoryJob(): void {
  if (_cronHandle) {
    clearInterval(_cronHandle);
    _cronHandle = null;
  }
  _abortController?.abort();
  _abortController = null;
  logger.info('[embedHistory] Job scheduler durduruldu.');
}

// ── Tek seferlik CLI çalıştırma ───────────────────────────────────────────

/**
 * CLI'dan çağrılmak üzere — npm run embed-history
 * Tüm embed edilmemiş mesajları işler ve çıkar.
 */
export async function runEmbedHistoryOnce(db: DbPool): Promise<EmbedJobStats> {
  logger.info('[embedHistory] Tek seferlik çalışma başlatıldı.');
  const stats = await runEmbedHistoryJob(db, {
    onProgress: (s) => {
      if (s.processed % 500 === 0) {
        process.stdout.write(
          `\r[embed] processed=${s.processed} embedded=${s.embedded} failed=${s.failed}   `,
        );
      }
    },
  });
  process.stdout.write('\n');
  logger.info({ stats }, '[embedHistory] Tamamlandı.');
  return stats;
}

export default { runEmbedHistoryJob, scheduleEmbedHistoryJob, cancelEmbedHistoryJob, runEmbedHistoryOnce };
