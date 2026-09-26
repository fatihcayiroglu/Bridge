import { fetchMock, headerFrom, installFetchMock } from './helpers/fetchDouble';
process.env.NODE_ENV = 'test';
process.env.SPOTIFY_CLIENT_ID = 'spotify-client';
process.env.SPOTIFY_CLIENT_SECRET = 'spotify-secret';
process.env.SPOTIFY_REDIRECT_URI = 'http://localhost/callback';
process.env.APP_URL = 'http://app.local';

const cacheSet = jest.fn();
const cacheTake = jest.fn();
const getToken = jest.fn();
const updateAccessToken = jest.fn();
const upsertAtomic = jest.fn();
const deleteAtomic = jest.fn();
const logError = jest.fn();
const logWarn = jest.fn();

jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, _res: any, next: any) => { req.user = { id: 'u1' }; next(); },
}));
jest.mock('../lib/authSafe', () => ({ safeCastAuthed: (req: any) => req }));
jest.mock('../lib/redisAdapter', () => ({ cache: { setAuthoritative: (...a: unknown[]) => cacheSet(...a), takeAuthoritative: (...a: unknown[]) => cacheTake(...a) } }));
jest.mock('../db/repositories/OAuthRepository.js', () => ({ OAuth: {
  getToken: (...a: unknown[]) => getToken(...a), updateAccessToken: (...a: unknown[]) => updateAccessToken(...a),
  upsertTokenAndConnectionAtomic: (...a: unknown[]) => upsertAtomic(...a),
  deleteTokenAndConnectionAtomic: (...a: unknown[]) => deleteAtomic(...a),
} }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: (...a: unknown[]) => logError(...a), warn: (...a: unknown[]) => logWarn(...a) } }));

import express from 'express';
import request from 'supertest';
import { router } from '../routes/spotify-oauth';

function app() { const a = express(); a.use('/connections', router); return a; }
function jsonResponse(status: number, body: unknown, extra: Record<string,string> = {}) {
  return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...extra },
  }));
}

describe('Spotify OAuth security and lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    cacheSet.mockResolvedValue(undefined); cacheTake.mockResolvedValue({ userId: 'u1' });
    getToken.mockResolvedValue(null); updateAccessToken.mockResolvedValue(undefined); upsertAtomic.mockResolvedValue(undefined); deleteAtomic.mockResolvedValue(undefined);
    installFetchMock();
  });

  test('start stores opaque state in shared cache before redirecting', async () => {
    const res = await request(app()).get('/connections/spotify');
    expect(res.status).toBe(302);
    const url = new URL(res.headers.location);
    const state = url.searchParams.get('state')!;
    expect(state).toMatch(/^[a-f0-9]{32}$/);
    expect(url.searchParams.get('client_id')).toBe('spotify-client');
    expect(cacheSet).toHaveBeenCalledWith(`oauth:spotify:state:${state}`, { userId: 'u1' }, 600);
  });

  test.each(['bad', 'a'.repeat(31), 'g'.repeat(32)])('rejects malformed callback state without touching provider: %s', async (state) => {
    const res = await request(app()).get('/connections/spotify/callback').query({ code: 'code', state });
    expect(res.status).toBe(302); expect(res.headers.location).toContain('spotify_error=invalid_state');
    expect(cacheTake).not.toHaveBeenCalled(); expect(fetchMock()).not.toHaveBeenCalled(); expect(upsertAtomic).not.toHaveBeenCalled();
  });

  test('replayed/expired state is rejected before token exchange', async () => {
    cacheTake.mockResolvedValueOnce(null);
    const state = 'a'.repeat(32);
    const res = await request(app()).get('/connections/spotify/callback').query({ code: 'code', state });
    expect(res.headers.location).toContain('spotify_error=invalid_state');
    expect(cacheTake).toHaveBeenCalledWith(`oauth:spotify:state:${state}`); expect(fetchMock()).not.toHaveBeenCalled();
  });

  test('state-store failure fails closed instead of exchanging the code', async () => {
    cacheTake.mockRejectedValueOnce(new Error('redis down'));
    const res = await request(app()).get('/connections/spotify/callback').query({ code: 'code', state: 'a'.repeat(32) });
    expect(res.headers.location).toContain('spotify_error=server_error'); expect(fetchMock()).not.toHaveBeenCalled(); expect(logError).toHaveBeenCalled();
  });

  test.each([
    ['token HTTP error', () => jsonResponse(500, { error: 'x' })],
    ['malformed token', () => jsonResponse(200, { access_token: '', expires_in: 3600 })],
    ['unsafe expiry', () => jsonResponse(200, { access_token: 'at', expires_in: Number.MAX_SAFE_INTEGER })],
  ])('%s does not create a half connection', async (_name, first) => {
    fetchMock().mockImplementationOnce(first);
    const res = await request(app()).get('/connections/spotify/callback').query({ code: 'code', state: 'a'.repeat(32) });
    expect(res.headers.location).toContain('spotify_error=server_error'); expect(upsertAtomic).not.toHaveBeenCalled();
  });

  test('profile failure does not persist tokens', async () => {
    fetchMock()
      .mockImplementationOnce(() => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
      .mockImplementationOnce(() => jsonResponse(503, {}));
    const res = await request(app()).get('/connections/spotify/callback').query({ code: 'code', state: 'a'.repeat(32) });
    expect(res.headers.location).toContain('spotify_error=server_error'); expect(upsertAtomic).not.toHaveBeenCalled();
  });

  test('successful callback persists token and connection as one unit', async () => {
    fetchMock()
      .mockImplementationOnce(() => jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
      .mockImplementationOnce(() => jsonResponse(200, { id: 'name/with space' }));
    const before = Date.now();
    const res = await request(app()).get('/connections/spotify/callback').query({ code: 'code', state: 'a'.repeat(32) });
    expect(res.headers.location).toBe('http://app.local/?spotify_connected=1');
    expect(upsertAtomic).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', platform: 'spotify', accessToken: 'at', refreshToken: 'rt', username: 'name/with space',
      url: 'https://open.spotify.com/user/name%2Fwith%20space',
    }));
    expect(upsertAtomic.mock.calls[0][0].expiresAt).toBeGreaterThanOrEqual(before + 3_599_000);
  });

  test('now-playing returns 404 without a token', async () => {
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(404); expect(fetchMock()).not.toHaveBeenCalled();
  });

  test('expired token without refresh token requires reconnect', async () => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: null, expiresAt: 0 });
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(401); expect(fetchMock()).not.toHaveBeenCalled();
  });

  test('malformed persisted expiry fails closed instead of reusing an access token', async () => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: null, expiresAt: '123oops' });
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(401); expect(fetchMock()).not.toHaveBeenCalled();
  });

  test('accepts PostgreSQL BIGINT string expiry without an unnecessary refresh', async () => {
    getToken.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresAt: String(Date.now() + 3600_000) });
    fetchMock().mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(200);
    expect(updateAccessToken).not.toHaveBeenCalled();
    expect(headerFrom(fetchMock().mock.calls[0]?.[1], 'Authorization')).toBe('Bearer at');
  });

  test.each([
    ['HTTP refresh failure', () => jsonResponse(500, {})],
    ['malformed refresh', () => jsonResponse(200, { access_token: '', expires_in: 3600 })],
    ['network refresh failure', () => Promise.reject(new Error('network'))],
  ])('%s is reported as upstream 502 and does not update token', async (_name, provider) => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', expiresAt: 0 });
    fetchMock().mockImplementationOnce(provider);
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(502); expect(updateAccessToken).not.toHaveBeenCalled();
  });

  test('refresh updates token then requests now-playing', async () => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', expiresAt: 0 });
    fetchMock()
      .mockImplementationOnce(() => jsonResponse(200, { access_token: 'new', expires_in: 3600 }))
      .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })));
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(200); expect(res.body).toEqual({ playing: false });
    expect(updateAccessToken).toHaveBeenCalledWith('u1', 'spotify', 'new', expect.any(Number));
    expect(headerFrom(fetchMock().mock.calls[1]?.[1], 'Authorization')).toBe('Bearer new');
  });

  test('now-playing network failure is an upstream 502', async () => {
    getToken.mockResolvedValue({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000 });
    fetchMock().mockRejectedValueOnce(new Error('network'));
    const res = await request(app()).get('/connections/spotify/now-playing');
    expect(res.status).toBe(502); expect(logWarn).toHaveBeenCalled();
  });

  test('disconnect removes token and visible connection atomically', async () => {
    const res = await request(app()).delete('/connections/spotify');
    expect(res.status).toBe(200); expect(deleteAtomic).toHaveBeenCalledWith('u1', 'spotify');
  });
});
