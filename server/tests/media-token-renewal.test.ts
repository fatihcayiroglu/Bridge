process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV = 'test';

import type { NextFunction, Request, Response } from 'express';

const { createMockDb } = require('./helpers/mockDb');
const db = createMockDb();

jest.mock('../db/loader', () => db);
jest.mock('../db/index', () => db);
jest.mock('../middleware/rateLimit', () => ({
  limits: new Proxy({}, {
    get: () => () => (_req: Request, _res: Response, next: NextFunction) => next(),
  }),
}));

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mediaRouter from '../routes/media';
import { _invalidateTokenCache, makeMediaToken, makeToken } from '../middleware/auth';
import { mediaTokenTtlMs } from '../lib/mediaCookie';

const USER = {
  _id: 'media-renew-user',
  username: 'alice',
  tokenVersion: 0,
  isAdmin: true,
  role: 'admin',
  flags: ['admin'],
};

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/media', mediaRouter);
  return instance;
}

function cookies(res: request.Response): string[] {
  const raw = res.headers['set-cookie'];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function mediaCookieValue(res: request.Response): string {
  const cookie = cookies(res).find((value) => value.startsWith('bridge_media='));
  return cookie?.split(';', 1)[0].slice('bridge_media='.length) ?? '';
}

beforeEach(async () => {
  db._reset?.();
  _invalidateTokenCache(USER._id);
  await db.users.insert({ ...USER });
});

describe('POST /api/media/renew', () => {
  it('reissues a tightly scoped httpOnly media cookie from a valid access session', async () => {
    const res = await request(app())
      .post('/api/media/renew')
      .set('Authorization', `Bearer ${makeToken(USER)}`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const setCookie = cookies(res).find((value) => value.startsWith('bridge_media=')) ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Path=\/uploads/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);

    const payload = jwt.verify(
      mediaCookieValue(res),
      process.env.JWT_SECRET!,
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({ id: USER._id, username: USER.username, v: 0, purpose: 'media' });
    expect(payload.isAdmin).toBeUndefined();
    expect(payload.role).toBeUndefined();
    expect(payload.flags).toBeUndefined();
  });

  it('rejects invalid and revoked access sessions without setting a cookie', async () => {
    const invalid = await request(app())
      .post('/api/media/renew')
      .set('Authorization', 'Bearer invalid')
      .send({});
    expect(invalid.status).toBe(401);
    expect(cookies(invalid)).toHaveLength(0);

    const stale = makeToken(USER);
    await db.users.update({ _id: USER._id }, { $set: { tokenVersion: 2 } });
    _invalidateTokenCache(USER._id);
    const revoked = await request(app())
      .post('/api/media/renew')
      .set('Authorization', `Bearer ${stale}`)
      .send({});
    expect(revoked.status).toBe(401);
    expect(cookies(revoked)).toHaveLength(0);
  });

  it('does not let a media token renew itself', async () => {
    const res = await request(app())
      .post('/api/media/renew')
      .set('Authorization', `Bearer ${makeMediaToken(USER)}`)
      .send({});

    expect(res.status).toBe(401);
    expect(cookies(res)).toHaveLength(0);
  });
});

describe('media cookie lifetime', () => {
  it.each([
    ['30s', 30_000],
    ['15m', 900_000],
    ['2h', 7_200_000],
    ['7d', 604_800_000],
    ['2w', 1_209_600_000],
  ])('parses %s consistently', (input, expected) => {
    expect(mediaTokenTtlMs(input)).toBe(expected);
  });

  it('fails safely to the seven-day default for malformed values', () => {
    expect(mediaTokenTtlMs('tomorrow')).toBe(604_800_000);
  });
});
