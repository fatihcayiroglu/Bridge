// server/tests/pgvector.test.ts
// Sprint 112 — lib/pgvector.ts birim testleri
// Kapsam:
//   - generateEmbedding: PGVECTOR_ENABLED=false → null
//   - generateEmbedding: openai provider (fetch mock)
//   - generateEmbedding: ollama/nomic provider (fetch mock)
//   - generateEmbedding: hata → null (fallback)
//   - generateEmbedding: boş metin → null
//   - vectorSearch: embedding boşsa [] döner
//   - vectorSearch: DB sorgusu doğru SQL üretir
//   - vectorSearch: similarity eşiği filtresi (PGVECTOR_SIMILARITY_THRESHOLD)
//   - vectorSearch: DB hatası → [] (fallback)
//   - saveMessageEmbedding: PGVECTOR_ENABLED=false → erken çıkış
//   - saveMessageEmbedding: embedding üretilir ve DB'ye kaydedilir
//   - saveMessageEmbedding: DB hatası → uyarı loglar
//   - getMigrationSql: SQL içeriği
//   - PGVECTOR_SIMILARITY_THRESHOLD: env var parse + clamp

process.env.NODE_ENV = 'test';

jest.mock('../lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), fatal: jest.fn() },
}));

const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => {
  mockFetch.mockReset();
  jest.resetModules();
});

// ════════════════════════════════════════════════════════════════════════════
// generateEmbedding
// ════════════════════════════════════════════════════════════════════════════

describe('generateEmbedding', () => {
  it('PGVECTOR_ENABLED=false → null döner', async () => {
    setEnv({ PGVECTOR_ENABLED: 'false', EMBEDDING_PROVIDER: 'nomic' });
    const { generateEmbedding } = require('../lib/pgvector');
    expect(await generateEmbedding('hello')).toBeNull();
  });

  it('boş metin → null döner', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'nomic' });
    const { generateEmbedding } = require('../lib/pgvector');
    expect(await generateEmbedding('')).toBeNull();
    expect(await generateEmbedding('   ')).toBeNull();
  });

  it('ollama/nomic provider — başarılı embedding', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'nomic', OLLAMA_BASE_URL: 'http://localhost:11434' });
    const fakeEmbedding = Array.from({ length: 768 }, (_, i) => i * 0.001);

    mockFetch.mockResolvedValueOnce({
      ok:   true,
      status: 200,
      json: async () => ({ embedding: fakeEmbedding }),
    });

    const { generateEmbedding } = require('../lib/pgvector');
    const result = await generateEmbedding('Bu haftaki önemli kararlar');
    expect(result).toHaveLength(768);
    expect(result?.[0]).toBeCloseTo(0);
  });

  it('openai provider — başarılı embedding', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });
    const fakeEmbedding = Array.from({ length: 1536 }, () => Math.random());

    mockFetch.mockResolvedValueOnce({
      ok:   true,
      status: 200,
      json: async () => ({ data: [{ embedding: fakeEmbedding }] }),
    });

    const { generateEmbedding } = require('../lib/pgvector');
    const result = await generateEmbedding('search query');
    expect(result).toHaveLength(1536);
  });

  it('openai API hatası → null döner (fallback)', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test' });

    mockFetch.mockResolvedValueOnce({
      ok:   false,
      status: 429,
      text: async () => 'rate limited',
    });

    const { generateEmbedding } = require('../lib/pgvector');
    const result = await generateEmbedding('query');
    expect(result).toBeNull();
  });

  it('ollama boş embedding → null döner', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'ollama' });

    mockFetch.mockResolvedValueOnce({
      ok:   true,
      status: 200,
      json: async () => ({ embedding: [] }),
    });

    const { generateEmbedding } = require('../lib/pgvector');
    const result = await generateEmbedding('query');
    expect(result).toBeNull();
  });

  it('openai OPENAI_API_KEY yoksa hata → null', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: undefined });
    const { generateEmbedding } = require('../lib/pgvector');
    const result = await generateEmbedding('test');
    expect(result).toBeNull();
  });

  it('bilinmeyen provider → null döner', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'unknown-provider' });
    const { generateEmbedding } = require('../lib/pgvector');
    const result = await generateEmbedding('test');
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// vectorSearch
// ════════════════════════════════════════════════════════════════════════════

describe('vectorSearch', () => {
  function makeDb(rows: Array<{ message_id: string; similarity: number }> = []) {
    return {
      query: jest.fn().mockResolvedValue({ rows }),
    };
  }

  it('embedding boşsa [] döner', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true' });
    const { vectorSearch } = require('../lib/pgvector');
    const result = await vectorSearch({ db: makeDb(), embedding: [], serverId: 'sv-1' });
    expect(result).toEqual([]);
  });

  it('DB sorgusu çağrılır — serverId parametresi içerir', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true' });
    const { vectorSearch } = require('../lib/pgvector');
    const db = makeDb([{ message_id: 'msg-1', similarity: 0.85 }]);
    const embedding = Array.from({ length: 768 }, () => 0.1);

    await vectorSearch({ db, embedding, serverId: 'sv-test', limit: 5 });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('server_id');
    expect(sql).toContain('embedding IS NOT NULL');
    expect(values).toContain('sv-test');
  });

  it('channelId filtresi SQL\'e eklenir', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true' });
    const { vectorSearch } = require('../lib/pgvector');
    const db = makeDb([]);
    const embedding = Array.from({ length: 768 }, () => 0.1);

    await vectorSearch({ db, embedding, serverId: 'sv', channelId: 'ch-xyz', limit: 10 });

    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('channel_id');
    expect(values).toContain('ch-xyz');
  });

  it('since filtresi SQL\'e eklenir', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true' });
    const { vectorSearch } = require('../lib/pgvector');
    const db = makeDb([]);
    const embedding = Array.from({ length: 768 }, () => 0.1);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

    await vectorSearch({ db, embedding, serverId: 'sv', since, limit: 10 });

    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('created_at');
    expect(values.some(v => typeof v === 'string' && v.includes('T'))).toBe(true);
  });

  it('similarity < 0.3 olan sonuçlar filtrelenir', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true' });
    const { vectorSearch } = require('../lib/pgvector');
    const db = makeDb([
      { message_id: 'msg-high', similarity: 0.75 },
      { message_id: 'msg-mid',  similarity: 0.31 },
      { message_id: 'msg-low',  similarity: 0.20 }, // filtrelenecek
    ]);
    const embedding = Array.from({ length: 768 }, () => 0.1);
    const result = await vectorSearch({ db, embedding, serverId: 'sv' });

    expect(result).toHaveLength(2);
    expect(result.map(r => r.message_id)).not.toContain('msg-low');
  });

  it('DB hatası → [] döner (fallback)', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true' });
    const { vectorSearch } = require('../lib/pgvector');
    const db = { query: jest.fn().mockRejectedValue(new Error('PG connection lost')) };
    const embedding = Array.from({ length: 768 }, () => 0.1);

    const result = await vectorSearch({ db, embedding, serverId: 'sv' });
    expect(result).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// saveMessageEmbedding
// ════════════════════════════════════════════════════════════════════════════

describe('saveMessageEmbedding', () => {
  it('PGVECTOR_ENABLED=false → DB sorgusu çağrılmaz', async () => {
    setEnv({ PGVECTOR_ENABLED: 'false' });
    const { saveMessageEmbedding } = require('../lib/pgvector');
    const db = { query: jest.fn() };
    await saveMessageEmbedding({ db, messageId: 'msg-1', content: 'test' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('embedding üretilir ve UPDATE çağrılır', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'nomic' });
    const fakeEmbedding = Array.from({ length: 768 }, () => 0.01);
    mockFetch.mockResolvedValueOnce({
      ok:   true,
      status: 200,
      json: async () => ({ embedding: fakeEmbedding }),
    });

    const { saveMessageEmbedding } = require('../lib/pgvector');
    const db = { query: jest.fn().mockResolvedValue({}) };
    await saveMessageEmbedding({ db, messageId: 'msg-abc', content: 'Merhaba dünya' });

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, values] = db.query.mock.calls[0];
    expect(sql).toContain('UPDATE messages');
    expect(sql).toContain('embedding');
    expect(values).toContain('msg-abc');
  });

  it('generateEmbedding null döndürürse UPDATE çağrılmaz', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: undefined });
    const { saveMessageEmbedding } = require('../lib/pgvector');
    const db = { query: jest.fn() };
    await saveMessageEmbedding({ db, messageId: 'msg-xyz', content: 'test' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('DB hatası → uyarı loglanır, hata fırlatılmaz', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'nomic' });
    const fakeEmbedding = Array.from({ length: 768 }, () => 0.01);
    mockFetch.mockResolvedValueOnce({
      ok:   true,
      json: async () => ({ embedding: fakeEmbedding }),
    });

    const { saveMessageEmbedding } = require('../lib/pgvector');
    const db = { query: jest.fn().mockRejectedValue(new Error('constraint violation')) };
    await expect(saveMessageEmbedding({ db, messageId: 'msg-fail', content: 'test' })).resolves.toBeUndefined();

    const logger = require('../lib/logger').default;
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-fail', event: 'pgvector.embed.save_failed' }),
      expect.any(String),
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════
// getMigrationSql
// ════════════════════════════════════════════════════════════════════════════

describe('getMigrationSql', () => {
  it('SQL içeriği doğru yapıya sahip', () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_DIMENSION: '768' });
    const { getMigrationSql } = require('../lib/pgvector');
    const sql = getMigrationSql();

    expect(sql).toContain('ALTER TABLE messages');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS embedding vector(768)');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS messages_embedding_idx');
    expect(sql).toContain('ivfflat');
    expect(sql).toContain('vector_cosine_ops');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PGVECTOR_SIMILARITY_THRESHOLD
// ════════════════════════════════════════════════════════════════════════════

describe('PGVECTOR_SIMILARITY_THRESHOLD', () => {
  it('env tanımlı değilse varsayılan 0.3 döner', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: undefined });
    const { PGVECTOR_SIMILARITY_THRESHOLD } = require('../lib/pgvector');
    expect(PGVECTOR_SIMILARITY_THRESHOLD).toBe(0.3);
  });

  it('env değeri parse edilir', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: '0.45' });
    const { PGVECTOR_SIMILARITY_THRESHOLD } = require('../lib/pgvector');
    expect(PGVECTOR_SIMILARITY_THRESHOLD).toBeCloseTo(0.45);
  });

  it('0\'ın altındaki değer 0\'a sıkıştırılır (clamp)', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: '-0.5' });
    const { PGVECTOR_SIMILARITY_THRESHOLD } = require('../lib/pgvector');
    expect(PGVECTOR_SIMILARITY_THRESHOLD).toBe(0);
  });

  it('1\'in üzerindeki değer 1\'e sıkıştırılır (clamp)', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: '1.5' });
    const { PGVECTOR_SIMILARITY_THRESHOLD } = require('../lib/pgvector');
    expect(PGVECTOR_SIMILARITY_THRESHOLD).toBe(1);
  });

  it('geçersiz string (NaN) varsayılan 0.3\'e düşer', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: 'not-a-number' });
    const { PGVECTOR_SIMILARITY_THRESHOLD } = require('../lib/pgvector');
    expect(PGVECTOR_SIMILARITY_THRESHOLD).toBe(0.3);
  });

  it('threshold vectorSearch filtrelemasında kullanılır', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', PGVECTOR_SIMILARITY_THRESHOLD: '0.5' });
    const { vectorSearch } = require('../lib/pgvector');

    const mockDb = {
      query: jest.fn().mockResolvedValue({
        rows: [
          { message_id: 'msg-high',  similarity: 0.8 },
          { message_id: 'msg-low',   similarity: 0.3 },  // 0.5 eşiğinin altında → filtrelenmeli
          { message_id: 'msg-exact', similarity: 0.5 },  // eşit → filtrele (> değil >=)
        ],
      }),
    };

    const results = await vectorSearch({
      db:        mockDb,
      embedding: [0.1, 0.2, 0.3],
      serverId:  'srv-1',
    });

    // Sadece similarity > 0.5 olanlar geçer
    expect(results).toHaveLength(1);
    expect(results[0].message_id).toBe('msg-high');
  });
});
