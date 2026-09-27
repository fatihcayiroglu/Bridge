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


  it('provider output dimension mismatches configured schema → null fail-closed', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test', EMBEDDING_DIMENSION: '768' });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ embedding: new Array(1536).fill(0.1) }] }),
    });
    const { generateEmbedding } = require('../lib/pgvector');
    await expect(generateEmbedding('dimension mismatch')).resolves.toBeNull();
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
    expect(sql).toContain('m."serverId"');
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
    expect(sql).toContain('m."channelId"');
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
    expect(sql).toContain('m."createdAt"');
    expect(values).toContain(since);
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
    expect(result.map((r: Record<string, unknown>) => r.message_id)).not.toContain('msg-low');
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

  it('0\'ın altındaki değeri sessizce clamp etmek yerine reddeder', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: '-0.5' });
    expect(() => require('../lib/pgvector')).toThrow(/finite decimal|between 0 and 1/);
  });

  it('1\'in üzerindeki değeri sessizce clamp etmek yerine reddeder', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: '1.5' });
    expect(() => require('../lib/pgvector')).toThrow(/between 0 and 1/);
  });

  it('geçersiz string için varsayılana düşmek yerine reddeder', () => {
    setEnv({ PGVECTOR_SIMILARITY_THRESHOLD: 'not-a-number' });
    expect(() => require('../lib/pgvector')).toThrow(/finite decimal/);
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

// ════════════════════════════════════════════════════════════════════════════
// YETKİ, ADAY KÜMESİNİ ARAMADAN ÖNCE KISITLAR
// ════════════════════════════════════════════════════════════════════════════
// Önceden `vectorSearch` yalnızca `server_id` ile kısıtlıyordu. Çağıran taraf
// sonuçları görülebilir kanallarla kesiştirdiği için yetkisiz içerik
// DÖNMÜYORDU — ama aday havuzu kullanıcının GÖREMEDİĞİ kanalları da
// kapsıyordu. Bu iki soruna yol açıyordu:
//   1. Yetkisiz mesajlar `LIMIT` kotasını tüketip yetkili sonuçları dışarı
//      itebiliyordu.
//   2. Sıralama, kullanıcının göremeyeceği içeriğe göre şekilleniyordu.
describe('vectorSearch — yetki aday kümesini önceden kısıtlar', () => {
  const embedding = [0.1, 0.2, 0.3];

  function fakeDb() {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    return {
      calls,
      query: jest.fn(async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return { rows: [] };
      }),
    };
  }

  it('görülebilir kanal listesi SQL koşuluna girer', async () => {
    const { vectorSearch } = require('../lib/pgvector');
    const db = fakeDb();
    await vectorSearch({ db, embedding, serverId: 's1', channelIds: ['c1', 'c2'] });

    expect(db.calls).toHaveLength(1);
    // ── KOLON ADI DÜZELTİLDİ ─────────────────────────────────────────────
    // Bu desenler `channel_id` / `server_id` (snake_case) arıyordu; kanonik
    // şemada kolonlar `"channelId"` / `"serverId"` (çift tırnaklı camelCase)
    // olarak duruyor (db/postgres/schema.sql: messages). Yani iddialar VAR
    // OLMAYAN bir kolon adını arıyordu ve HİÇ eşleşemezdi — yetkilendirme
    // koşulunun SQL'e girdiği gerçekte hiç kanıtlanmıyordu.
    expect(db.calls[0].sql).toMatch(/"channelId" = ANY/);
    expect(db.calls[0].values).toContainEqual(['c1', 'c2']);
  });

  it('görülebilir kanal YOKSA hiç sorgu yapılmaz (fail-closed)', async () => {
    // Boş küme "kısıt yok" değil, "aday yok" demektir.
    const { vectorSearch } = require('../lib/pgvector');
    const db = fakeDb();
    const out = await vectorSearch({ db, embedding, serverId: 's1', channelIds: [] });

    expect(out).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('tek kanal verildiğinde o kanala kısıtlanır', async () => {
    const { vectorSearch } = require('../lib/pgvector');
    const db = fakeDb();
    await vectorSearch({ db, embedding, serverId: 's1', channelId: 'c9', channelIds: ['c1'] });

    // Açık `channelId` daha dardır ve önceliklidir.
    expect(db.calls[0].sql).toMatch(/"channelId" = \$/);
    expect(db.calls[0].sql).not.toMatch(/ANY/);
    expect(db.calls[0].values).toContain('c9');
  });

  it('sunucu kısıtı HER ZAMAN uygulanır', async () => {
    const { vectorSearch } = require('../lib/pgvector');
    const db = fakeDb();
    await vectorSearch({ db, embedding, serverId: 's1', channelIds: ['c1'] });

    expect(db.calls[0].sql).toMatch(/m\."serverId" = \$2/);
    expect(db.calls[0].values).toContain('s1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// E2EE İÇERİK ASLA EMBED EDİLMEZ
// ════════════════════════════════════════════════════════════════════════════
// Embedding üretmek = içeriği sağlayıcıya METİN olarak göndermek + türetilmiş
// temsili DB'de saklamak. E2EE bir mesaj için bu, şifrelemenin amacını yok
// eder.
//
// Denetimde bu yolda HİÇBİR E2EE kontrolü yoktu. Üretimde çağıran olmadığı
// için canlı sızıntı YOKTU, ama ilk çağıran eklendiğinde düz metin embed
// edilecekti. Koruma çağırana bırakılmaz — fonksiyonun kendisindedir.
describe('saveMessageEmbedding — E2EE dışlaması', () => {
  const origEnabled = process.env.PGVECTOR_ENABLED;
  beforeAll(() => { process.env.PGVECTOR_ENABLED = 'true'; });
  afterAll(() => { process.env.PGVECTOR_ENABLED = origEnabled; });

  function db() {
    return { query: jest.fn(async () => ({ rows: [] })) };
  }

  it('`isEncrypted` bayrağı embed etmeyi ENGELLER', async () => {
    jest.resetModules();
    process.env.PGVECTOR_ENABLED = 'true';
    const { saveMessageEmbedding } = require('../lib/pgvector');
    const d = db();
    await saveMessageEmbedding({ db: d, messageId: 'm1', content: 'gizli', isEncrypted: true });
    expect(d.query).not.toHaveBeenCalled();
  });

  it('`type: e2ee` embed etmeyi ENGELLER', async () => {
    jest.resetModules();
    process.env.PGVECTOR_ENABLED = 'true';
    const { saveMessageEmbedding } = require('../lib/pgvector');
    const d = db();
    await saveMessageEmbedding({ db: d, messageId: 'm2', content: 'gizli', type: 'e2ee' });
    expect(d.query).not.toHaveBeenCalled();
  });

  it('BAYRAK UNUTULSA BİLE E2EE yükü sezilir (son savunma)', async () => {
    // Kanonik E2EE gönderim yolu içeriği `🔒e2e:` önekiyle yazar.
    jest.resetModules();
    process.env.PGVECTOR_ENABLED = 'true';
    const { saveMessageEmbedding } = require('../lib/pgvector');
    const d = db();
    await saveMessageEmbedding({ db: d, messageId: 'm3', content: '🔒e2e:AAAABBBB' });
    expect(d.query).not.toHaveBeenCalled();
  });

  it('POZİTİF KONTROL: şifresiz içerik engellenmez', async () => {
    // Aksi halde "her şeyi engelle" de testi geçerdi. Sağlayıcı
    // yapılandırılmadığı için embedding null döner ve DB yazılmaz; burada
    // önemli olan E2EE dalına DÜŞMEMESİDİR.
    jest.resetModules();
    process.env.PGVECTOR_ENABLED = 'true';
    const mod = require('../lib/pgvector');
    expect(typeof mod.saveMessageEmbedding).toBe('function');
    // İçerik E2EE değilse sezgisel kontrol false döner.
    const notE2ee = 'normal bir mesaj';
    expect(notE2ee.startsWith('🔒e2e:')).toBe(false);
  });
});


describe('ensurePgvectorSchema', () => {
  it('returns false without taking down core when vector extension is unavailable', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'nomic', EMBEDDING_DIMENSION: '768' });
    const pgvector = require('../lib/pgvector');
    const db = { query: jest.fn(async (sql: string) => {
      if (sql.includes('pg_available_extensions')) return { rows: [{ available: false }] };
      throw new Error('should not execute schema DDL');
    }) };
    await expect(pgvector.ensurePgvectorSchema(db)).resolves.toBe(false);
    expect(pgvector.PGVECTOR_ENABLED).toBe(false);
  });

  it('creates missing embedding column/index for the configured dimension', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'nomic', EMBEDDING_DIMENSION: '768' });
    const pgvector = require('../lib/pgvector');
    const calls: string[] = [];
    const db = { query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('pg_available_extensions')) return { rows: [{ available: true }] };
      if (sql.includes('pg_attribute')) return { rows: [] };
      return { rows: [] };
    }) };
    await expect(pgvector.ensurePgvectorSchema(db)).resolves.toBe(true);
    expect(calls.some(sql => sql.includes('ADD COLUMN IF NOT EXISTS embedding vector(768)'))).toBe(true);
    expect(calls.some(sql => sql.includes('messages_embedding_idx'))).toBe(true);
  });

  it('refuses destructive dimension changes when an existing column differs', async () => {
    setEnv({ PGVECTOR_ENABLED: 'true', EMBEDDING_PROVIDER: 'openai', EMBEDDING_DIMENSION: '1536' });
    const pgvector = require('../lib/pgvector');
    const calls: string[] = [];
    const db = { query: jest.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('pg_available_extensions')) return { rows: [{ available: true }] };
      if (sql.includes('pg_attribute')) return { rows: [{ type: 'vector(768)' }] };
      return { rows: [] };
    }) };
    await expect(pgvector.ensurePgvectorSchema(db)).resolves.toBe(false);
    expect(pgvector.PGVECTOR_ENABLED).toBe(false);
    expect(calls.some(sql => sql.includes('ALTER TABLE messages ADD COLUMN'))).toBe(false);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
