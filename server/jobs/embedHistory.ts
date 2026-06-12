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

import { generateEmbedding, PGVECTOR_ENABLED } from '../lib/pgvector';
import logger from '../lib/logger';

// ── Konfigürasyon ─────────────────────────────────────────────────────────

const BATCH_SIZE      = parseInt(process.env.EMBED_BATCH_SIZE      || '50',  10);
const BATCH_DELAY_MS  = parseInt(process.env.EMBED_BATCH_DELAY_MS  || '200', 10);
const HISTORY_LIMIT   = parseInt(process.env.EMBED_HISTORY_LIMIT   || '0',   10); // 0 = sınırsız

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

interface DbPool {
  query<T extends object = object>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
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

  let offset = 0;

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
    const batchResult = await db.query<{
      _id: string;
      content: string;
    }>(
      `SELECT _id, content
       FROM messages
       WHERE embedding IS NULL
         AND content IS NOT NULL
         AND content != ''
         AND (type IS NULL OR type != 'system')
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [effectiveBatch, offset],
    );

    const rows = batchResult.rows;

    if (rows.length === 0) {
      logger.info({ stats }, '[embedHistory] Embed edilecek mesaj kalmadı.');
      break;
    }

    logger.info({ batchStart: offset, batchCount: rows.length }, '[embedHistory] Batch işleniyor…');

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
    }

    offset += rows.length;

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
export function scheduleEmbedHistoryJob(db: DbPool): void {
  if (!PGVECTOR_ENABLED) return;

  if (_cronHandle) {
    clearInterval(_cronHandle);
    _cronHandle = null;
  }

  // Her saatte bir kontrol et — 03:00'a gelince çalıştır
  _cronHandle = setInterval(async () => {
    const now = new Date();
    if (now.getHours() !== 3) return;            // yalnızca 03:xx
    if (now.getMinutes() > 5) return;            // 03:00–03:05 arası

    if (_abortController) {
      logger.info('[embedHistory] Önceki job hâlâ çalışıyor, atlıyorum.');
      return;
    }

    _abortController = new AbortController();
    try {
      await runEmbedHistoryJob(db, { signal: _abortController.signal });
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
