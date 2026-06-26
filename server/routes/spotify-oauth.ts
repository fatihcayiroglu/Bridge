// server/routes/spotify-oauth.ts — Sprint 93
// Sprint 98: db.query() → OAuthRepository geçişi ✅
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /connections/spotify:
 *   get:
 *     tags: [Connections]
 *     summary: Spotify OAuth akışını başlat
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       302: { description: Spotify yetkilendirme sayfasına yönlendirme }
 *   delete:
 *     tags: [Connections]
 *     summary: Spotify bağlantısını kaldır
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Bağlantı kaldırıldı }
 * /connections/spotify/callback:
 *   get:
 *     tags: [Connections]
 *     summary: Spotify OAuth callback
 *     parameters:
 *       - { name: code, in: query, required: true, schema: { type: string } }
 *       - { name: state, in: query, required: true, schema: { type: string } }
 *     responses:
 *       302: { description: Dashboard'a yönlendirme }
 *       400: { description: Geçersiz state veya kod }
 * /connections/spotify/now-playing:
 *   get:
 *     tags: [Connections]
 *     summary: Şu an Spotify'da çalan parça
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Çalan parça bilgisi veya boş }
 *       404: { description: Spotify bağlı değil }
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import crypto from 'crypto';
import { authMiddleware} from '../middleware/auth';
import { OAuth } from '../db/repositories/OAuthRepository.js';

const CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  || '';
const APP_URL       = process.env.APP_URL               || 'http://localhost:5173';
const SCOPES        = 'user-read-currently-playing user-read-playback-state user-read-private';

// state → userId geçici haritası (production: Redis kullan)
const _stateMap = new Map<string, { userId: string; ts: number }>();

// 10 dakikada bir temizle
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of _stateMap) { if (v.ts < cutoff) _stateMap.delete(k); }
}, 5 * 60 * 1000).unref?.();

// ── GET /oauth/spotify — OAuth başlat ─────────────────────────────────────────
router.get('/spotify', authMiddleware, (req, res) => {
  if (!CLIENT_ID) return res.status(503).json({ error: 'Spotify OAuth not configured' });

  const me    = castAuthed(req).user as { id: string };
  const state = crypto.randomBytes(16).toString('hex');
  _stateMap.set(state, { userId: me.id, ts: Date.now() });

  const url = new URL('https://accounts.spotify.com/authorize');
  url.searchParams.set('client_id',     CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri',  REDIRECT_URI);
  url.searchParams.set('scope',         SCOPES);
  url.searchParams.set('state',         state);
  url.searchParams.set('show_dialog',   'false');

  res.redirect(url.toString());
});

// ── GET /oauth/spotify/callback — OAuth callback ──────────────────────────────
router.get('/spotify/callback', async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;

  if (error || !code || !state) {
    return res.redirect(`${APP_URL}/?spotify_error=${encodeURIComponent(error || 'cancelled')}`);
  }

  const stateData = _stateMap.get(state);
  if (!stateData) return res.redirect(`${APP_URL}/?spotify_error=invalid_state`);
  _stateMap.delete(state);

  // Token exchange
  try {
    const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        Authorization:   'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }).toString(),
    });

    if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`);
    const tokens = await tokenRes.json() as {
      access_token: string; refresh_token?: string; expires_in: number;
    };

    const expiresAt = Date.now() + tokens.expires_in * 1000;

    // Spotify user ID al
    const profileRes = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json() as { id: string; display_name?: string };

    // DB'ye kaydet (upsert)
    await OAuth.upsertToken(stateData.userId, 'spotify', tokens.access_token, tokens.refresh_token ?? null, expiresAt);

    // userConnections'a da kaydet (profilde görünsün)
    await OAuth.upsertConnection(
      stateData.userId,
      'spotify',
      profile.id,
      `https://open.spotify.com/user/${profile.id}`
    );

    res.redirect(`${APP_URL}/?spotify_connected=1`);
  } catch (err) {
    console.error('Spotify OAuth error:', err);
    res.redirect(`${APP_URL}/?spotify_error=server_error`);
  }
});

// ── GET /oauth/spotify/now-playing — Şu an çalınan ───────────────────────────
router.get('/spotify/now-playing', authMiddleware, async (req, res) => {
  const me = castAuthed(req).user as { id: string };

  const tokenRow = await OAuth.getToken(me.id, 'spotify');

  if (!tokenRow) return res.status(404).json({ error: 'Spotify not connected' });

  let accessToken = tokenRow.accessToken;

  // Token refresh gerekiyor mu?
  if (tokenRow.expiresAt < Date.now() + 60_000) {
    if (!tokenRow.refreshToken) return res.status(401).json({ error: 'Token expired, re-connect Spotify' });
    try {
      const refreshRes = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:  'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokenRow.refreshToken }).toString(),
      });
      const refreshed = await refreshRes.json() as { access_token: string; expires_in: number };
      accessToken = refreshed.access_token;
      const newExpiry = Date.now() + refreshed.expires_in * 1000;
      await OAuth.updateAccessToken(me.id, 'spotify', accessToken, newExpiry);
    } catch {
      return res.status(500).json({ error: 'Token refresh failed' });
    }
  }

  // Spotify API'yi çağır
  const npRes = await fetch('https://api.spotify.com/v1/me/player/currently-playing', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (npRes.status === 204 || npRes.status === 200 && npRes.headers.get('content-length') === '0') {
    return res.json({ playing: false });
  }

  if (!npRes.ok) return res.status(502).json({ error: 'Spotify API error' });

  const data = await npRes.json() as {
    is_playing: boolean;
    item?: { name: string; artists: Array<{ name: string }>; album: { name: string; images: Array<{ url: string }> }; external_urls: { spotify: string } };
    progress_ms?: number;
    duration_ms?: number;
  };

  if (!data.item) return res.json({ playing: false });

  res.json({
    playing:    data.is_playing,
    track:      data.item.name,
    artist:     data.item.artists.map(a => a.name).join(', '),
    album:      data.item.album.name,
    albumArt:   data.item.album.images[0]?.url ?? null,
    url:        data.item.external_urls.spotify,
    progressMs: data.progress_ms ?? 0,
    durationMs: data.duration_ms ?? 0,
  });
});

// ── DELETE /oauth/spotify — Spotify bağlantısını kes ─────────────────────────
router.delete('/spotify', authMiddleware, async (req, res) => {
  const me = castAuthed(req).user as { id: string };
  await OAuth.deleteToken(me.id, 'spotify');
  res.json({ ok: true });
});

export { router };
