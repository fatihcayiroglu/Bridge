// server/tests/rateLimit.test.js
process.env.NODE_ENV = 'test';

const request = require('supertest');
const express = require('express');

// Her test için temiz module cache
function freshRateLimit() {
  jest.resetModules();
  return require('../middleware/rateLimit');
}

function buildApp(max, windowMs) {
  const { rateLimit } = freshRateLimit();
  const app = express();
  app.use((req, res, next) => { req.ip = '127.0.0.1'; next(); });
  app.get('/test', rateLimit(max, windowMs, 'test'), (req, res) => res.json({ ok: true }));
  return app;
}

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
    expect(res.body.error).toMatch(/çok fazla istek/i);
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
    app.use((req, res, next) => { req.ip = '127.0.0.1'; next(); });
    app.get('/a', rateLimit(2, 60_000, 'prefix-a'), (req, res) => res.json({ ok: true }));
    app.get('/b', rateLimit(2, 60_000, 'prefix-b'), (req, res) => res.json({ ok: true }));

    // /a'yı tüket
    await request(app).get('/a');
    await request(app).get('/a');
    const resA = await request(app).get('/a');
    expect(resA.status).toBe(429);

    // /b hâlâ çalışmalı
    const resB = await request(app).get('/b');
    expect(resB.status).toBe(200);
  });
});

describe('limits factory', () => {
  it('tüm factory\'ler middleware döner', () => {
    jest.resetModules();
    const { limits } = require('../middleware/rateLimit');
    const factories = ['register','login','refresh','changePassword','upload',
                       'messages','react','settings','search','ai','twoFactor','dm'];
    for (const name of factories) {
      expect(typeof limits[name]).toBe('function');
      const mw = limits[name]();
      expect(typeof mw).toBe('function');
    }
  });
});
