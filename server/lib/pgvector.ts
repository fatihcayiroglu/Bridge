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

type LoggerLike = {
  warn?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  default?: LoggerLike;
};

function loggerWarn(...args: unknown[]): void {
  const l = logger as unknown as LoggerLike;
  const fn = l.warn ?? l.default?.warn;
  if (fn) fn(...args);
}

function loggerInfo(...args: unknown[]): void {
  const l = logger as unknown as LoggerLike;
  const fn = l.info ?? l.default?.info;
  if (fn) fn(...args);
}

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

/**
 * Bir mesajın embedding'ini DB'ye kaydeder.
 * routes/messages veya socket handlers'dan çağrılır.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * E2EE İÇERİK ASLA EMBED EDİLMEZ
 * ══════════════════════════════════════════════════════════════════════════
 * Embedding üretmek, içeriği bir sağlayıcıya METİN olarak göndermek ve
 * türetilmiş bir temsili veritabanında saklamak demektir. Uçtan uca şifreli
 * bir mesaj için bu, şifrelemenin TÜM AMACINI ortadan kaldırır.
 *
 * Denetimde bu yolda HİÇBİR E2EE kontrolü yoktu. Şu an üretimde
 * `saveMessageEmbedding` çağıran bir kod olmadığı için canlı bir sızıntı
 * YOKTU — ama ilk çağıran eklendiği anda E2EE düz metni embed edilecekti.
 *
 * Koruma ÇAĞIRANA bırakılmaz: her yeni çağıranın hatırlaması gereken bir
 * kural, er ya da geç unutulur. Kontrol fonksiyonun KENDİSİNDEDİR ve
 * FAIL-CLOSED çalışır: şüphe varsa embed edilmez.
 */
export async function saveMessageEmbedding(params: {
  db:        { query: (sql: string, values: unknown[]) => Promise<unknown> };
  messageId: string;
  content:   string;
  /** Mesaj E2EE mi. Belirtilmezse içerikten sezilir (fail-closed). */
  isEncrypted?: boolean;
  /** Kanal/mesaj tipi; 'e2ee' ise embed EDİLMEZ. */
  type?: string;
}): Promise<void> {
  if (!PGVECTOR_ENABLED) return;
  const { db, messageId, content, isEncrypted, type } = params;

  if (isEncrypted === true || type === 'e2ee' || isE2eePayload(content)) {
    loggerWarn(
      { event: 'pgvector.embed.skipped_e2ee', messageId },
      '[pgvector] E2EE mesaj embed EDİLMEDİ (şifreleme sözleşmesi).',
    );
    return;
  }

  const embedding = await generateEmbedding(content);
  if (!embedding) return;

  const vectorLiteral = `[${embedding.join(',')}]`;
  try {
    await db.query(
      `UPDATE messages SET embedding = $1::vector WHERE _id = $2`,
      [vectorLiteral, messageId],
    );
    loggerInfo({ messageId, event: 'pgvector.embed.saved' }, '[pgvector] Embedding kaydedildi.');
  } catch (err) {
    loggerWarn({ err, messageId, event: 'pgvector.embed.save_failed' }, '[pgvector] Embedding kaydedilemedi.');
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
