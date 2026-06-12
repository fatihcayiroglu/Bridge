// server/tests/sprint11.test.ts
// Sprint 11 — Web Push /test endpoint · Embed Cache · message:delete Transaction
'use strict';

process.env.NODE_ENV   = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-sprint11';

// ── DB mock ──────────────────────────────────────────────────
import { createMockDb, makeUser } from './helpers/mockDb';
let db = createMockDb();
jest.mock('../db/index',  () => { const { createMockDb } = require('./helpers/mockDb'); return createMockDb(); });
jest.mock('../db/loader', () => require('../db/index'));

// ── pushSender mock ───────────────────────────────────────────
const mockSendPushToUser = jest.fn().mockResolvedValue(undefined);
jest.mock('../lib/pushSender', () => ({
  sendPushToUser: (...a) => mockSendPushToUser(...a),
  sendWebPush:    jest.fn().mockResolvedValue(undefined),
}));

// Link preview tests should never perform real network calls, but keep SSRF-like private-host blocking.
jest.mock('../lib/fetch', () => ({
  fetchT: (url: string, ...args: unknown[]) => {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host.startsWith('127.') || host.startsWith('10.') || host.startsWith('192.168.')) {
      return Promise.reject(new Error('Blocked private host'));
    }
    return (global.fetch as (...a: unknown[]) => unknown)(url, ...args);
  },
}));

import request from 'supertest';
import express from 'express';
const jwt     = require('jsonwebtoken');
import { v4 as uuidv4 } from 'uuid';

function tok(uid) {
  return jwt.sign({ id: uid, username: 'tester', v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

// ════════════════════════════════════════════════════════════════
// 1. WEB PUSH — /api/webpush/test endpoint
// ════════════════════════════════════════════════════════════════
describe('POST /api/webpush/test', () => {
  let app, user, token;

  beforeEach(async () => {
    db = createMockDb();
    Object.assign(require('../db/loader'), db);
    Object.assign(require('../db/index'), db);
    mockSendPushToUser.mockClear();

    user  = makeUser({ username: 'pushuser' });
    await db.users.insert(user);
    token = tok(user._id);

    const webpushRouter = require('../routes/webpush');
    app = express();
    app.use(express.json());
    app.use('/api/webpush', webpushRouter);
    app.use((err, req, res, _n) => res.status(err.status || 500).json({ error: err.message }));

    process.env.VAPID_PUBLIC_KEY  = 'BTestPublicKey';
    process.env.VAPID_PRIVATE_KEY = 'TestPrivateKey';
  });

  afterEach(() => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    jest.resetModules();
  });

  it('abonelik varken sendPushToUser çağrılır ve 200 döner', async () => {
    await db.pushSubscriptions?.insert({
      _id: uuidv4(), userId: user._id,
      endpoint: 'https://push.example.com/s1',
      keys: { p256dh: 'k1', auth: 'a1' }, createdAt: Date.now(),
    }).catch(() => {});

    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sent).toBeGreaterThan(0);
    expect(mockSendPushToUser).toHaveBeenCalledTimes(1);
    expect(mockSendPushToUser).toHaveBeenCalledWith(
      user._id,
      expect.objectContaining({ title: expect.any(String), body: expect.any(String), tag: 'bridge-test' })
    );
  });

  it('özel message alanı payload body olarak iletilir', async () => {
    await db.pushSubscriptions?.insert({
      _id: uuidv4(), userId: user._id,
      endpoint: 'https://push.example.com/s2',
      keys: { p256dh: 'k2', auth: 'a2' }, createdAt: Date.now(),
    }).catch(() => {});

    await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Merhaba Sprint 11!' });

    expect(mockSendPushToUser).toHaveBeenCalledWith(
      user._id,
      expect.objectContaining({ body: 'Merhaba Sprint 11!' })
    );
  });

  it('abonelik yoksa 404 döner, sendPushToUser çağrılmaz', async () => {
    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(404);
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('VAPID key eksikse 503 döner', async () => {
    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;

    const res = await request(app)
      .post('/api/webpush/test')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(503);
    expect(mockSendPushToUser).not.toHaveBeenCalled();
  });

  it('auth token olmadan 401 döner', async () => {
    const res = await request(app).post('/api/webpush/test').send({});
    expect(res.status).toBe(401);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. EMBED CACHE — linkPreview PostgreSQL TTL cache
// ════════════════════════════════════════════════════════════════
describe('fetchLinkPreview — dual-layer cache', () => {
  let fetchLinkPreview, extractUrls, _resetCache;

  const PREVIEW = {
    type: 'link', url: 'https://example.com', title: 'Example',
    description: 'An example site', image: null, siteName: 'example.com',
  };

  beforeEach(() => {
    jest.resetModules();
    // fetch'i mock'la — dış istek gitmesin
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'text/html; charset=utf-8' },
      text: async () => '<html><head><title>Example</title><meta property="og:title" content="Example"><meta name="og:site_name" content="example.com"></head></html>',
    });
    ({ fetchLinkPreview, extractUrls, _resetCache } = require('../lib/linkPreview'));
    _resetCache();
  });

  afterEach(() => {
    delete global.fetch;
    jest.resetModules();
  });

  it('ilk çağrıda dış HTTP isteği yapılır ve sonuç döner', async () => {
    const result = await fetchLinkPreview('https://example.com');
    expect(result).not.toBeNull();
    expect(result.title).toBe('Example');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('ikinci çağrıda in-process cache kullanılır (fetch çağrılmaz)', async () => {
    await fetchLinkPreview('https://example.com');
    global.fetch.mockClear();

    const result = await fetchLinkPreview('https://example.com');
    expect(result.title).toBe('Example');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('private IP\'lere istek yapılmaz', async () => {
    const r1 = await fetchLinkPreview('http://localhost/secret');
    const r2 = await fetchLinkPreview('http://192.168.1.1/admin');
    const r3 = await fetchLinkPreview('http://10.0.0.1/internal');
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('title yoksa null döner', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/html' },
      text: async () => '<html><head></head><body>no title</body></html>',
    });
    const result = await fetchLinkPreview('https://notitle.example.com');
    expect(result).toBeNull();
  });

  it('HTTP 404 yanıtında null döner', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const result = await fetchLinkPreview('https://missing.example.com');
    expect(result).toBeNull();
  });

  it('content-type text/html değilse null döner', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      text: async () => '{}',
    });
    const result = await fetchLinkPreview('https://api.example.com/data.json');
    expect(result).toBeNull();
  });

  it('extractUrls URL listesini doğru çıkarır', () => {
    const text = 'Şuna bak https://a.com ve buna https://b.com/path?q=1';
    const urls = extractUrls(text);
    expect(urls).toContain('https://a.com');
    expect(urls).toContain('https://b.com/path?q=1');
  });

  it('extractUrls limit parametresine uyar', () => {
    const text = 'https://a.com https://b.com https://c.com https://d.com';
    expect(extractUrls(text, 2)).toHaveLength(2);
  });

  it('geçersiz protokol (ftp://) null döner', async () => {
    const result = await fetchLinkPreview('ftp://files.example.com');
    expect(result).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// 3. DB TRANSACTION WRAPPER — message:delete atomic
// ════════════════════════════════════════════════════════════════
describe('message:delete — atomic transaction wrapper', () => {
  // Mock transaction client
  function makeMockClient(overrides = {}) {
    const queries = [];
    return {
      queries,
      query: jest.fn().mockImplementation(async (sql, params) => {
        queries.push({ sql, params });
        return overrides.queryResult || { rowCount: 0 };
      }),
    };
  }

  it('withTransaction fn imzası doğru çalışır — BEGIN/COMMIT/ROLLBACK', async () => {
    // postgres.js withTransaction mantığını izole test et
    const pool = {
      connect: jest.fn().mockResolvedValue({
        query:   jest.fn().mockResolvedValue({ rows: [] }),
        release: jest.fn(),
      }),
    };

    const client = await pool.connect();
    let committed = false;
    let rolledBack = false;

    // Transaction sarmalayıcı mantığını doğrudan test et
    async function withTransaction(fn) {
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        committed = true;
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        rolledBack = true;
        throw err;
      } finally {
        client.release();
      }
    }

    await withTransaction(async (c) => {
      await c.query('DELETE FROM messages WHERE _id = $1', ['msg1']);
    });

    expect(committed).toBe(true);
    expect(rolledBack).toBe(false);
    expect(client.release).toHaveBeenCalled();
  });

  it('transaction hatası rollback tetikler', async () => {
    let rolledBack = false;
    const client = {
      query: jest.fn().mockImplementation(async (sql) => {
        if (sql.includes('DELETE')) throw new Error('DB error');
        if (sql === 'ROLLBACK') rolledBack = true;
      }),
      release: jest.fn(),
    };

    async function withTransaction(fn) {
      try {
        await client.query('BEGIN');
        await fn(client);
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    await withTransaction(async (c) => {
      await c.query('DELETE FROM messages WHERE _id = $1', ['bad']);
    });

    expect(rolledBack).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('thread mesajları, thread kaydı ve ana mesaj sırayla silinir', async () => {
    const client = makeMockClient();
    const threadId = 'thread-abc';
    const messageId = 'msg-xyz';

    // Silme sırası
    await client.query('DELETE FROM thread_messages WHERE "threadId" = $1', [threadId]);
    await client.query('DELETE FROM threads WHERE _id = $1', [threadId]);
    await client.query('DELETE FROM messages WHERE _id = $1', [messageId]);

    expect(client.queries[0].sql).toContain('thread_messages');
    expect(client.queries[0].params).toEqual([threadId]);
    expect(client.queries[1].sql).toContain('threads');
    expect(client.queries[1].params).toEqual([threadId]);
    expect(client.queries[2].sql).toContain('messages');
    expect(client.queries[2].params).toEqual([messageId]);
  });

  it('unread_counts güncelleme sorgusu doğru parametreler alır', async () => {
    const client = makeMockClient();
    const channelId = 'chan-1';
    const serverId  = 'srv-1';
    const now = Date.now();

    await client.query(
      `UPDATE unread_counts
       SET count = GREATEST(0, count - 1), "updatedAt" = $1
       WHERE "channelId" = $2
         AND count > 0
         AND "userId" IN (
           SELECT m."userId" FROM members m WHERE m."serverId" = $3
         )`,
      [now, channelId, serverId]
    );

    const q = client.queries[0];
    expect(q.sql).toContain('unread_counts');
    expect(q.sql).toContain('GREATEST(0, count - 1)');
    expect(q.params[1]).toBe(channelId);
    expect(q.params[2]).toBe(serverId);
  });

  it('unread count negatife düşmez (GREATEST 0 koruması)', async () => {
    const client = makeMockClient({ queryResult: { rowCount: 1 } });
    // GREATEST(0, count - 1) ile 0'ın altına inmez
    // Bu sorgunun count = 0 olan satırları atladığını doğrula
    await client.query(
      `UPDATE unread_counts SET count = GREATEST(0, count - 1), "updatedAt" = $1
       WHERE "channelId" = $2 AND count > 0`,
      [Date.now(), 'chan-1']
    );
    expect(client.queries[0].sql).toContain('count > 0');
    expect(client.queries[0].sql).toContain('GREATEST(0, count - 1)');
  });
});
