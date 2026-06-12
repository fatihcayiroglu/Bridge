-- server/db/migrations/sprint113_pgvector_batch_embed.sql
-- Sprint 113 — pgvector Faz 2: Batch embed job altyapısı
-- İdempotent (tekrar çalıştırılabilir)

BEGIN;

-- ── embed_jobs izleme tablosu ──────────────────────────────────────────────
-- Hangi batch job'ların çalıştığını ve sonuçlarını izler.

CREATE TABLE IF NOT EXISTS embed_jobs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  processed    INTEGER NOT NULL DEFAULT 0,
  embedded     INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  trigger      TEXT    NOT NULL DEFAULT 'scheduled',  -- 'scheduled' | 'manual' | 'startup'
  notes        TEXT
);

-- ── messages.embedding index'i CONCURRENTLY oluştur (S112 patch'inden) ────
-- Sprint 112'de zaten uygulandı; idempotent guard ile tekrar oluşturmayız.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'messages'
      AND indexname  = 'messages_embedding_idx'
  ) THEN
    -- NOT: CONCURRENTLY transaction bloğu içinde çalışmaz,
    -- bu satırı transaction dışında çalıştırın (migration runner destekliyorsa).
    -- Aksi hâlde standart CREATE INDEX kullanılır.
    CREATE INDEX messages_embedding_idx
      ON messages USING ivfflat (embedding vector_cosine_ops)
      WITH (lists = 100);
  END IF;
END
$$;

-- ── Henüz embed edilmemiş mesaj sayısı (gözlemci VIEW) ────────────────────

CREATE OR REPLACE VIEW v_embed_pending AS
  SELECT COUNT(*) AS pending_count
  FROM messages
  WHERE embedding IS NULL
    AND content IS NOT NULL
    AND content != ''
    AND (type IS NULL OR type != 'system');

COMMENT ON VIEW v_embed_pending IS
  'pgvector Faz 2: embed edilmeyi bekleyen mesaj sayısı';

COMMIT;
