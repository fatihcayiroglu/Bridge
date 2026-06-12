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

const PGVECTOR_ENABLED    = process.env.PGVECTOR_ENABLED === 'true';
const EMBEDDING_PROVIDER  = (process.env.EMBEDDING_PROVIDER || 'nomic') as EmbeddingProvider;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const OLLAMA_BASE_URL     = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBEDDING_MODEL     = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
const EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION || '768', 10);

/**
 * Cosine similarity eşiği — bu değerin altındaki sonuçlar filtrelenir.
 * Ortam değişkeni ile ayarlanabilir: PGVECTOR_SIMILARITY_THRESHOLD=0.35
 * Varsayılan: 0.3  |  Geçerli aralık: 0.0 – 1.0
 */
const _rawThreshold = parseFloat(process.env.PGVECTOR_SIMILARITY_THRESHOLD || '0.3');
export const PGVECTOR_SIMILARITY_THRESHOLD = Number.isFinite(_rawThreshold)
  ? Math.max(0, Math.min(1, _rawThreshold))
  : 0.3;

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
    switch (EMBEDDING_PROVIDER) {
      case 'openai':
        return await _openaiEmbed(text);
      case 'ollama':
      case 'nomic':
        return await _ollamaEmbed(text);
      default:
        loggerWarn({ provider: EMBEDDING_PROVIDER }, '[pgvector] Bilinmeyen embedding provider.');
        return null;
    }
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
  since?:    number;
  limit?:    number;
}): Promise<Array<{ message_id: string; similarity: number }>> {
  const { db, embedding, serverId, channelId, since, limit = 10 } = params;

  if (!embedding?.length) return [];

  const vectorLiteral = `[${embedding.join(',')}]`;
  const conditions: string[] = ['m.server_id = $2'];
  const values: unknown[]    = [vectorLiteral, serverId];
  let   idx = 3;

  if (channelId) {
    conditions.push(`m.channel_id = $${idx++}`);
    values.push(channelId);
  }

  if (since) {
    conditions.push(`m.created_at > $${idx++}`);
    values.push(new Date(since).toISOString());
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
 * Bir mesajın embedding'ini DB'ye kaydeder.
 * routes/messages veya socket handlers'dan çağrılır.
 */
export async function saveMessageEmbedding(params: {
  db:        { query: (sql: string, values: unknown[]) => Promise<unknown> };
  messageId: string;
  content:   string;
}): Promise<void> {
  if (!PGVECTOR_ENABLED) return;
  const { db, messageId, content } = params;

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

// ── Migration SQL ─────────────────────────────────────────────────────────────

/**
 * pgvector migration SQL'ini döner.
 * db/migrations/ klasörüne yazılmak üzere kullanılır.
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

export default { generateEmbedding, vectorSearch, saveMessageEmbedding, getMigrationSql, PGVECTOR_SIMILARITY_THRESHOLD };
