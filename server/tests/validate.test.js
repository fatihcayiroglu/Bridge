// server/tests/validate.test.js
const request = require('supertest');
const express = require('express');
const { validateBody, schemas } = require('../middleware/validate');

const app = express();
app.use(express.json());
app.post('/test', validateBody(schemas.register), (req, res) => res.json({ ok: true }));
app.use((err, req, res, next) => res.status(500).json({ error: err.message }));

describe('validateBody middleware', () => {
  it('passes valid input', async () => {
    const res = await request(app).post('/test').send({ username: 'validuser', password: 'validpassword' });
    expect(res.status).toBe(200);
  });

  it('rejects missing required field', async () => {
    const res = await request(app).post('/test').send({ username: 'validuser' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('rejects too-short string', async () => {
    const res = await request(app).post('/test').send({ username: 'ab', password: 'validpass' });
    expect(res.status).toBe(400);
  });

  it('rejects invalid pattern', async () => {
    const res = await request(app).post('/test').send({ username: 'bad name!', password: 'validpass' });
    expect(res.status).toBe(400);
  });
});

// ─── validateBitmaskMiddleware testleri ─────────────────────
const { validateBitmaskMiddleware } = require('../middleware/validate');

function buildBitmaskApp(target) {
  const a = express();
  a.use(express.json());
  a.post('/test-bitmask', validateBitmaskMiddleware(target), (_req, res) => res.json({ ok: true }));
  return a;
}

describe('validateBitmaskMiddleware — tekil alan (varsayılan allow/deny)', () => {
  const bApp = buildBitmaskApp(); // target yok → allow/deny

  it('geçerli allow=256 deny=0 geçer', async () => {
    const res = await request(bApp).post('/test-bitmask').send({ allow: 256, deny: 0 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allow ve deny yoksa middleware geçer (opsiyonel alan)', async () => {
    const res = await request(bApp).post('/test-bitmask').send({});
    expect(res.status).toBe(200);
  });

  it('çakışan bit allow & deny 400 döner', async () => {
    const res = await request(bApp).post('/test-bitmask').send({ allow: 256, deny: 256 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aynı anda/i);
  });

  it('negatif allow 400 döner', async () => {
    const res = await request(bApp).post('/test-bitmask').send({ allow: -1, deny: 0 });
    expect(res.status).toBe(400);
  });

  it('negatif deny 400 döner', async () => {
    const res = await request(bApp).post('/test-bitmask').send({ allow: 0, deny: -5 });
    expect(res.status).toBe(400);
  });

  it('allow=0 deny=0 geçer (boş override)', async () => {
    const res = await request(bApp).post('/test-bitmask').send({ allow: 0, deny: 0 });
    expect(res.status).toBe(200);
  });
});

describe('validateBitmaskMiddleware — dizi modu (overrides)', () => {
  const arrApp = buildBitmaskApp('overrides');

  it('geçerli dizi geçer', async () => {
    const res = await request(arrApp).post('/test-bitmask')
      .send({ overrides: [{ allow: 256, deny: 0 }, { allow: 64, deny: 0 }] });
    expect(res.status).toBe(200);
  });

  it('overrides dizi değilse middleware geçer (body boşsa)', async () => {
    const res = await request(arrApp).post('/test-bitmask').send({});
    expect(res.status).toBe(200);
  });

  it('dizi elemanında çakışan bit 400 döner', async () => {
    const res = await request(arrApp).post('/test-bitmask')
      .send({ overrides: [{ allow: 64, deny: 64 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/aynı anda/i);
  });

  it('dizi elemanında negatif allow 400 döner', async () => {
    const res = await request(arrApp).post('/test-bitmask')
      .send({ overrides: [{ allow: -2, deny: 0 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('overrides[0]');
  });

  it('ilk eleman geçerli, ikinci çakışan → 400 döner', async () => {
    const res = await request(arrApp).post('/test-bitmask')
      .send({ overrides: [{ allow: 256, deny: 0 }, { allow: 64, deny: 64 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('overrides[1]');
  });
});
