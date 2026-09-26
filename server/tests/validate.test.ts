// server/tests/validate.test.ts
import type { Request, Response, NextFunction } from 'express';
import request from 'supertest';
import express from 'express';
import {
  validate,
  validateBody,
  schemas,
  validateField,
  validateSocketPayload,
  socketSchemas,
  z } from '../middleware/validate';
import type { BitmaskPair } from '../middleware/validate';

const app = express();
app.use(express.json());
app.post('/test', validateBody(schemas.register), (req: Request, res: Response) => res.json({ ok: true }));
app.use((err: Error & { status?: number }, _req: unknown, res: { status: (c: number) => { json: (b: unknown) => unknown } }, _next: unknown) => res.status(500).json({ error: err.message }));

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

// `validateBitmaskMiddleware(target?)` uc bicim kabul eder: yok, dizge, ya da
// alan cifti listesi. Test yardimcisi yalnizca dizge diyordu.
function buildBitmaskApp(target?: string | BitmaskPair[]) {
  const a = express();
  a.use(express.json());
  a.post('/test-bitmask', validateBitmaskMiddleware(target), (_req: Request, res: Response) => res.json({ ok: true }));
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

  it('numeric string ve 32-bit wrap mask reddedilir', async () => {
    expect((await request(bApp).post('/test-bitmask').send({ allow: '256', deny: 0 })).status).toBe(400);
    expect((await request(bApp).post('/test-bitmask').send({ allow: 2 ** 32, deny: 0 })).status).toBe(400);
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


describe('socketSchemas WebRTC signaling boundaries', () => {
  it('dmCallSignal requires non-empty bounded callId and targetUserId', () => {
    expect(validateSocketPayload(
      { callId: 'call-1', targetUserId: 'user-2' },
      socketSchemas.dmCallSignal
    ).valid).toBe(true);

    for (const payload of [
      { targetUserId: 'user-2' },
      { callId: 'call-1' },
      { callId: '', targetUserId: 'user-2' },
      { callId: 'call-1', targetUserId: '' },
      { callId: 'x'.repeat(65), targetUserId: 'user-2' },
      { callId: 'call-1', targetUserId: 'x'.repeat(65) },
    ]) {
      expect(validateSocketPayload(payload, socketSchemas.dmCallSignal).valid).toBe(false);
    }
  });

  it('gdmCallSignal requires non-empty bounded groupId and targetSocketId', () => {
    expect(validateSocketPayload(
      { groupId: 'group-1', targetSocketId: 'socket-2' },
      socketSchemas.gdmCallSignal
    ).valid).toBe(true);

    for (const payload of [
      { targetSocketId: 'socket-2' },
      { groupId: 'group-1' },
      { groupId: '', targetSocketId: 'socket-2' },
      { groupId: 'group-1', targetSocketId: '' },
      { groupId: 'x'.repeat(65), targetSocketId: 'socket-2' },
      { groupId: 'group-1', targetSocketId: 'x'.repeat(65) },
    ]) {
      expect(validateSocketPayload(payload, socketSchemas.gdmCallSignal).valid).toBe(false);
    }
  });
});


describe('validateField — full type/shape contract', () => {
  function errorsFor(value: unknown, rules: any) {
    const errors: string[] = [];
    validateField('field', value, rules, errors);
    return errors;
  }

  it('handles required and optional missing values without coercion', () => {
    expect(errorsFor(undefined, { type: 'string' })).toEqual([]);
    expect(errorsFor(null, { type: 'string', required: true })).toEqual(['field is required']);
    expect(errorsFor('', { type: 'string', required: true })).toEqual(['field is required']);
  });

  it('validates booleans strictly', () => {
    expect(errorsFor(true, { type: 'boolean' })).toEqual([]);
    expect(errorsFor('true', { type: 'boolean' })).toEqual(['field must be a boolean']);
    expect(errorsFor(1, { type: 'boolean' })).toEqual(['field must be a boolean']);
  });

  it('validates strings without converting arrays/objects and exercises min/max/pattern/enum', () => {
    expect(errorsFor(7, { type: 'string' })).toEqual(['field must be a string']);
    expect(errorsFor(' a ', { type: 'string', min: 2 })).toContain('field must be at least 2 characters');
    expect(errorsFor('abcd', { type: 'string', max: 3 })).toContain('field must be at most 3 characters');
    expect(errorsFor('bad!', { type: 'string', pattern: /^[a-z]+$/ })).toContain('field has invalid format');
    expect(errorsFor('three', { type: 'string', enum: ['one', 'two'] })).toContain('field must be one of: one, two');
    expect(errorsFor(' two ', { type: 'string', enum: ['one', 'two'] })).toEqual([]);
  });

  it('validates numbers strictly instead of JSON coercion', () => {
    for (const bad of ['2', [2], { valueOf: () => 2 }, NaN, Infinity, -Infinity]) {
      expect(errorsFor(bad, { type: 'number' })).toEqual(['field must be a number']);
    }
    expect(errorsFor(2, { type: 'number', min: 1, max: 3 })).toEqual([]);
    expect(errorsFor(0, { type: 'number', min: 1 })).toContain('field must be >= 1');
    expect(errorsFor(4, { type: 'number', max: 3 })).toContain('field must be <= 3');
  });

  it('validates arrays, length bounds and primitive/object each rules', () => {
    expect(errorsFor('x', { type: 'array' })).toEqual(['field must be an array']);
    expect(errorsFor([], { type: 'array', min: 1 })).toContain('field must have at least 1 items');
    expect(errorsFor([1, 2, 3], { type: 'array', max: 2 })).toContain('field too many items (max 2)');
    expect(errorsFor(['a', 2], { type: 'array', each: 'string' })).toContain('field[1] must be string');
    expect(errorsFor(['ok', 'x'], { type: 'array', each: { type: 'string', min: 2 } })).toContain('field[1] must be at least 2 characters');
  });

  it('validates nested object shapes and rejects null/arrays', () => {
    const rules = { type: 'object', shape: { name: { type: 'string', required: true }, enabled: { type: 'boolean' } } };
    expect(errorsFor(null, rules)).toEqual([]); // optional null is treated as missing
    expect(errorsFor([], rules)).toEqual(['field must be an object']);
    expect(errorsFor({ enabled: 'yes' }, rules)).toEqual(['field.name is required', 'field.enabled must be a boolean']);
    expect(errorsFor({ name: 'ok', enabled: true }, rules)).toEqual([]);
  });
});

describe('validateBody — sanitization and aggregated errors', () => {
  const custom = express();
  custom.use(express.json());
  custom.post('/custom', validateBody({
    title: { type: 'string', required: true, min: 2, sanitize: true },
    enabled: { type: 'boolean', required: true },
  }), (req: Request, res: Response) => res.json(req.body));

  it('sanitizes a valid top-level string before passing to the handler', async () => {
    const r = await request(custom).post('/custom').send({ title: '  <b>x</b>  ', enabled: true });
    expect(r.status).toBe(200);
    expect(r.body.title).not.toContain('<b>');
    expect(r.body.title).toContain('&lt;');
  });

  it('returns the first error plus the complete error list', async () => {
    const r = await request(custom).post('/custom').send({ title: 'x', enabled: 'yes' });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(r.body.errors[0]);
    expect(r.body.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validateBitmaskMiddleware — strict edge branches', () => {
  it('rejects invalid deny inside array mode', async () => {
    const r = await request(buildBitmaskApp('overrides')).post('/test-bitmask')
      .send({ overrides: [{ allow: 0, deny: -1 }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('deny');
  });

  it('supports custom allow/deny field pairs and validates each pair', async () => {
    const custom = buildBitmaskApp([{ allow: 'roleAllow', deny: 'roleDeny' }, { allow: 'userAllow', deny: 'userDeny' }]);
    expect((await request(custom).post('/test-bitmask').send({ roleAllow: 4, roleDeny: 0, userAllow: 2, userDeny: 0 })).status).toBe(200);
    expect((await request(custom).post('/test-bitmask').send({ roleAllow: 4, roleDeny: 0, userAllow: 2, userDeny: 2 })).status).toBe(400);
  });
});

describe('z-compatible schema validation boundaries', () => {
  it('rejects malformed primitive, length, range, enum, and datetime values', () => {
    expect(z.string().safeParse(1).success).toBe(false);
    expect(z.string().min(2).safeParse('x').success).toBe(false);
    expect(z.string().max(2).safeParse('xxx').success).toBe(false);
    expect(z.number().safeParse(NaN).success).toBe(false);
    expect(z.number().min(2).safeParse(1).success).toBe(false);
    expect(z.number().max(2).safeParse(3).success).toBe(false);
    expect(z.boolean().safeParse('true').success).toBe(false);
    expect(z.enum(['safe', 'strict'] as const).safeParse('unsafe').success).toBe(false);
    expect(z.string().datetime().safeParse(123).success).toBe(false);
    expect(z.string().datetime().safeParse('2026-08-31').success).toBe(false);
    expect(z.string().datetime().safeParse('2026-99-99T00:00:00Z').success).toBe(false);
    expect(z.string().datetime().safeParse('2026-08-31T12:00:00Z').success).toBe(true);
  });

  it('keeps optional values optional and turns throwing refinements into validation failures', () => {
    expect(z.string().optional().safeParse(undefined)).toEqual({ success: true, data: undefined });
    expect(z.string().optional().safeParse(7).success).toBe(false);
    expect(z.string().refine(() => false, { message: 'blocked' }).safeParse('x').error?.issues?.[0]?.message)
      .toBe('blocked');
    expect(z.string().refine(() => { throw new Error('predicate bug'); }).safeParse('x').success).toBe(false);
  });

  it('validates nested arrays and preserves the failing item path', () => {
    const bounded = z.array(z.string().min(2)).min(1).max(2);
    expect(bounded.safeParse('not-an-array').success).toBe(false);
    expect(bounded.safeParse([]).success).toBe(false);
    expect(bounded.safeParse(['ok', 'x']).error?.issues?.[0]?.path).toEqual([1]);
    expect(bounded.safeParse(['ok', 'safe']).success).toBe(true);
    expect(bounded.safeParse(['ok', 'safe', 'extra']).success).toBe(false);
  });

  it('supports object partial/extend without accepting null, arrays, or bad nested types', () => {
    const base = z.object({ name: z.string().min(2), enabled: z.boolean() });
    expect(base.safeParse(null).success).toBe(false);
    expect(base.safeParse([]).success).toBe(false);
    expect(base.safeParse({ name: 'ok', enabled: 'yes' }).error?.issues?.[0]?.path).toEqual(['enabled']);
    expect(base.partial().safeParse({ name: 'ok' }).success).toBe(true);
    expect(base.extend({ count: z.number().min(1) }).safeParse({ name: 'ok', enabled: true, count: 2 }).success)
      .toBe(true);
    expect(z.object().safeParse({ safe: true }).success).toBe(true);
    expect(z.object().safeParse([]).success).toBe(false);

    // Non-object schemas intentionally keep their original parser for these compatibility methods.
    expect(z.string().partial().safeParse('ok').success).toBe(true);
    expect(z.string().extend({ extra: z.string() }).safeParse('ok').success).toBe(true);
  });

  it('routes schema failures through 400 responses and supports the legacy Schema adapter', async () => {
    const schemaApp = express();
    schemaApp.use(express.json());
    schemaApp.post('/z', validate(z.object({ url: z.string().min(1), retries: z.number().min(0).max(3) })),
      (req: Request, res: Response) => res.json(req.body));
    schemaApp.post('/legacy', validate({ token: { type: 'string', required: true, min: 2 } }),
      (_req: Request, res: Response) => res.json({ ok: true }));

    const malformed = await request(schemaApp).post('/z').send({ url: '', retries: 99 });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error).toMatch(/at least/i);
    const valid = await request(schemaApp).post('/z').send({ url: 'https://example.test', retries: 2 });
    expect(valid.status).toBe(200);
    expect(valid.body.retries).toBe(2);
    expect((await request(schemaApp).post('/legacy').send({ token: 'x' })).status).toBe(400);
    expect((await request(schemaApp).post('/legacy').send({ token: 'ok' })).status).toBe(200);
  });
});
