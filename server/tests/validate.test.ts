// server/tests/validate.test.ts
import request from 'supertest';
import express from 'express';
import { validateBody, schemas, validateSocketPayload, socketSchemas } from '../middleware/validate';

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
import { validateBitmaskMiddleware } from '../middleware/validate';

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
    expect(res.body.error).toMatch(/overlapping bits/i);
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
    expect(res.body.error).toMatch(/overlapping bits/i);
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

// ── validateSocketPayload + socketSchemas ─────────────────────────────────────

describe('validateSocketPayload — temel davranış', () => {
  it('geçerli payload → valid: true, errors boş', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-123', serverId: 'srv-456', content: 'merhaba' },
      socketSchemas.sendMessage
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('null payload → valid: false', () => {
    const result = validateSocketPayload(null, socketSchemas.sendMessage);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/object/i);
  });

  it('object olmayan payload → valid: false', () => {
    const result = validateSocketPayload('string', socketSchemas.sendMessage);
    expect(result.valid).toBe(false);
  });

  it('zorunlu alan eksik → valid: false, hata listesi dolu', () => {
    const result = validateSocketPayload(
      { content: 'bir mesaj' },
      socketSchemas.sendMessage
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('channelId'))).toBe(true);
    expect(result.errors.some(e => e.includes('serverId'))).toBe(true);
  });
});

describe('socketSchemas.sendMessage', () => {
  it('content max 2000 karakter aşılırsa hata verir', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1', serverId: 'srv-1', content: 'a'.repeat(2001) },
      socketSchemas.sendMessage
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('content'))).toBe(true);
  });

  it('type geçersiz enum değeri → hata verir', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1', serverId: 'srv-1', type: 'unknown' },
      socketSchemas.sendMessage
    );
    expect(result.valid).toBe(false);
  });

  it('geçerli file mesajı (content opsiyonel) → valid: true', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1', serverId: 'srv-1', type: 'file', fileUrl: '/uploads/x.png', fileName: 'x.png' },
      socketSchemas.sendMessage
    );
    expect(result.valid).toBe(true);
  });
});

describe('socketSchemas.editMessage', () => {
  it('geçerli payload → valid: true', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1', content: 'düzenlendi' },
      socketSchemas.editMessage
    );
    expect(result.valid).toBe(true);
  });

  it('content eksik → valid: false', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1' },
      socketSchemas.editMessage
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('content'))).toBe(true);
  });
});

describe('socketSchemas.deleteMessage', () => {
  it('geçerli payload → valid: true', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1' },
      socketSchemas.deleteMessage
    );
    expect(result.valid).toBe(true);
  });

  it('messageId eksik → valid: false', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1' },
      socketSchemas.deleteMessage
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('messageId'))).toBe(true);
  });
});

describe('socketSchemas.pinMessage', () => {
  it('geçerli payload → valid: true', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1', serverId: 'srv-1' },
      socketSchemas.pinMessage
    );
    expect(result.valid).toBe(true);
  });

  it('serverId eksik → valid: false', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1' },
      socketSchemas.pinMessage
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('serverId'))).toBe(true);
  });
});

describe('socketSchemas.reactMessage', () => {
  it('geçerli payload → valid: true', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1', emoji: '👍' },
      socketSchemas.reactMessage
    );
    expect(result.valid).toBe(true);
  });

  it('emoji max 10 karakter aşılırsa → valid: false', () => {
    const result = validateSocketPayload(
      { messageId: 'msg-1', channelId: 'ch-1', emoji: 'a'.repeat(11) },
      socketSchemas.reactMessage
    );
    expect(result.valid).toBe(false);
  });
});

describe('socketSchemas.fileSend', () => {
  it('geçerli payload → valid: true', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1', serverId: 'srv-1', fileUrl: '/uploads/img.png', fileName: 'img.png' },
      socketSchemas.fileSend
    );
    expect(result.valid).toBe(true);
  });

  it('fileUrl eksik → valid: false', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1', serverId: 'srv-1', fileName: 'img.png' },
      socketSchemas.fileSend
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('fileUrl'))).toBe(true);
  });

  it('fileName 200 karakter aşılırsa → valid: false', () => {
    const result = validateSocketPayload(
      { channelId: 'ch-1', serverId: 'srv-1', fileUrl: '/uploads/x.png', fileName: 'a'.repeat(201) },
      socketSchemas.fileSend
    );
    expect(result.valid).toBe(false);
  });
});

