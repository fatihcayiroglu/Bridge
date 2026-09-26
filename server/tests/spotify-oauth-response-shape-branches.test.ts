// server/tests/spotify-oauth-response-shape-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SPOTIFY BAĞLANTISI — SAĞLAYICI YANIT ŞEKLİ VE YAPILANDIRMA EKSİKLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/spotify-oauth-security.test.ts` state bağlama ve replay'i ölçer. Bu
// tamamlayıcı takım, SAĞLAYICININ döndürdüğü şekle verilen tepkiyi ölçer —
import { fetchMock, installFetchMock } from './helpers/fetchDouble';
// çünkü buradaki her alan uzak bir servisin denetimindedir:
//
//   · YAPILANDIRMA. Anahtarlar eksikken akış BAŞLATILMAMALIDIR; başlatılırsa
//     kullanıcı Spotify'a gidip geri döner ve orada anlamsız bir hatayla
//     karşılaşır.
//   · İPTAL ≠ HATA. Kullanıcı izni reddettiğinde sağlayıcının bildirdiği
//     sebep korunur; hiç sebep yoksa "cancelled" yazılır. Ayırt edilmezse
//     istemci gerçek bir sunucu hatasını iptal sanır.
//   · BOZUK TOKEN/PROFİL YANITI kabul EDİLMEZ: eksik `access_token`, saçma
//     `expires_in` ya da kimliksiz profil bir bağlantı satırı yaratmamalıdır.
//   · "HİÇBİR ŞEY ÇALMIYOR" iki farklı biçimde gelir (204, ya da gövdesiz
//     200). İkisi de `playing:false` olmalıdır; aksi hâlde JSON ayrıştırma
//     hatası 502'ye dönerdi.

'use strict';
process.env.NODE_ENV = 'test';
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
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    setAuthoritative: (...a: unknown[]) => cacheSet(...a),
    takeAuthoritative: (...a: unknown[]) => cacheTake(...a),
  },
}));
jest.mock('../db/repositories/OAuthRepository.js', () => ({
  OAuth: {
    getToken: (...a: unknown[]) => getToken(...a),
    updateAccessToken: (...a: unknown[]) => updateAccessToken(...a),
    upsertTokenAndConnectionAtomic: (...a: unknown[]) => upsertAtomic(...a),
    deleteTokenAndConnectionAtomic: (...a: unknown[]) => deleteAtomic(...a),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { error: (...a: unknown[]) => logError(...a), warn: (...a: unknown[]) => logWarn(...a), info: jest.fn() },
}));

import express from 'express';
import request from 'supertest';

const SPOTIFY_ENV = ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REDIRECT_URI'] as const;
const savedEnv: Record<string, string | undefined> = {};

/** Loads the router with an explicit configuration state. */
function loadRouter(configured: boolean) {
  if (configured) {
    process.env.SPOTIFY_CLIENT_ID = 'spotify-client';
    process.env.SPOTIFY_CLIENT_SECRET = 'spotify-secret';
    process.env.SPOTIFY_REDIRECT_URI = 'http://localhost/callback';
  } else {
    for (const key of SPOTIFY_ENV) delete process.env[key];
  }
  let mod!: { router: express.Router };
  jest.isolateModules(() => { mod = require('../routes/spotify-oauth'); });
  const a = express();
  a.use('/connections', mod.router);
  return a;
}

function jsonResponse(status: number, body?: unknown, extra: Record<string, string> = {}) {
  return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...extra },
  }));
}
function emptyResponse(status: number, extra: Record<string, string> = {}) {
  return Promise.resolve(new Response(null, { status, headers: extra }));
}

beforeAll(() => { for (const key of SPOTIFY_ENV) savedEnv[key] = process.env[key]; });
afterAll(() => {
  for (const key of SPOTIFY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key]!;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  cacheSet.mockResolvedValue(undefined);
  cacheTake.mockResolvedValue({ userId: 'u1' });
  getToken.mockResolvedValue(null);
  updateAccessToken.mockResolvedValue(undefined);
  upsertAtomic.mockResolvedValue(undefined);
  deleteAtomic.mockResolvedValue(undefined);
  installFetchMock();
});

describe('an unconfigured deployment', () => {
  it('refuses to start the flow at all', async () => {
    const res = await request(loadRouter(false)).get('/connections/spotify');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Spotify OAuth not configured');
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('cannot complete a callback either, and says so as a server error', async () => {
    const res = await request(loadRouter(false)).get('/connections/spotify/callback')
      .query({ code: 'abc', state: 'a'.repeat(32) });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://app.local/?spotify_error=server_error');
    // The one-time state is still consumed, so it cannot be replayed later.
    expect(cacheTake).toHaveBeenCalledTimes(1);
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(upsertAtomic).not.toHaveBeenCalled();
  });
});

describe('callback query handling', () => {
  const app = () => loadRouter(true);

  const cancelled: Array<[string, Record<string, unknown>, string]> = [
    ['the user denied consent', { error: 'access_denied', state: 'a'.repeat(32) }, 'access_denied'],
    ['no code came back', { state: 'a'.repeat(32) }, 'cancelled'],
    ['no state came back', { code: 'abc' }, 'cancelled'],
    ['neither came back', {}, 'cancelled'],
    ['the code is repeated as an array', { code: ['a', 'b'], state: 'a'.repeat(32) }, 'cancelled'],
    ['the state is repeated as an array', { code: 'abc', state: ['a', 'b'] }, 'cancelled'],
  ];
  for (const [name, query, reason] of cancelled) {
    it(`redirects with "${reason}" when ${name}`, async () => {
      const res = await request(app()).get('/connections/spotify/callback').query(query);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`http://app.local/?spotify_error=${encodeURIComponent(reason)}`);
      expect(cacheTake).not.toHaveBeenCalled();
      expect(fetchMock()).not.toHaveBeenCalled();
    });
  }

  it('an over-long authorization code is refused before the state is consumed', async () => {
    const res = await request(app()).get('/connections/spotify/callback')
      .query({ code: 'a'.repeat(4097), state: 'a'.repeat(32) });
    expect(res.headers.location).toContain('spotify_error=invalid_state');
    expect(cacheTake).not.toHaveBeenCalled();
  });

  it('a state store outage is a server error, not a silent success', async () => {
    cacheTake.mockRejectedValue(new Error('state store offline'));
    const res = await request(app()).get('/connections/spotify/callback')
      .query({ code: 'abc', state: 'a'.repeat(32) });
    expect(res.headers.location).toContain('spotify_error=server_error');
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spotify.oauth.state_store_failed' }), expect.any(String));
  });

  it('an unknown or already-used state is refused', async () => {
    cacheTake.mockResolvedValue(null);
    const res = await request(app()).get('/connections/spotify/callback')
      .query({ code: 'abc', state: 'a'.repeat(32) });
    expect(res.headers.location).toContain('spotify_error=invalid_state');
    expect(fetchMock()).not.toHaveBeenCalled();
  });
});

describe('token and profile responses from the provider', () => {
  const app = () => loadRouter(true);
  const callback = (a: express.Express) => request(a).get('/connections/spotify/callback')
    .query({ code: 'abc', state: 'a'.repeat(32) });

  it('stores the connection when both responses are well formed', async () => {
    fetchMock()
      .mockReturnValueOnce(jsonResponse(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }))
      .mockReturnValueOnce(jsonResponse(200, { id: 'spotify-user' }));

    const res = await callback(app());

    expect(res.headers.location).toBe('http://app.local/?spotify_connected=1');
    expect(upsertAtomic).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', platform: 'spotify', accessToken: 'at', refreshToken: 'rt',
      username: 'spotify-user', url: 'https://open.spotify.com/user/spotify-user',
    }));
  });

  it('a provider without a refresh token still connects, with none stored', async () => {
    fetchMock()
      .mockReturnValueOnce(jsonResponse(200, { access_token: 'at', expires_in: 3600 }))
      .mockReturnValueOnce(jsonResponse(200, { id: 'spotify-user' }));
    await callback(app());
    expect(upsertAtomic).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: null }));
  });

  const malformedTokens: Array<[string, unknown]> = [
    ['no access token', { expires_in: 3600 }],
    ['a non-string access token', { access_token: 42, expires_in: 3600 }],
    ['no expiry', { access_token: 'at' }],
    ['a non-numeric expiry', { access_token: 'at', expires_in: '3600' }],
    ['a zero expiry', { access_token: 'at', expires_in: 0 }],
    ['a negative expiry', { access_token: 'at', expires_in: -1 }],
    ['a fractional expiry', { access_token: 'at', expires_in: 1.5 }],
    ['an implausibly long expiry', { access_token: 'at', expires_in: 86_401 }],
  ];
  for (const [name, body] of malformedTokens) {
    it(`refuses a token response with ${name}`, async () => {
      fetchMock().mockReturnValueOnce(jsonResponse(200, body));
      const res = await callback(app());
      expect(res.headers.location).toContain('spotify_error=server_error');
      expect(upsertAtomic).not.toHaveBeenCalled();
    });
  }

  it('a failed token exchange never reaches the profile call', async () => {
    fetchMock().mockReturnValueOnce(jsonResponse(400, { error: 'invalid_grant' }));
    const res = await callback(app());
    expect(res.headers.location).toContain('spotify_error=server_error');
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  const malformedProfiles: Array<[string, unknown]> = [
    ['no id', {}],
    ['an empty id', { id: '' }],
    ['a non-string id', { id: 12345 }],
    ['an implausibly long id', { id: 'x'.repeat(201) }],
  ];
  for (const [name, body] of malformedProfiles) {
    it(`refuses a profile response with ${name}`, async () => {
      fetchMock()
        .mockReturnValueOnce(jsonResponse(200, { access_token: 'at', expires_in: 3600 }))
        .mockReturnValueOnce(jsonResponse(200, body));
      const res = await callback(app());
      expect(res.headers.location).toContain('spotify_error=server_error');
      expect(upsertAtomic).not.toHaveBeenCalled();
    });
  }

  it('a failing profile fetch does not create a half-connected account', async () => {
    fetchMock()
      .mockReturnValueOnce(jsonResponse(200, { access_token: 'at', expires_in: 3600 }))
      .mockReturnValueOnce(jsonResponse(401, {}));
    const res = await callback(app());
    expect(res.headers.location).toContain('spotify_error=server_error');
    expect(upsertAtomic).not.toHaveBeenCalled();
  });

  it('a persistence failure is reported rather than announced as connected', async () => {
    fetchMock()
      .mockReturnValueOnce(jsonResponse(200, { access_token: 'at', expires_in: 3600 }))
      .mockReturnValueOnce(jsonResponse(200, { id: 'spotify-user' }));
    upsertAtomic.mockRejectedValue(new Error('connection table offline'));
    const res = await callback(app());
    expect(res.headers.location).toContain('spotify_error=server_error');
  });
});

describe('now playing', () => {
  const app = () => loadRouter(true);
  const nowPlaying = (a: express.Express) => request(a).get('/connections/spotify/now-playing');

  const freshToken = () => ({ accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000 });

  it('reports "not connected" when there is no stored token', async () => {
    getToken.mockResolvedValue(null);
    const res = await nowPlaying(app());
    expect(res.status).toBe(404);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  const silentShapes: Array<[string, () => Promise<Response>]> = [
    ['a 204 with no body', () => emptyResponse(204)],
    ['a 200 that declares an empty body', () => emptyResponse(200, { 'content-length': '0' })],
  ];
  for (const [name, response] of silentShapes) {
    it(`treats ${name} as nothing playing`, async () => {
      getToken.mockResolvedValue(freshToken());
      fetchMock().mockReturnValueOnce(response());
      const res = await nowPlaying(app());
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ playing: false });
    });
  }

  it('treats a response with no item as nothing playing', async () => {
    getToken.mockResolvedValue(freshToken());
    fetchMock().mockReturnValueOnce(jsonResponse(200, { is_playing: false }));
    const res = await nowPlaying(app());
    expect(res.body).toEqual({ playing: false });
  });

  it('projects a playing track with every field the client needs', async () => {
    getToken.mockResolvedValue(freshToken());
    fetchMock().mockReturnValueOnce(jsonResponse(200, {
      is_playing: true,
      item: {
        name: 'Song', artists: [{ name: 'A' }, { name: 'B' }],
        album: { name: 'Album', images: [{ url: 'https://cdn/art.jpg' }] },
        external_urls: { spotify: 'https://open.spotify.com/track/1' },
      },
      progress_ms: 1000, duration_ms: 200000,
    }));

    const res = await nowPlaying(app());

    expect(res.body).toEqual({
      playing: true, track: 'Song', artist: 'A, B', album: 'Album',
      albumArt: 'https://cdn/art.jpg', url: 'https://open.spotify.com/track/1',
      progressMs: 1000, durationMs: 200000,
    });
  });

  it('a track with no artwork or timings degrades to explicit nulls and zeros', async () => {
    getToken.mockResolvedValue(freshToken());
    fetchMock().mockReturnValueOnce(jsonResponse(200, {
      is_playing: true,
      item: {
        name: 'Song', artists: [], album: { name: 'Album', images: [] },
        external_urls: { spotify: 'https://open.spotify.com/track/1' },
      },
    }));

    const res = await nowPlaying(app());

    expect(res.body).toMatchObject({ albumArt: null, progressMs: 0, durationMs: 0, artist: '' });
  });

  it('a provider error is a 502, not a 200 with a broken body', async () => {
    getToken.mockResolvedValue(freshToken());
    fetchMock().mockReturnValueOnce(jsonResponse(500, {}));
    const res = await nowPlaying(app());
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Spotify API error');
  });

  it('a network failure is a 502 and is logged', async () => {
    getToken.mockResolvedValue(freshToken());
    fetchMock().mockRejectedValueOnce(new Error('socket hang up'));
    const res = await nowPlaying(app());
    expect(res.status).toBe(502);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spotify.now_playing.network_failed' }), expect.any(String));
  });

  it('an expired token with no refresh token asks the user to reconnect', async () => {
    getToken.mockResolvedValue({ accessToken: 'at', refreshToken: null, expiresAt: Date.now() - 1000 });
    const res = await nowPlaying(app());
    expect(res.status).toBe(401);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('a corrupt persisted expiry is treated as expired, not as valid', async () => {
    getToken.mockResolvedValue({ accessToken: 'at', refreshToken: null, expiresAt: 'not-a-timestamp' });
    const res = await nowPlaying(app());
    expect(res.status).toBe(401);
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it('an expiring token is refreshed and the new one is persisted', async () => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() + 1000 });
    fetchMock()
      .mockReturnValueOnce(jsonResponse(200, { access_token: 'new', expires_in: 3600 }))
      .mockReturnValueOnce(emptyResponse(204));

    const res = await nowPlaying(app());

    expect(res.status).toBe(200);
    expect(updateAccessToken).toHaveBeenCalledWith('u1', 'spotify', 'new', expect.any(Number));
    const [, playerInit] = fetchMock().mock.calls[1] as [string, any];
    expect(playerInit.headers.Authorization).toBe('Bearer new');
  });

  const badRefreshes: Array<[string, unknown]> = [
    ['no access token', { expires_in: 3600 }],
    ['a non-string access token', { access_token: 5, expires_in: 3600 }],
    ['no expiry', { access_token: 'new' }],
    ['an implausibly long expiry', { access_token: 'new', expires_in: 86_401 }],
  ];
  for (const [name, body] of badRefreshes) {
    it(`refuses a refresh response with ${name}`, async () => {
      getToken.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1 });
      fetchMock().mockReturnValueOnce(jsonResponse(200, body));
      const res = await nowPlaying(app());
      expect(res.status).toBe(502);
      expect(updateAccessToken).not.toHaveBeenCalled();
    });
  }

  it('a failed refresh does not fall back to the stale token', async () => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1 });
    fetchMock().mockReturnValueOnce(jsonResponse(400, {}));
    const res = await nowPlaying(app());
    expect(res.status).toBe(502);
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it('a refresh network failure is a 502 and is logged', async () => {
    getToken.mockResolvedValue({ accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1 });
    fetchMock().mockRejectedValueOnce(new Error('dns failure'));
    const res = await nowPlaying(app());
    expect(res.status).toBe(502);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'spotify.oauth.refresh_failed' }), expect.any(String));
  });
});

describe('disconnecting', () => {
  it('removes the token and the visible connection together', async () => {
    const res = await request(loadRouter(true)).delete('/connections/spotify');
    expect(res.status).toBe(200);
    expect(deleteAtomic).toHaveBeenCalledWith('u1', 'spotify');
  });
});
