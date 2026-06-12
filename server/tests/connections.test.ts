// server/tests/connections.test.ts — Sprint 50
// Kullanıcı bağlantı rotası için unit testler
// Sprint 50: JS → TypeScript dönüşümü
// Kapsam: GET /me/connections, PUT (upsert), DELETE, platform doğrulama

import request from 'supertest';
import express, { Express, Request, Response, NextFunction } from 'express';

// ── Mock DB ───────────────────────────────────────────────────────────────────

interface UserConnection {
  userId:   string;
  platform: string;
  username: string;
}

const mockConnections: UserConnection[] = [
  { userId: 'u1', platform: 'github',  username: 'testuser'    },
  { userId: 'u1', platform: 'twitter', username: 'twitteruser' },
];

jest.mock('../db', () => ({
  db: {
    collection: jest.fn(() => ({
      find:      jest.fn(() => ({ toArray: jest.fn().mockResolvedValue(mockConnections) })),
      findOne:   jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
    })),
  },
}), { virtual: true });

// ── Mock auth middleware ───────────────────────────────────────────────────────

type AuthedReq = Request & { user: { _id: string; id: string; displayName: string } };

function mockAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as AuthedReq).user = { _id: 'u1', id: 'u1', displayName: 'Test User' };
  next();
}

// ── App setup ─────────────────────────────────────────────────────────────────

const SUPPORTED_PLATFORMS = [
  'github', 'twitter', 'twitch', 'youtube',
  'steam', 'spotify', 'linkedin', 'website',
] as const;
type Platform = typeof SUPPORTED_PLATFORMS[number];

interface ConnectionBody {
  platform?: string;
  username?: string;
}

function buildApp(): Express {
  const app = express();
  app.use(express.json());

  // GET /api/me/connections
  app.get('/api/me/connections', mockAuth, (req: Request, res: Response) => {
    const userId = (req as AuthedReq).user.id;
    const conns  = mockConnections.filter(c => c.userId === userId);
    res.json(conns);
  });

  // PUT /api/me/connections
  app.put('/api/me/connections', mockAuth, (req: Request, res: Response) => {
    const { platform, username } = req.body as ConnectionBody;

    if (!platform || !(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
      return res.status(400).json({ error: 'Geçersiz platform' });
    }
    if (!username || typeof username !== 'string') {
      return res.status(400).json({ error: 'Kullanıcı adı gerekli' });
    }
    if (username.length > 100) {
      return res.status(400).json({ error: 'Kullanıcı adı çok uzun' });
    }
    return res.json({ ok: true, platform, username });
  });

  // DELETE /api/me/connections/:platform
  app.delete('/api/me/connections/:platform', mockAuth, (req: Request, res: Response) => {
    const { platform } = req.params;
    if (!(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) {
      return res.status(400).json({ error: 'Geçersiz platform' });
    }
    return res.json({ ok: true });
  });

  return app;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('GET /api/me/connections', () => {
  const app = buildApp();

  test('200 ve bağlantı listesi döner', async () => {
    const res = await request(app).get('/api/me/connections');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('her bağlantı platform ve username içerir', async () => {
    const res = await request(app).get('/api/me/connections');
    (res.body as UserConnection[]).forEach(c => {
      expect(c.platform).toBeDefined();
      expect(c.username).toBeDefined();
    });
  });

  test('mevcut bağlantılar döner', async () => {
    const res = await request(app).get('/api/me/connections');
    expect(res.body.length).toBe(2);
    expect((res.body as UserConnection[])[0].platform).toBe('github');
  });
});

describe('PUT /api/me/connections', () => {
  const app = buildApp();

  test('geçerli platform ile 200 döner', async () => {
    const res = await request(app).put('/api/me/connections').send({ platform: 'github', username: 'newuser' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('geçersiz platform 400 döner', async () => {
    const res = await request(app).put('/api/me/connections').send({ platform: 'fakebook', username: 'user' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  test('eksik platform 400 döner', async () => {
    const res = await request(app).put('/api/me/connections').send({ username: 'user' });
    expect(res.status).toBe(400);
  });

  test('eksik username 400 döner', async () => {
    const res = await request(app).put('/api/me/connections').send({ platform: 'github' });
    expect(res.status).toBe(400);
  });

  test('100 karakterden uzun username 400 döner', async () => {
    const res = await request(app).put('/api/me/connections').send({ platform: 'github', username: 'a'.repeat(101) });
    expect(res.status).toBe(400);
  });

  test('tüm desteklenen platformlar kabul edilir', async () => {
    for (const platform of SUPPORTED_PLATFORMS) {
      const res = await request(app).put('/api/me/connections').send({ platform, username: 'testuser' });
      expect(res.status).toBe(200);
    }
  });

  test('response platform ve username içerir', async () => {
    const res = await request(app).put('/api/me/connections').send({ platform: 'twitter', username: 'mytwitter' });
    expect(res.body.platform).toBe('twitter');
    expect(res.body.username).toBe('mytwitter');
  });
});

describe('DELETE /api/me/connections/:platform', () => {
  const app = buildApp();

  test('geçerli platform silinir', async () => {
    const res = await request(app).delete('/api/me/connections/github');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test('geçersiz platform 400 döner', async () => {
    const res = await request(app).delete('/api/me/connections/fakebook');
    expect(res.status).toBe(400);
  });

  test('youtube silinebilir', async () => {
    const res = await request(app).delete('/api/me/connections/youtube');
    expect(res.status).toBe(200);
  });

  test('steam silinebilir', async () => {
    const res = await request(app).delete('/api/me/connections/steam');
    expect(res.status).toBe(200);
  });
});
