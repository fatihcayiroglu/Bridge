# ADR-0011 — Semantik Arama: pgvector Embedding Stratejisi

**Tarih:** 2026-06-03  
**Durum:** Kabul edildi — Faz 1 tamamlandı (Sprint 112)  
**Sprint:** 112  
**Karar verenler:** Bridge geliştirme ekibi

---

## Bağlam

Sprint 111'de `POST /api/semantic/search` endpoint'i "AI arama" olarak sunuldu; ancak `AI_ENABLED=false` ortamında (ki çoğu self-host kurulum böyle) yalnızca basit keyword eşleşmesi yapılıyordu. Bu, "semantik arama" adını hak etmiyordu.

Gerçek semantik arama için iki yaklaşım değerlendirildi:

1. **Harici AI API** (OpenAI, Groq): Embedding API key gerektirir; self-host ortamında maliyet/bağımlılık sorunları yaratır.
2. **Yerel embedding (Ollama/Nomic) + pgvector**: API key gerektirmez; self-hosted; PostgreSQL 16 zaten projede mevcut.

---

## Değerlendirilen Seçenekler

### Seçenek A: Elasticsearch / OpenSearch

**Avantaj**: Güçlü tam-metin + vektör arama, ölçeklenebilir.  
**Dezavantaj**: Ek servis bağımlılığı; self-host için karmaşıklık artışı; PostgreSQL zaten var.  
**Sonuç**: Reddedildi.

### Seçenek B: Sadece OpenAI Embedding API

**Avantaj**: Yüksek kalite embedding (text-embedding-3-small).  
**Dezavantaj**: API key zorunlu; self-host için ideal değil; maliyet.  
**Sonuç**: Opsiyonel olarak destekleniyor (EMBEDDING_PROVIDER=openai), varsayılan değil.

### Seçenek C: pgvector + Ollama/Nomic (bu ADR) ✅

**Avantaj**:
- PostgreSQL 16 zaten mevcut — ek servis yok.
- `nomic-embed-text` (768d) yerel çalışır, API key gerekmez.
- `pgvector` ivfflat indeksi → cosine similarity milli-saniye ölçeğinde.
- Mevcut keyword fallback korunuyor; pgvector devre dışıysa sıfır regresyon.

**Dezavantaj**: PostgreSQL `pgvector` extension gerektirir; geçmiş mesajların batch embed edilmesi gerekir (Faz 2).

**Sonuç**: Seçildi.

---

## Karar

### Ortam Değişkenleri

```env
PGVECTOR_ENABLED=true             # Varsayılan: false (opt-in)
EMBEDDING_PROVIDER=nomic          # nomic | ollama | openai
OLLAMA_BASE_URL=http://localhost:11434
EMBEDDING_MODEL=nomic-embed-text  # 768d
EMBEDDING_DIMENSION=768
# Opsiyonel:
OPENAI_API_KEY=sk-...             # EMBEDDING_PROVIDER=openai ise
```

### Arama Öncelik Sırası (semantic.ts)

```
1. pgvector (PGVECTOR_ENABLED=true + embedding mevcut)
   → cosine similarity, similarity > 0.3 filtresi
   → provider: "pgvector:nomic"

2. AI (AI_ENABLED=true, pgvector yoksa veya başarısızsa)
   → Groq/Gemini/OpenRouter ile transcript tabanlı
   → provider: "groq" / "gemini" / ...

3. Keyword fallback (her durumda son çare)
   → basit kelime eşleşmesi
   → provider: "rules"
```

### Faz Planı

| Faz | Sprint | Kapsam |
|-----|--------|--------|
| Faz 1 | Sprint 112 ✅ | `lib/pgvector.ts`, migration SQL, semantic.ts entegrasyon, yeni mesajlar embed |
| Faz 2 | Sprint 115 | Geçmiş mesaj batch embed (background job, büyük tablo) |
| Faz 3 | Sprint 118 | HNSW indeks değerlendirmesi (ivfflat → HNSW performans karşılaştırması) |

### Migration

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding vector(768);
CREATE INDEX IF NOT EXISTS messages_embedding_idx
  ON messages USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

Migration dosyası: `server/db/migrations/sprint112_pgvector_embeddings.sql`

---

## Sonuç

pgvector + Ollama/Nomic seçeneği, self-host uyumluluğunu bozmadan gerçek semantik aramanın önünü açar. OpenAI desteği opsiyonel olarak sağlanmaktadır. Keyword fallback tam korunmaktadır.

---

## İlgili Belgeler

- [ADR-0004 — Federation ActivityPub](ADR-0004-federation-activitypub.md)
- [ADR-0009 — Observability Stratejisi](ADR-0009-observability-strategy.md)
- [server/lib/pgvector.ts](../server/lib/pgvector.ts)
- [server/db/migrations/sprint112_pgvector_embeddings.sql](../server/db/migrations/sprint112_pgvector_embeddings.sql)
