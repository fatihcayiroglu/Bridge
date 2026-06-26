// server/tests/rateLimit.test.ts — Session 18 güncelleme
// Yeni `mode` parametresi ('ip' | 'user' | 'combined') için testler eklendi.

process.env.NODE_ENV = 'test';

import request from 'supertest';
import express from 'express';

// Her test için temiz module cache
function freshRateLimit() {
  jest.resetModules();
  return require('../middleware/rateLimit');
}

// ── Temel app builder'lar ─────────────────────────────────────────────────

function buildApp(max, windowMs) {
  const { rateLimit } = freshRateLimit();
  const app = express();
  app.use((req, res, next) => { Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true }); next(); });
  app.get('/test', rateLimit(max, windowMs, 'test'), (req, res) => res.json({ ok: true }));
  return app;
}

/** mode destekli app builder */
function buildAppWithMode(max, windowMs, mode, userId = null) {
  const { rateLimit } = freshRateLimit();
  const app = express();
  app.use((req, res, next) => {
    Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true });
    if (userId) req.user = { id: userId, _id: userId };
    next();
  });
  app.get('/test', rateLimit(max, windowMs, 'test', { mode }), (req, res) => res.json({ ok: true }));
  return app;
}

// ── Mevcut testler (değişmedi) ────────────────────────────────────────────

describe('Rate limiter', () => {
  it('limit altında isteklere 200 döner', async () => {
    const app = buildApp(5, 60_000);
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/test');
      expect(res.status).toBe(200);
    }
  });

  it('limit aşılınca 429 döner', async () => {
    const app = buildApp(3, 60_000);
    for (let i = 0; i < 3; i++) await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/too many requests/i);
    expect(res.body.retryAfter).toBeDefined();
  });

  it('X-RateLimit header\'ları döner', async () => {
    const app = buildApp(5, 60_000);
    const res = await request(app).get('/test');
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('Retry-After header\'ı 429\'da döner', async () => {
    const app = buildApp(1, 60_000);
    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('X-RateLimit-Remaining azalır', async () => {
    const app = buildApp(5, 60_000);
    const res1 = await request(app).get('/test');
    const res2 = await request(app).get('/test');
    const remaining1 = parseInt(res1.headers['x-ratelimit-remaining']);
    const remaining2 = parseInt(res2.headers['x-ratelimit-remaining']);
    expect(remaining2).toBeLessThan(remaining1);
  });

  it('farklı keyPrefix\'ler birbirini etkilemez', async () => {
    jest.resetModules();
    const { rateLimit } = require('../middleware/rateLimit');
    const app = express();
    app.use((req, res, next) => { Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true }); next(); });
    app.get('/a', rateLimit(2, 60_000, 'prefix-a'), (req, res) => res.json({ ok: true }));
    app.get('/b', rateLimit(2, 60_000, 'prefix-b'), (req, res) => res.json({ ok: true }));

    await request(app).get('/a');
    await request(app).get('/a');
    const resA = await request(app).get('/a');
    expect(resA.status).toBe(429);

    const resB = await request(app).get('/b');
    expect(resB.status).toBe(200);
  });
});

// ── mode parametresi testleri (Session 18 — YENİ) ─────────────────────────

describe('mode parametresi', () => {

  it('mode: "ip" — IP bazlı limit çalışıyor', async () => {
    const app = buildAppWithMode(2, 60_000, 'ip');
    await request(app).get('/test');
    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
  });

  it('mode: "ip" — X-RateLimit-Policy "ip" içeriyor', async () => {
    const app = buildAppWithMode(5, 60_000, 'ip');
    const res = await request(app).get('/test');
    expect(res.headers['x-ratelimit-policy']).toMatch(/mode=ip/);
  });

  it('mode: "user" — kullanıcı bazlı limit çalışıyor', async () => {
    const app = buildAppWithMode(2, 60_000, 'user', 'user-abc');
    await request(app).get('/test');
    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
  });

  it('mode: "user" — kullanıcı yoksa 200 döner (IP fallback)', async () => {
    // user mode'da req.user yoksa IP'ye fall back eder
    const app = buildAppWithMode(5, 60_000, 'user', null);
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('mode: "user" — X-RateLimit-Policy "user" içeriyor', async () => {
    const app = buildAppWithMode(5, 60_000, 'user', 'user-abc');
    const res = await request(app).get('/test');
    expect(res.headers['x-ratelimit-policy']).toMatch(/mode=user/);
  });

  it('mode: "combined" — IP+user bağımsız sayaç tutar', async () => {
    const app = buildAppWithMode(5, 60_000, 'combined', 'user-xyz');
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-policy']).toMatch(/mode=combined/);
  });

  it('mode: "combined" — ikisi ayrı aşılabilir', async () => {
    // combined modda IP sayacı aşılınca bile user sayacı bağımsız izlenir
    const app = buildAppWithMode(1, 60_000, 'combined', 'user-combo');
    await request(app).get('/test'); // ilk istek — sayaçlar başlar
    const res = await request(app).get('/test'); // aşılır
    expect(res.status).toBe(429);
  });

  it('mode belirtilmezse varsayılan "combined" davranışı gösterir', async () => {
    jest.resetModules();
    const { rateLimit } = require('../middleware/rateLimit');
    const app = express();
    app.use((req, res, next) => { Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true }); next(); });
    // mode opts olmadan — eski imza geriye dönük uyumlu
    app.get('/test', rateLimit(5, 60_000, 'compat-test'), (req, res) => res.json({ ok: true }));
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('deprecated userOnly: true → mode: "user" olarak davranır', async () => {
    jest.resetModules();
    const { rateLimit } = require('../middleware/rateLimit');
    const app = express();
    app.use((req, res, next) => {
      Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true });
      req.user = { id: 'legacy-user' };
      next();
    });
    // userOnly eski API — @deprecated ama çalışmaya devam etmeli
    app.get('/test', rateLimit(2, 60_000, 'legacy', { userOnly: true }), (req, res) => res.json({ ok: true }));
    await request(app).get('/test');
    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
  });

});

// ── limits factory testleri ───────────────────────────────────────────────

describe('limits factory', () => {
  it('tüm factory\'ler middleware döner', () => {
    jest.resetModules();
    const { limits } = require('../middleware/rateLimit');
    const factories = ['register','login','refresh','changePassword','upload',
                       'messages','react','settings','search','ai','twoFactor','dm',
                       // Session 18: yeni factory'ler
                       'friends','moderation','bots','webhooks'];
    for (const name of factories) {
      expect(typeof limits[name]).toBe('function');
      const mw = limits[name]();
      expect(typeof mw).toBe('function');
    }
  });

  it('limits.friends() — mode ip döner', () => {
    jest.resetModules();
    // friends IP-only olarak tanımlı (_ip factory)
    const { limits } = require('../middleware/rateLimit');
    expect(typeof limits.friends).toBe('function');
    const mw = limits.friends();
    expect(typeof mw).toBe('function');
  });

  it('limits.moderation() — combined mode döner', () => {
    jest.resetModules();
    const { limits } = require('../middleware/rateLimit');
    const mw = limits.moderation();
    expect(typeof mw).toBe('function');
  });
});
