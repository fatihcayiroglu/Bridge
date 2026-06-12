// server/tests/csrf.test.ts
// CSRF middleware entegrasyon testleri (mock bypass yok)

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-minimum-32-characters-long!!';

import express, { Request, Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../lib/security', () => {
  const actual = jest.requireActual('../lib/security');
  return {
    ...actual,
    verifyCsrfToken: jest.fn(async (userId: string, token: string) =>
      token === `valid-csrf-${userId}`,
    ),
  };
});

jest.mock('../middleware/auth', () => ({
  verifyToken: (token: string) => {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return null;
    }
  },
}));

import { enforceApiCsrf } from '../middleware/csrf';

const USER_ID = 'user-csrf-1';
const bearer = jwt.sign(
  { id: USER_ID, username: 'csrfuser', v: 0 },
  process.env.JWT_SECRET!,
  { expiresIn: '1h' },
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', enforceApiCsrf);
  app.post('/api/mutate', (_req: Request, res: Response) => res.json({ ok: true }));
  app.get('/api/mutate', (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

describe('enforceApiCsrf', () => {
  it('GET isteklerini geçirir', async () => {
    const res = await request(buildApp()).get('/api/mutate');
    expect(res.status).toBe(200);
  });

  it('Bearer token + CSRF olmadan POST reddeder', async () => {
    const res = await request(buildApp())
      .post('/api/mutate')
      .set('Authorization', `Bearer ${bearer}`)
      .send({ x: 1 });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/CSRF/i);
  });

  it('Bearer token + geçerli CSRF ile POST geçer', async () => {
    const res = await request(buildApp())
      .post('/api/mutate')
      .set('Authorization', `Bearer ${bearer}`)
      .set('X-CSRF-Token', `valid-csrf-${USER_ID}`)
      .send({ x: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('Bearer token olmadan POST geçer (login/register akışı)', async () => {
    const res = await request(buildApp())
      .post('/api/mutate')
      .send({ x: 1 });
    expect(res.status).toBe(200);
  });
});
