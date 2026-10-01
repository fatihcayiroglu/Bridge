// server/lib/pgvector.ts
// Sprint 112 — pgvector embedding entegrasyonu
//
// ADR-0009 uyarınca Sprint 115'e planlanan pgvector desteğini Sprint 112'ye öne çekiyoruz.
// Bu modül mevcut keywordSearch() fallback'ini gerçek vektör aramasıyla değiştirmez —
// pgvector aktifse önce dener, başarısız olursa keyword fallback'e düşer.
//
// Gereksinimler:
//   - PostgreSQL 16 + pgvector extension (CREATE EXTENSION vector;)
//   - EMBEDDING_PROVIDER = openai | ollama | nomic (varsayılan: nomic/ollama)
//   - OPENAI_API_KEY (provider=openai ise)
//   - OLLAMA_BASE_URL (provider=ollama, varsayılan: http://localhost:11434)
//   - PGVECTOR_ENABLED = true (varsayılan: false, opt-in)
//   - PGVECTOR_SIMILARITY_THRESHOLD = 0.0–1.0 (varsayılan: 0.3)
//     Düşük değer → daha fazla sonuç ama alakasız eşleşmeler artar.
//     Yüksek değer → daha az ama yüksek güvenilirlikli sonuçlar.
//     Önerilen aralık: 0.2 (geniş) – 0.5 (dar).
//
// DB şeması:
//   ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(768);
//   CREATE INDEX IF NOT EXISTS messages_embedding_idx
//     ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
//
// Sprint 115'te tüm geçmiş mesajlar batch-embed edilecek.
// Bu sprint: yeni mesajlar embed + arama hazır.

import logger from './logger';
import { envSafeInt, envSafeNumber } from './envNumbers';
import { aiOffByInstallation } from './aiInstallation';

type LoggerLike = {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  default?: LoggerLike;
};

// P6 AI-12: the method is called ON its logger. A detached pino method loses
// `this` and throws, which turned every log line here into an exception.
function loggerCall(level: 'warn' | 'info', args: unknown[]): void {
  const l = logger as unknown as LoggerLike;
  const target = typeof l[level] === 'function' ? l : l.default;
  const fn = target?.[level];
  if (typeof fn === 'function') fn.apply(target, args);
}

function loggerWarn(...args: unknown[]): void { loggerCall('warn', args); }

function loggerInfo(...args: unknown[]): void { loggerCall('info', args); }

export type EmbeddingProvider = 'openai' | 'ollama' | 'nomic';

// This is a live runtime gate, not merely the requested configuration flag.
// Startup sets it back to false when the optional extension/schema cannot be
// established, so jobs/routes cannot execute vector SQL against a fallback DB.
let PGVECTOR_ENABLED      = process.env.PGVECTOR_ENABLED === 'true';
const EMBEDDING_PROVIDER  = (process.env.EMBEDDING_PROVIDER || 'nomic') as EmbeddingProvider;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OLLAMA_BASE_URL     = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBEDDING_MODEL     = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const DEFAULT_EMBEDDING_DIMENSION = EMBEDDING_PROVIDER === 'openai' ? 1536 : 768;
const EMBEDDING_DIMENSION = envSafeInt(
  'EMBEDDING_DIMENSION', DEFAULT_EMBEDDING_DIMENSION, { min: 1, max: 4_096 },
);

/**
 * Cosine similarity eşiği — bu değerin altındaki sonuçlar filtrelenir.
 * Ortam değişkeni ile ayarlanabilir: PGVECTOR_SIMILARITY_THRESHOLD=0.35
 * Varsayılan: 0.3  |  Geçerli aralık: 0.0 – 1.0
 */
export const PGVECTOR_SIMILARITY_THRESHOLD = envSafeNumber(
  'PGVECTOR_SIMILARITY_THRESHOLD', 0.3, { min: 0, max: 1 },
);

export { PGVECTOR_ENABLED, EMBEDDING_DIMENSION, EMBEDDING_PROVIDER };

// ── Embedding üretme ──────────────────────────────────────────────────────────

/**
 * Verilen metinden embedding vektörü üretir.
 * Hata durumunda null döner (fallback için).
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!PGVECTOR_ENABLED) return null;
  // P6 AI-10: AI_PROVIDER=none/off/rules is the installation's master switch —
  // an embedding sends text to a provider, so it is off too.
  if (aiOffByInstallation()) return null;
  if (!text?.trim()) return null;

  try {
    let embedding: number[];
    switch (EMBEDDING_PROVIDER) {
      case 'openai':
        embedding = await _openaiEmbed(text);
        break;
      case 'ollama':
      case 'nomic':
        embedding = await _ollamaEmbed(text);
        break;
      default:
        loggerWarn({ provider: EMBEDDING_PROVIDER }, '[pgvector] Bilinmeyen embedding provider.');
        return null;
    }
    if (embedding.length !== EMBEDDING_DIMENSION) {
      loggerWarn(
        { provider: EMBEDDING_PROVIDER, model: EMBEDDING_MODEL, expected: EMBEDDING_DIMENSION, actual: embedding.length },
        '[pgvector] Embedding boyutu şema sözleşmesiyle uyuşmuyor; kayıt/arama atlandı.',
      );
      return null;
    }
    return embedding;
  } catch (err) {
    loggerWarn({ err, event: 'pgvector.embed.failed' }, '[pgvector] Embedding üretilemedi.');
    return null;
  }
}

async function _openaiEmbed(text: string): Promise<number[]> {
  if (!OPENAI_API_KEY) throw new Error('[pgvector] OPENAI_API_KEY gerekli (provider=openai).');

  const resp = await fetch('https://api.openai.com/v1/embeddings', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL === 'nomic-embed-text' ? 'text-embedding-3-small' : EMBEDDING_MODEL,
      input: text.slice(0, 8191), // OpenAI token limiti
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[pgvector] OpenAI embed API hatası (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { data?: Array<{ embedding: number[] }> };
  const embedding = data.data?.[0]?.embedding;
  if (!embedding?.length) throw new Error('[pgvector] OpenAI embedding boş döndü.');
  return embedding;
}

async function _ollamaEmbed(text: string): Promise<number[]> {
  const resp = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model:  EMBEDDING_MODEL,
      prompt: text.slice(0, 8000),
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[pgvector] Ollama embed API hatası (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { embedding?: number[] };
  if (!data.embedding?.length) throw new Error('[pgvector] Ollama embedding boş döndü.');
  return data.embedding;
}

// ── Vektör araması ────────────────────────────────────────────────────────────

/**
 * pgvector ile cosine similarity araması yapar.
 * db: pg Pool instance (db/repositories'den inject edilir)
 */
export async function vectorSearch(params: {
  db:        { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<{ message_id: string; similarity: number }> }> };
  embedding: number[];
  serverId:  string;
  channelId?: string;
  /**
   * GORULEBILIR kanal kimlikleri — aday kumesini ARAMADAN ONCE kisitlar.
   * `channelId` verilmediginde kullanilir. Bos dizi hicbir aday demektir.
   */
  channelIds?: string[];
  since?:    number;
  limit?:    number;
}): Promise<Array<{ message_id: string; similarity: number }>> {
  const { db, embedding, serverId, channelId, channelIds, since, limit = 10 } = params;

  if (!embedding?.length) return [];

  const vectorLiteral = `[${embedding.join(',')}]`;
  const conditions: string[] = ['m."serverId" = $2'];
  const values: unknown[]    = [vectorLiteral, serverId];
  let   idx = 3;

  if (channelId) {
    conditions.push(`m."channelId" = $${idx++}`);
    values.push(channelId);
  } else if (channelIds) {
    // ══════════════════════════════════════════════════════════════════════
    // YETKI, ADAY KUMESINI ARAMADAN ONCE KISITLAR
    // ══════════════════════════════════════════════════════════════════════
    // Once yalnizca `server_id` kisitlaniyordu. Cagiran taraf sonuclari
    // GORULEBILIR kanallarla kesistirdigi icin yetkisiz icerik DONMUYORDU —
    // ama aday havuzu yine de kullanicinin GOREMEDIGI kanallari kapsiyordu.
    //
    // Iki sonucu vardi:
    //   1. Yetkisiz mesajlar `LIMIT` kotasini tuketip yetkili sonuclari
    //      disari itebiliyordu (alaka kaybi).
    //   2. Benzerlik siralamasi, kullanicinin goremeyecegi icerige gore
    //      sekilleniyordu.
    //
    // Bos dizi = gorulebilir kanal YOK → hicbir aday. Fail-closed.
    if (channelIds.length === 0) return [];
    conditions.push(`m."channelId" = ANY($${idx++}::text[])`);
    values.push(channelIds);
  }

  if (since) {
    conditions.push(`m."createdAt" > $${idx++}`);
    values.push(since);
  }

  // Sadece embed edilmiş mesajları ara
  conditions.push('m.embedding IS NOT NULL');
  // Sistem mesajlarını atla
  conditions.push(`m.type != 'system'`);
  // P5 AI-02: a deleted message's embedding must not rank results.
  conditions.push('m."deletedAt" IS NULL');
  // P6: an E2EE row never ranks (it is never embedded; a pre-P6 vector is purged nightly).
  conditions.push('m."encryptedContent" IS NULL');

  const where = conditions.join(' AND ');

  const sql = `
    SELECT
      m._id              AS message_id,
      1 - (m.embedding <=> $1::vector) AS similarity
    FROM messages m
    WHERE ${where}
    ORDER BY m.embedding <=> $1::vector
    LIMIT $${idx}
  `;
  values.push(limit);

  try {
    const result = await db.query(sql, values);
    return result.rows.filter(r => r.similarity > PGVECTOR_SIMILARITY_THRESHOLD); // env: PGVECTOR_SIMILARITY_THRESHOLD
  } catch (err) {
    loggerWarn({ err, event: 'pgvector.search.failed' }, '[pgvector] Vektör araması başarısız — keyword fallback devreye girecek.');
    return [];
  }
}

// ── Mesaj embed kaydetme ──────────────────────────────────────────────────────

/**
 * İçerik E2EE yükü mü?
 *
 * Kanonik E2EE gönderim yolu (socket/handlers/dm.ts) içeriği `🔒e2e:` öneki
 * ile yazar. Bu sezgisel kontrol, çağıranın bayrak vermeyi unuttuğu durumda
 * SON SAVUNMA hattıdır — bayrağın yerine geçmez.
 */
function isE2eePayload(content: unknown): boolean {
  return typeof content === 'string' && content.startsWith('🔒e2e:');
}

/** What `saveMessageEmbedding` did — callers count these; nothing else depends on them. */
export type SaveEmbeddingResult =
  | 'disabled'         // pgvector or the installation's AI is off: nothing sent
  | 'skipped_e2ee'     // E2EE payload: never sent
  | 'ineligible'       // deleted, changed, E2EE in the row, system, server AI off: nothing sent
  | 'provider_failed'  // the provider gave nothing usable: the row stays NULL and is retried later
  | 'stale'            // the row changed while the provider worked: the vector was discarded
  | 'saved'
  | 'check_failed'     // the eligibility read failed: nothing sent (fail closed)
  | 'save_failed';

/**
 * The single guarded writer for `messages.embedding` (P6). Both the live sweep
 * and the nightly history job go through it.
 *
 *   1. E2EE content is never sent (flags or the `🔒e2e:` prefix).
 *   2. Immediately before the provider call, the row is re-read: it must still
 *      exist with exactly this content, not be deleted, carry no E2EE payload,
 *      not be a system message, and belong to a server whose owner allows AI.
 *      A batch may be minutes old; this check is per message.
 *   3. The vector is written only if the row STILL holds the text that was
 *      embedded (and is still eligible). An edit, delete or opt-out that lands
 *      while the provider works wins: the vector is discarded, never stored
 *      against text it does not describe.
 *
 * Message text never appears in a log line from here.
 */
export async function saveMessageEmbedding(params: {
  db:        { query: (sql: string, values: unknown[]) => Promise<unknown> };
  messageId: string;
  content:   string;
  /** Mesaj E2EE mi. Belirtilmezse içerikten sezilir (fail-closed). */
  isEncrypted?: boolean;
  /** Kanal/mesaj tipi; 'e2ee' ise embed EDİLMEZ. */
  type?: string;
}): Promise<SaveEmbeddingResult> {
  if (!PGVECTOR_ENABLED) return 'disabled';
  const { db, messageId, content, isEncrypted, type } = params;

  // E2EE İÇERİK ASLA EMBED EDİLMEZ — embedding üretmek içeriği sağlayıcıya
  // METİN olarak göndermek demektir. Koruma çağırana bırakılmaz; FAIL-CLOSED.
  if (isEncrypted === true || type === 'e2ee' || isE2eePayload(content)) {
    loggerWarn(
      { event: 'pgvector.embed.skipped_e2ee', messageId },
      '[pgvector] E2EE mesaj embed EDİLMEDİ (şifreleme sözleşmesi).',
    );
    return 'skipped_e2ee';
  }
  if (aiOffByInstallation()) return 'disabled';
  if (!content?.trim()) return 'ineligible';

  try {
    const eligible = await db.query(ELIGIBLE_MESSAGE_SQL, [messageId, content]) as { rows?: unknown[] } | undefined;
    if (!eligible?.rows?.length) return 'ineligible';
  } catch (err) {
    loggerWarn({ err, messageId, event: 'pgvector.embed.check_failed' }, '[pgvector] Uygunluk okunamadı; embed edilmedi.');
    return 'check_failed';
  }

  const embedding = await generateEmbedding(content);
  if (!embedding) return 'provider_failed';

  const vectorLiteral = `[${embedding.join(',')}]`;
  try {
    const r = await db.query(GUARDED_EMBEDDING_UPDATE_SQL, [vectorLiteral, messageId, content]) as { rowCount?: number | null } | undefined;
    if (r && typeof r.rowCount === 'number' && r.rowCount === 0) {
      loggerInfo({ messageId, event: 'pgvector.embed.stale' }, '[pgvector] Mesaj embed sırasında değişti; vektör atıldı.');
      return 'stale';
    }
    loggerInfo({ messageId, event: 'pgvector.embed.saved' }, '[pgvector] Embedding kaydedildi.');
    return 'saved';
  } catch (err) {
    loggerWarn({ err, messageId, event: 'pgvector.embed.save_failed' }, '[pgvector] Embedding kaydedilemedi.');
    return 'save_failed';
  }
}

/** The predicate every embeddable row satisfies (alias `m`). */
export const EMBEDDABLE_ROW_PREDICATE = `m."deletedAt" IS NULL
     AND m."encryptedContent" IS NULL
     AND m.content NOT LIKE '🔒e2e:%'
     AND m.type <> 'system'
     AND EXISTS (SELECT 1 FROM servers s WHERE s._id = m."serverId" AND s."aiEnabled" = TRUE)`;

const ELIGIBLE_MESSAGE_SQL = `SELECT 1 FROM messages m
   WHERE m._id = $1 AND m.content = $2
     AND ${EMBEDDABLE_ROW_PREDICATE}`;

const GUARDED_EMBEDDING_UPDATE_SQL = `UPDATE messages m SET embedding = $1::vector
   WHERE m._id = $2 AND m.content = $3
     AND ${EMBEDDABLE_ROW_PREDICATE}`;

// ── Invalidation (P6) ─────────────────────────────────────────────────────────
//
// A vector describes the text it was computed from. Every path that changes a
// message — REST, socket, plugins, federation, admin tools, bulk deletes — goes
// through UPDATE, so the invalidation lives in the database, not in each path:
//   · content / deletedAt / encryptedContent changes → that row's vector is NULL
//     (the sweep re-embeds the new text if the row is still eligible);
//   · a server's owner turns AI off → every vector of that server is removed,
//     in the same transaction as the setting.
// Created once, with the optional pgvector schema, under the boot schema lock.
const INVALIDATE_FN_SQL = `CREATE OR REPLACE FUNCTION bridge_message_embedding_invalidate() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  NEW.embedding := NULL;
  RETURN NEW;
END
$fn$`;

const PURGE_FN_SQL = `CREATE OR REPLACE FUNCTION bridge_server_ai_off_purge_embeddings() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE messages SET embedding = NULL WHERE "serverId" = NEW._id AND embedding IS NOT NULL;
  RETURN NULL;
END
$fn$`;

export const EMBEDDING_TRIGGERS: ReadonlyArray<{ name: string; table: string; sql: string }> = [
  {
    name: 'messages_embedding_invalidate',
    table: 'messages',
    sql: `CREATE TRIGGER messages_embedding_invalidate
  BEFORE UPDATE OF content, "deletedAt", "encryptedContent" ON messages
  FOR EACH ROW
  WHEN (NEW.embedding IS NOT NULL AND (
        NEW.content IS DISTINCT FROM OLD.content
     OR NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt"
     OR NEW."encryptedContent" IS DISTINCT FROM OLD."encryptedContent"))
  EXECUTE FUNCTION bridge_message_embedding_invalidate()`,
  },
  {
    name: 'servers_ai_off_purge_embeddings',
    table: 'servers',
    sql: `CREATE TRIGGER servers_ai_off_purge_embeddings
  AFTER UPDATE OF "aiEnabled" ON servers
  FOR EACH ROW
  WHEN (OLD."aiEnabled" IS DISTINCT FROM NEW."aiEnabled" AND NEW."aiEnabled" = FALSE)
  EXECUTE FUNCTION bridge_server_ai_off_purge_embeddings()`,
  },
];

async function ensureEmbeddingTriggers(db: {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<void> {
  await db.query(INVALIDATE_FN_SQL);
  await db.query(PURGE_FN_SQL);
  // Created only when missing: CREATE/DROP TRIGGER locks the table, and a boot
  // must not queue behind (and in front of) live traffic every time.
  const present = await db.query(
    `SELECT t.tgname AS name FROM pg_trigger t
      WHERE NOT t.tgisinternal
        AND t.tgrelid IN ('messages'::regclass, 'servers'::regclass)
        AND t.tgname = ANY($1::text[])`,
    [EMBEDDING_TRIGGERS.map((t) => t.name)],
  );
  const have = new Set((present?.rows ?? []).map((r) => String(r.name)));
  for (const t of EMBEDDING_TRIGGERS) {
    if (!have.has(t.name)) await db.query(t.sql);
  }
}


/**
 * Ensure the optional pgvector schema only when the feature is enabled.
 * Missing extension/privilege must not take down core chat; the function logs
 * the exact blocker and returns false so semantic search can fall back safely.
 */
export async function ensurePgvectorSchema(db: {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<boolean> {
  if (!PGVECTOR_ENABLED) return false;

  try {
    const available = await db.query(
      `SELECT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') AS available`,
    );
    if (!available.rows[0]?.available) {
      PGVECTOR_ENABLED = false;
      loggerWarn({ event: 'pgvector.extension_unavailable' }, '[pgvector] PostgreSQL vector extension mevcut değil; özellik devre dışı kalacak.');
      return false;
    }

    await db.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    const existing = await db.query(
      `SELECT format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
        WHERE a.attrelid = 'messages'::regclass
          AND a.attname = 'embedding'
          AND a.attnum > 0
          AND NOT a.attisdropped`,
    );
    const existingType = String(existing.rows[0]?.type ?? '');
    const expectedType = `vector(${EMBEDDING_DIMENSION})`;
    if (existingType && existingType !== expectedType) {
      PGVECTOR_ENABLED = false;
      loggerWarn(
        { event: 'pgvector.dimension_mismatch', expectedType, existingType },
        '[pgvector] Mevcut embedding kolonu boyutu yapılandırmayla uyuşmuyor; destructive otomatik ALTER yapılmadı.',
      );
      return false;
    }

    if (!existingType) {
      await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSION})`);
    }
    await db.query(
      `CREATE INDEX IF NOT EXISTS messages_embedding_idx
         ON messages USING ivfflat (embedding vector_cosine_ops)
         WITH (lists = 100)`,
    );
    // P6: without invalidation a vector could outlive the text it describes.
    // If the triggers cannot be created the feature stays off (fail closed).
    await ensureEmbeddingTriggers(db);
    PGVECTOR_ENABLED = true;
    return true;
  } catch (err) {
    PGVECTOR_ENABLED = false;
    loggerWarn({ err, event: 'pgvector.schema_unavailable' }, '[pgvector] Opsiyonel pgvector şeması hazırlanamadı; core chat etkilenmeden fallback kullanılacak.');
    return false;
  }
}

// ── Migration SQL ─────────────────────────────────────────────────────────────

/**
 * pgvector migration SQL'ini döner.
 * Test/operasyon görünürlüğü için eşdeğer SQL metnini döner; runtime şema sahibi ensurePgvectorSchema() fonksiyonudur.
 */
export function getMigrationSql(): string {
  return `
-- Sprint 112: pgvector embedding sütunu ve indeksi
-- Önce extension'ın yüklü olduğundan emin olun:
--   CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIMENSION});

CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

COMMENT ON COLUMN messages.embedding IS
  'pgvector embedding (${EMBEDDING_DIMENSION}d) — ${EMBEDDING_PROVIDER} provider, Sprint 112';
`.trim();
}

export default { generateEmbedding, vectorSearch, saveMessageEmbedding, ensurePgvectorSchema, getMigrationSql, PGVECTOR_SIMILARITY_THRESHOLD };
