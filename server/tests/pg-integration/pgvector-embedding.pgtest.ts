// server/tests/pg-integration/pgvector-embedding.pgtest.ts
//
// P6 — the pgvector embedding writer and its live caller on a REAL PostgreSQL
// with the `vector` extension.
//
// The embedding provider is a deterministic local double (hashed bag of words)
// behind `fetch`, recording every text that would have crossed the provider
// boundary. Everything else is production code against the real database:
// the boot schema (migrations + optional pgvector schema + triggers), the
// guarded writer, the sweep, the purge and vector search.
//
// Runs only with PGVECTOR_TEST_URL (a database whose server has pgvector) and
// FAILS — it does not skip — if the extension is missing there: a skipped
// suite is not evidence. Removes its own rows.

const VECTOR_URL = process.env.PGVECTOR_TEST_URL;
// Collected only in the dedicated PGVECTOR_TEST_URL run (real extension).
// An incorrectly configured explicit run must fail instead of being skipped.
const RUN = describe;
const DIM = 64;
const P = 'pgt-vec';

/** Deterministic embedding: hashed bag of lower-cased words, L2-normalised. */
function hashEmbed(text: string, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (const tok of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 0x811c9dc5;
    for (const ch of tok) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 0x01000193) >>> 0; }
    v[h % (dim - 1)] += 1;
  }
  v[dim - 1] = 0.01; // never the zero vector
  const n = Math.hypot(...v);
  return v.map((x) => Number((x / n).toFixed(6)));
}

RUN('real PostgreSQL + pgvector — the embedding writer and its live caller (P6)', () => {
  const sent: string[] = [];
  let mode: 'ok' | 'fail' = 'ok';
  let duringProvider: (() => Promise<void>) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any; let pgvector: any; let jobs: any;
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;

  const seedServer = async (id: string, aiEnabled = true) =>
    q(`INSERT INTO servers (_id, name, "ownerId", "createdAt", "aiEnabled") VALUES ($1, 'S', 'o', 1, $2)`, [id, aiEnabled]);
  let seq = 0;
  const seedMessage = async (serverId: string, content: string, extra: Record<string, unknown> = {}) => {
    const id = `${P}-m${++seq}`;
    const cols = { _id: id, channelId: `${serverId}-c`, serverId, userId: 'u', username: 'u', displayName: 'U', content, createdAt: Date.now() - 1000 + seq, ...extra };
    const keys = Object.keys(cols);
    await q(`INSERT INTO messages (${keys.map((k) => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(cols));
    return id;
  };
  const vectorOf = async (id: string) => (await q(`SELECT embedding::text AS e FROM messages WHERE _id = $1`, [id]))[0]?.e ?? null;
  const sweep = (opts = {}) => jobs.runEmbedSweep(db._pool, { batchSize: 1000, windowMs: 3_600_000, ...opts });
  const cleanup = async () => {
    await q(`DELETE FROM messages WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);
  };

  beforeAll(async () => {
    if (!VECTOR_URL) throw new Error('PGVECTOR_TEST_URL required for pgvector integration');
    process.env.DATABASE_URL = VECTOR_URL;
    process.env.PGVECTOR_ENABLED = 'true';
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://embedder.test';
    process.env.EMBEDDING_DIMENSION = String(DIM);
    delete process.env.AI_PROVIDER;
    (global as { fetch?: unknown }).fetch = async (url: string, init: { body: string }) => {
      const { prompt } = JSON.parse(init.body) as { prompt: string };
      sent.push(prompt);
      if (duringProvider) { const f = duringProvider; duringProvider = null; await f(); }
      if (mode === 'fail') return { ok: false, status: 503, text: async () => 'unavailable' };
      return { ok: true, status: 200, json: async () => ({ embedding: hashEmbed(prompt) }) };
    };
    db = require('../../db/loader').default;
    await db._initSchema();
    pgvector = require('../../lib/pgvector');
    jobs = require('../../jobs/embedHistory');
    await cleanup();
  });
  afterAll(async () => { await cleanup(); });
  beforeEach(() => { sent.length = 0; mode = 'ok'; duringProvider = null; });

  it('boot creates the extension, the vector column and both invalidation triggers', async () => {
    expect(pgvector.PGVECTOR_ENABLED).toBe(true);
    expect((await q(`SELECT extname FROM pg_extension WHERE extname = 'vector'`)).length).toBe(1);
    const [col] = await q(`SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid = 'messages'::regclass AND a.attname = 'embedding'`);
    expect(col.t).toBe(`vector(${DIM})`);
    const triggers = (await q(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('messages_embedding_invalidate','servers_ai_off_purge_embeddings') ORDER BY 1`)).map((r: { tgname: string }) => r.tgname);
    expect(triggers).toEqual(['messages_embedding_invalidate', 'servers_ai_off_purge_embeddings']);
    // A second boot does not fail and does not duplicate anything.
    await expect(pgvector.ensurePgvectorSchema(db._pool)).resolves.toBe(true);
  });

  it('the sweep embeds an eligible message with the provider vector for exactly its text', async () => {
    await seedServer(`${P}-s1`);
    const id = await seedMessage(`${P}-s1`, 'quokka migration report');
    const stats = await sweep();
    expect(stats.embedded).toBeGreaterThanOrEqual(1);
    expect(sent).toContain('quokka migration report');
    expect(await vectorOf(id)).toBe(`[${hashEmbed('quokka migration report').join(',')}]`);
    // Idempotent: a second pass sends nothing for it.
    sent.length = 0;
    await sweep();
    expect(sent).not.toContain('quokka migration report');
  });

  it('nothing ineligible reaches the provider or gets a vector', async () => {
    await seedServer(`${P}-s2`);
    await seedServer(`${P}-off`, false);
    const ids = [
      await seedMessage(`${P}-s2`, 'deleted secret alpha', { deletedAt: Date.now() }),
      await seedMessage(`${P}-s2`, 'encrypted placeholder beta', { encryptedContent: 'CIPHERTEXT' }),
      await seedMessage(`${P}-s2`, '🔒e2e:AAAABBBBCCCC'),
      await seedMessage(`${P}-s2`, 'system notice gamma', { type: 'system' }),
      await seedMessage(`${P}-off`, 'opted out server delta'),
    ];
    await sweep();
    for (const text of ['deleted secret alpha', 'encrypted placeholder beta', '🔒e2e:AAAABBBBCCCC', 'system notice gamma', 'opted out server delta']) {
      expect(sent).not.toContain(text);
    }
    for (const id of ids) expect(await vectorOf(id)).toBeNull();
  });

  it('an edit clears the vector in the same statement; the sweep re-embeds the new text', async () => {
    await seedServer(`${P}-s3`);
    const id = await seedMessage(`${P}-s3`, 'original wording epsilon');
    await sweep();
    expect(await vectorOf(id)).not.toBeNull();
    await q(`UPDATE messages SET content = 'edited wording zeta', "editedAt" = $2 WHERE _id = $1`, [id, Date.now()]);
    expect(await vectorOf(id)).toBeNull(); // the trigger, not the application
    await sweep();
    expect(sent).toContain('edited wording zeta');
    expect(await vectorOf(id)).toBe(`[${hashEmbed('edited wording zeta').join(',')}]`);
  });

  it('CONTROL: without the trigger an edit leaves the stale vector behind (rolled back)', async () => {
    await seedServer(`${P}-s3c`);
    const id = await seedMessage(`${P}-s3c`, 'control wording omicron');
    await sweep();
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER messages_embedding_invalidate ON messages');
      await client.query(`UPDATE messages SET content = 'control edited pi' WHERE _id = $1`, [id]);
      const { rows } = await client.query(`SELECT embedding IS NOT NULL AS stale FROM messages WHERE _id = $1`, [id]);
      expect(rows[0].stale).toBe(true); // the vector of 'control wording omicron' now sits on 'control edited pi'
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect((await q(`SELECT 1 FROM pg_trigger WHERE tgname = 'messages_embedding_invalidate'`)).length).toBe(1);
  });

  it('a soft delete clears the vector and the placeholder is never embedded', async () => {
    await seedServer(`${P}-s4`);
    const id = await seedMessage(`${P}-s4`, 'soon deleted eta');
    await sweep();
    expect(await vectorOf(id)).not.toBeNull();
    // The production soft-delete statement (lib/deleteMessageCascade.ts).
    await q(`UPDATE messages SET content = '[Mesaj silindi]', "deletedAt" = $1, "deletedBy" = 'u' WHERE _id = $2`, [Date.now(), id]);
    expect(await vectorOf(id)).toBeNull();
    await sweep();
    expect(sent).not.toContain('[Mesaj silindi]');
    expect(await vectorOf(id)).toBeNull();
  });

  it('a no-op update (same content) keeps the vector — no needless re-embedding', async () => {
    await seedServer(`${P}-s5`);
    const id = await seedMessage(`${P}-s5`, 'stable theta');
    await sweep();
    const before = await vectorOf(id);
    await q(`UPDATE messages SET content = content, pinned = TRUE WHERE _id = $1`, [id]);
    expect(await vectorOf(id)).toBe(before);
  });

  it('the owner turning AI off removes that server\'s vectors in the same transaction; the neighbour keeps its own', async () => {
    const { Servers } = require('../../db/repositories');
    await seedServer(`${P}-s6`);
    await seedServer(`${P}-s7`);
    const mine = await seedMessage(`${P}-s6`, 'owner opts out iota');
    const neighbour = await seedMessage(`${P}-s7`, 'neighbour keeps kappa');
    await sweep();
    expect(await vectorOf(mine)).not.toBeNull();
    await Servers.update(`${P}-s6`, { aiEnabled: false });
    expect(await vectorOf(mine)).toBeNull();
    expect(await vectorOf(neighbour)).not.toBeNull();
    sent.length = 0;
    await sweep();
    expect(sent).not.toContain('owner opts out iota');
    // Re-enable: the sweep indexes it again.
    await Servers.update(`${P}-s6`, { aiEnabled: true });
    await sweep();
    expect(sent).toContain('owner opts out iota');
    expect(await vectorOf(mine)).not.toBeNull();
  });

  it('an edit that lands while the provider works wins: the stale vector is discarded', async () => {
    await seedServer(`${P}-s8`);
    const id = await seedMessage(`${P}-s8`, 'racing text lambda');
    duringProvider = async () => { await q(`UPDATE messages SET content = 'raced edit mu' WHERE _id = $1`, [id]); };
    const r = await pgvector.saveMessageEmbedding({ db: db._pool, messageId: id, content: 'racing text lambda' });
    expect(r).toBe('stale');
    expect(await vectorOf(id)).toBeNull();
    await sweep();
    expect(await vectorOf(id)).toBe(`[${hashEmbed('raced edit mu').join(',')}]`);
  });

  it('provider outage: rows stay pending, the pass stops early, and a later pass (any process) embeds them', async () => {
    await seedServer(`${P}-s9`);
    const ids = [];
    for (let i = 0; i < 6; i++) ids.push(await seedMessage(`${P}-s9`, `outage message ${i} nu`));
    mode = 'fail';
    const down = await sweep({ maxFailures: 2 });
    expect(down.stopped).toBe('failures');
    expect(sent.length).toBe(2); // bounded: not one request per pending row
    for (const id of ids) expect(await vectorOf(id)).toBeNull();
    // "Pending" is database state, not process state: a fresh module instance
    // (what a restarted process loads) finds and finishes the same rows.
    mode = 'ok';
    let fresh: typeof jobs;
    jest.isolateModules(() => { fresh = require('../../jobs/embedHistory'); });
    await fresh.runEmbedSweep(db._pool, { batchSize: 1000, windowMs: 3_600_000 });
    for (const id of ids) expect(await vectorOf(id)).not.toBeNull();
  });

  it('vector search ranks only visible, live rows of the server', async () => {
    await seedServer(`${P}-s10`);
    const visible = await seedMessage(`${P}-s10`, 'wombat budget review', { channelId: `${P}-s10-pub` });
    const hidden = await seedMessage(`${P}-s10`, 'wombat budget secret', { channelId: `${P}-s10-priv` });
    const gone = await seedMessage(`${P}-s10`, 'wombat budget gone', { channelId: `${P}-s10-pub` });
    await sweep();
    await q(`UPDATE messages SET content = '[Mesaj silindi]', "deletedAt" = $1 WHERE _id = $2`, [Date.now(), gone]);
    // A tiny table: make the planner use an exact scan rather than ivfflat probes.
    const client = await db._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_indexscan = off');
      const hits = await pgvector.vectorSearch({
        db: client, embedding: hashEmbed('wombat budget'), serverId: `${P}-s10`, channelIds: [`${P}-s10-pub`], limit: 10,
      });
      await client.query('ROLLBACK');
      const ids = hits.map((h: { message_id: string }) => h.message_id);
      expect(ids).toContain(visible);
      expect(ids).not.toContain(hidden);
      expect(ids).not.toContain(gone);
    } finally {
      client.release();
    }
  });

  it('the nightly purge clears vectors an older version left on rows that may not have one', async () => {
    await seedServer(`${P}-s11`);
    // INSERT with a vector bypasses the UPDATE trigger: this is what a pre-P6
    // batch left behind (a deleted placeholder that was embedded).
    const legacy = await seedMessage(`${P}-s11`, '[Mesaj silindi]', { deletedAt: Date.now() });
    await q(`UPDATE messages SET embedding = $1::vector WHERE _id = $2`, [`[${hashEmbed('x').join(',')}]`, legacy]);
    const keep = await seedMessage(`${P}-s11`, 'kept xi');
    await sweep();
    expect(await vectorOf(legacy)).not.toBeNull();
    const cleared = await jobs.purgeIneligibleEmbeddings(db._pool);
    expect(cleared).toBeGreaterThanOrEqual(1);
    expect(await vectorOf(legacy)).toBeNull();
    expect(await vectorOf(keep)).not.toBeNull();
  });
});

export {};
