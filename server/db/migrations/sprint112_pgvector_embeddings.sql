-- Sprint 112: pgvector embedding sütunu ve indeksi
-- Uygulama: psql $DATABASE_URL -f sprint112_pgvector_embeddings.sql
--
-- Ön koşul: PostgreSQL pgvector extension yüklü olmalı
--   CREATE EXTENSION IF NOT EXISTS vector;
--
-- Sağlama: SELECT extname FROM pg_extension WHERE extname = 'vector';
--
-- ÖNEMLİ: Bu dosya psql ile transaction dışında çalıştırılmalıdır.
-- CONCURRENTLY, açık bir transaction bloğu içinde kullanılamaz.
--   psql $DATABASE_URL -f sprint112_pgvector_embeddings.sql
-- (BEGIN/COMMIT sardığınız bir wrapper içinde çalıştırmayın)

-- Extension (idempotent)
CREATE EXTENSION IF NOT EXISTS vector;

-- Embedding sütunu (idempotent)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS embedding vector(768);

-- ivfflat indeksi — CONCURRENTLY ile tablo lock alınmadan oluşturulur.
-- Büyük production tablolarında (~milyonlarca satır) kritik: normal CREATE INDEX
-- tüm yazma işlemlerini bloke eder, CONCURRENTLY bunu önler.
-- NOT: CONCURRENTLY, IF NOT EXISTS ile birlikte kullanılamaz (PG kısıtı).
-- Bu nedenle idempotent yapı DO bloğu ile sağlanmıştır.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'messages'
      AND indexname  = 'messages_embedding_idx'
  ) THEN
    EXECUTE $idx$
      CREATE INDEX CONCURRENTLY messages_embedding_idx
        ON messages USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    $idx$;
  END IF;
END;
$$;

COMMENT ON COLUMN messages.embedding IS
  'pgvector embedding (768d) — Sprint 112, nomic-embed-text provider (Ollama)';

-- Performans kontrolü (opsiyonel)
-- EXPLAIN (ANALYZE, BUFFERS) SELECT _id FROM messages
--   ORDER BY embedding <=> '[0.1,0.2,...]' LIMIT 10;

-- İndeks durumu kontrolü (opsiyonel)
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'messages' AND indexname = 'messages_embedding_idx';
