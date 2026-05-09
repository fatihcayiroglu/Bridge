// server/tests/linkPreview.test.js
// linkPreview route — full coverage
process.env.JWT_SECRET = 'test-jwt-secret';
process.env.NODE_ENV   = 'test';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());
jest.mock('../middleware/rateLimit', () => ({
  limits: { read: () => (_req, _res, next) => next() },
}));

// ── fetchLinkPreview + extractUrls mocked ────────────────────────
const mockFetchLinkPreview = jest.fn();
const mockExtractUrls      = jest.fn();
jest.mock('../lib/linkPreview', () => ({
  fetchLinkPreview: (...a) => mockFetchLinkPreview(...a),
  extractUrls:      (...a) => mockExtractUrls(...a),
}));

const request = require('supertest');
const express = require('express');
const jwt     = require('jsonwebtoken');
const db      = require('../db/loader');
const { authMiddleware } = require('../middleware/auth');
const linkPreviewRouter  = require('../routes/linkPreview');
const { v4: uuidv4 }    = require('uuid');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/link-preview', linkPreviewRouter);
  return app;
}

function tok(uid) {
  return jwt.sign({ id: uid, v: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

const PREVIEW = {
  type: 'link', url: 'https://example.com', title: 'Example',
  description: 'An example site', image: null, siteName: 'example.com',
};

describe('GET /api/link-preview — auth', () => {
  let app, uid, token;
  beforeEach(async () => {
    db._reset?.();
    app = buildApp();
    uid = uuidv4();
    token = tok(uid);
    await db.users.insert({ _id: uid, username: 'u', tokenVersion: 0 });
  });

  it('returns 401 without token', async () => {
    const res = await request(app).get('/api/link-preview?url=https://example.com');
    expect(res.status).toBe(401);
  });

  it('returns 400 when url param missing', async () => {
    const res = await request(app)
      .get('/api/link-preview')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/url/i);
  });

  it('returns 400 for empty url string', async () => {
    const res = await request(app)
      .get('/api/link-preview?url=')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe('GET /api/link-preview — preview fetch', () => {
  let app, uid, token;
  beforeEach(async () => {
    db._reset?.();
    app = buildApp();
    uid = uuidv4();
    token = tok(uid);
    await db.users.insert({ _id: uid, username: 'u', tokenVersion: 0 });
    mockFetchLinkPreview.mockReset();
  });

  it('returns preview object on success', async () => {
    mockFetchLinkPreview.mockResolvedValue(PREVIEW);
    const res = await request(app)
      .get('/api/link-preview?url=https://example.com')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Example', type: 'link' });
  });

  it('returns 404 when preview not available', async () => {
    mockFetchLinkPreview.mockResolvedValue(null);
    const res = await request(app)
      .get('/api/link-preview?url=https://no-preview.example')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('passes the url to fetchLinkPreview', async () => {
    mockFetchLinkPreview.mockResolvedValue(PREVIEW);
    await request(app)
      .get('/api/link-preview?url=https://target.example.com/page')
      .set('Authorization', `Bearer ${token}`);
    expect(mockFetchLinkPreview).toHaveBeenCalledWith('https://target.example.com/page');
  });

  it('trims whitespace from url param', async () => {
    mockFetchLinkPreview.mockResolvedValue(PREVIEW);
    await request(app)
      .get('/api/link-preview?url=  https://example.com  ')
      .set('Authorization', `Bearer ${token}`);
    expect(mockFetchLinkPreview).toHaveBeenCalledWith('https://example.com');
  });
});

describe('POST /api/link-preview — batch extract', () => {
  let app, uid, token;
  beforeEach(async () => {
    db._reset?.();
    app = buildApp();
    uid = uuidv4();
    token = tok(uid);
    await db.users.insert({ _id: uid, username: 'u', tokenVersion: 0 });
    mockExtractUrls.mockReset();
    mockFetchLinkPreview.mockReset();
  });

  it('returns 401 without token', async () => {
    const res = await request(app).post('/api/link-preview').send({ content: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns empty previews when no URLs found in content', async () => {
    mockExtractUrls.mockReturnValue([]);
    const res = await request(app)
      .post('/api/link-preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'no urls here' });
    expect(res.status).toBe(200);
    expect(res.body.previews).toEqual([]);
  });

  it('returns empty previews when content is absent', async () => {
    mockExtractUrls.mockReturnValue([]);
    const res = await request(app)
      .post('/api/link-preview')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.previews).toEqual([]);
  });

  it('fetches previews for each extracted URL', async () => {
    mockExtractUrls.mockReturnValue(['https://a.com', 'https://b.com']);
    mockFetchLinkPreview
      .mockResolvedValueOnce({ ...PREVIEW, url: 'https://a.com' })
      .mockResolvedValueOnce({ ...PREVIEW, url: 'https://b.com' });

    const res = await request(app)
      .post('/api/link-preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'check https://a.com and https://b.com' });
    expect(res.status).toBe(200);
    expect(res.body.previews).toHaveLength(2);
  });

  it('skips URLs where fetchLinkPreview returns null', async () => {
    mockExtractUrls.mockReturnValue(['https://ok.com', 'https://fail.com']);
    mockFetchLinkPreview
      .mockResolvedValueOnce({ ...PREVIEW, url: 'https://ok.com' })
      .mockResolvedValueOnce(null);

    const res = await request(app)
      .post('/api/link-preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'two links' });
    expect(res.body.previews).toHaveLength(1);
    expect(res.body.previews[0].url).toBe('https://ok.com');
  });

  it('calls extractUrls with limit of 3', async () => {
    mockExtractUrls.mockReturnValue([]);
    await request(app)
      .post('/api/link-preview')
      .set('Authorization', `Bearer ${token}`)
      .send({ content: 'some content' });
    expect(mockExtractUrls).toHaveBeenCalledWith('some content', 3);
  });
});
