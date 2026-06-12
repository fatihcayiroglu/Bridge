// server/tests/canvas.test.ts
// Canvas/Whiteboard route için unit testler
// Sprint 50: JS → TypeScript dönüşümü
// Kapsam: GET state, POST stroke, DELETE stroke, clear, yetki kontrolü

import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';

// ── Mock DB ───────────────────────────────────────────────────────────────────

interface Stroke {
  _id:       string;
  channelId: string;
  userId:    string;
  tool:      string;
  color:     string;
  width:     number;
  points:    Array<{ x: number; y: number }>;
  createdAt: number;
  text?:     string;
}

const mockStrokes: Stroke[] = [
  { _id: 'str1', channelId: 'ch1', userId: 'u1', tool: 'pen',  color: '#fff', width: 3, points: [{ x: 0,  y: 0  }], createdAt: Date.now() },
  { _id: 'str2', channelId: 'ch1', userId: 'u2', tool: 'line', color: '#f00', width: 2, points: [{ x: 10, y: 10 }, { x: 20, y: 20 }], createdAt: Date.now() },
];

jest.mock('../db', () => ({
  db: {
    collection: jest.fn(() => ({
      find:       jest.fn(() => ({ sort: jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(mockStrokes) })) })),
      findOne:    jest.fn().mockResolvedValue(mockStrokes[0]),
      insertOne:  jest.fn().mockResolvedValue({ insertedId: 'newStrokeId' }),
      deleteOne:  jest.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 2 }),
    })),
  },
}), { virtual: true });

// ── Mock auth ─────────────────────────────────────────────────────────────────

function mockAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as Request & { user: { _id: string; id: string; displayName: string } }).user =
    { _id: 'u1', id: 'u1', displayName: 'Test User' };
  next();
}

function mockMemberCheck(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

// ── App setup ─────────────────────────────────────────────────────────────────

const VALID_TOOLS = ['pen', 'eraser', 'line', 'rect', 'circle', 'text'] as const;
type ToolType = typeof VALID_TOOLS[number];

interface StrokeBody {
  tool?:   string;
  color?:  string;
  width?:  number;
  points?: Array<{ x: number; y: number }>;
  text?:   string;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  const MAX_POINTS = 2000;
  const MAX_TEXT   = 500;

  // GET /api/canvas/:channelId — get state
  app.get('/api/canvas/:channelId', mockAuth, (_req: Request, res: Response) => {
    const strokes = mockStrokes.filter(s => s.channelId === _String(req.params.channelId ?? ''));
    res.json({ strokes });
  });

  // POST /api/canvas/:channelId/strokes — add stroke
  app.post('/api/canvas/:channelId/strokes', mockAuth, mockMemberCheck, (req: Request, res: Response) => {
    const { tool, color, width, points, text } = req.body as StrokeBody;

    if (!tool || !(VALID_TOOLS as readonly string[]).includes(tool)) {
      return res.status(400).json({ error: 'Geçersiz araç' });
    }
    if (!color || !/^#[0-9a-fA-F]{3,8}$/.test(color)) {
      return res.status(400).json({ error: 'Geçersiz renk' });
    }
    if (!width || typeof width !== 'number' || width < 1 || width > 100) {
      return res.status(400).json({ error: 'Geçersiz kalınlık' });
    }
    if (!Array.isArray(points) || points.length === 0) {
      return res.status(400).json({ error: 'Nokta listesi gerekli' });
    }
    if (points.length > MAX_POINTS) {
      return res.status(400).json({ error: 'Çok fazla nokta' });
    }
    if ((tool as ToolType) === 'text' && text && text.length > MAX_TEXT) {
      return res.status(400).json({ error: 'Metin çok uzun' });
    }
    for (const p of points) {
      if (typeof p.x !== 'number' || typeof p.y !== 'number') {
        return res.status(400).json({ error: 'Geçersiz nokta formatı' });
      }
    }

    return res.status(201).json({ ok: true, strokeId: 'newStrokeId' });
  });

  // DELETE /api/canvas/:channelId/strokes/:strokeId — delete stroke
  app.delete('/api/canvas/:channelId/strokes/:strokeId', mockAuth, (req: Request, res: Response) => {
    const authedUser = (req as Request & { user: { id: string } }).user;
    const stroke = mockStrokes.find(s => s._id === String(req.params.strokeId ?? ''));
    if (!stroke)                           return res.status(404).json({ error: 'Stroke bulunamadı' });
    if (stroke.userId !== authedUser.id)   return res.status(403).json({ error: 'Yetkisiz' });
    return res.json({ ok: true });
  });

  // DELETE /api/canvas/:channelId — clear all
  app.delete('/api/canvas/:channelId', mockAuth, (_req: Request, res: Response) => {
    res.json({ ok: true, deleted: 2 });
  });

  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/canvas/:channelId', () => {
  const app = buildApp();

  test('200 ve strokes dizisi döner', async () => {
    const res = await request(app).get('/api/canvas/ch1');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.strokes)).toBe(true);
  });

  test('kanalın stroke\'larını döner', async () => {
    const res = await request(app).get('/api/canvas/ch1');
    expect(res.body.strokes.length).toBe(2);
  });

  test('farklı kanal boş dizi döner', async () => {
    const res = await request(app).get('/api/canvas/ch999');
    expect(res.body.strokes.length).toBe(0);
  });

  test('her stroke tool içerir', async () => {
    const res = await request(app).get('/api/canvas/ch1');
    (res.body.strokes as Stroke[]).forEach(s => {
      expect(s.tool).toBeDefined();
    });
  });
});

describe('POST /api/canvas/:channelId/strokes', () => {
  const app = buildApp();

  const validStroke: StrokeBody = {
    tool: 'pen', color: '#ffffff', width: 3,
    points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
  };

  test('geçerli stroke 201 döner', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send(validStroke);
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.strokeId).toBeDefined();
  });

  test('tüm geçerli araçlar kabul edilir', async () => {
    for (const tool of VALID_TOOLS) {
      const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, tool });
      expect(res.status).toBe(201);
    }
  });

  test('geçersiz araç 400 döner', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, tool: 'paintbucket' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Geçersiz araç');
  });

  test('geçersiz renk 400 döner', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, color: 'not-a-color' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Geçersiz renk');
  });

  test('geçerli renk formatları kabul edilir', async () => {
    for (const color of ['#fff', '#ffffff', '#ffffffff']) {
      const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, color });
      expect(res.status).toBe(201);
    }
  });

  test('width < 1 hata verir', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, width: 0 });
    expect(res.status).toBe(400);
  });

  test('width > 100 hata verir', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, width: 101 });
    expect(res.status).toBe(400);
  });

  test('boş nokta dizisi hata verir', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, points: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Nokta');
  });

  test('2001 nokta hata verir', async () => {
    const tooMany = Array.from({ length: 2001 }, (_, i) => ({ x: i, y: i }));
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, points: tooMany });
    expect(res.status).toBe(400);
  });

  test('geçersiz nokta formatı hata verir', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({ ...validStroke, points: [{ a: 1, b: 2 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('format');
  });

  test('text tool ile 500+ karakter hata verir', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({
      ...validStroke, tool: 'text', text: 'a'.repeat(501),
    });
    expect(res.status).toBe(400);
  });

  test('text tool ile kısa metin kabul edilir', async () => {
    const res = await request(app).post('/api/canvas/ch1/strokes').send({
      ...validStroke, tool: 'text', text: 'Merhaba!',
    });
    expect(res.status).toBe(201);
  });
});

describe('DELETE /api/canvas/:channelId/strokes/:strokeId', () => {
  const app = buildApp();

  test('kendi stroke\'unu silebilir', async () => {
    const res = await request(app).delete('/api/canvas/ch1/strokes/str1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('başkasının stroke\'unu silmeye çalışmak 403 döner', async () => {
    const res = await request(app).delete('/api/canvas/ch1/strokes/str2');
    expect(res.status).toBe(403);
  });

  test('mevcut olmayan stroke 404 döner', async () => {
    const res = await request(app).delete('/api/canvas/ch1/strokes/nonexistent');
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/canvas/:channelId — clear all', () => {
  const app = buildApp();

  test('canvas temizleme 200 döner', async () => {
    const res = await request(app).delete('/api/canvas/ch1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('silinen sayısı döner', async () => {
    const res = await request(app).delete('/api/canvas/ch1');
    expect(typeof res.body.deleted).toBe('number');
  });
});
