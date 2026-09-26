/**
 * @openapi
 * tags:
 *   - name: Media
 *     description: Media API endpoints

 *
 * /media/proxy:
 *   get:
 *     tags: [Upload]
 *     summary: Uzak medya proxy (SSRF korumalı)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Medya icerigi
 *       400:
 *         description: Gecersiz veya yasakli URL
 *
 * /media/gif/search:
 *   get:
 *     tags: [Messages]
 *     summary: GIF arama (Tenor)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: GIF listesi
 *
 * /media/gif/trending:
 *   get:
 *     tags: [Messages]
 *     summary: Trend GIFler
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Trend GIF listesi
 */

// server/routes/media.ts
// Tenor GIF proxy + LibreTranslate proxy (moved from index.js)
import express from 'express';
import { activeGifProvider, clampGifLimit, GIF_MAX_QUERY } from '../lib/gifProvider';
const router  = express.Router();
import { authMiddleware } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { fetchT } from '../lib/fetch';
import { Users } from '../db/repositories';
import { setMediaCookie } from '../lib/mediaCookie';

// POST /api/media/renew — reissue the path-scoped attachment identity cookie.
// The normal access session is the authority; media tokens are rejected by
// authMiddleware and cannot renew themselves.
router.post('/renew', authMiddleware, limits.refresh(), async (req, res) => {
  const user = await Users.findById(req.user.id);
  if (!user) return res.status(401).json({ error: 'User not found' });
  setMediaCookie(res, user);
  return res.json({ ok: true });
});

// ════════════════════════════════════════════════════════════════════════════
// GIF — TARAYICI → BRIDGE → SAGLAYICI
// ════════════════════════════════════════════════════════════════════════════
// Mimari zaten dogruydu (anahtar sunucuda kalir, tarayici saglayiciya
// DOGRUDAN gitmez). Kapatilan dort eksik:
//
//   1. HIZ SINIRI YOKTU — bu iki uc, diger tum uclarin aksine `limits.*()`
//      tasimiyordu. Kimligi dogrulanmis biri Bridge uzerinden saglayiciya
//      sinirsiz istek surebilir, KOTA ve FATURA tuketebilirdi.
//   2. Saglayici yaniti HAM geciyordu; istemci Tenor semasina baglaniyordu.
//   3. Saglayici URL'leri rotaya gomuluydu (soyutlama yok).
//   4. Yukari akis 4xx/5xx yaniti SONUC gibi aktarilabiliyordu.
//
// Artik `lib/gifProvider.ts` saglayiciyi soyutlar, yaniti NORMALIZE eder ve
// medya URL'lerini yalnizca HTTPS + bilinen alan adlarindan kabul eder.

// GET /api/media/gif/trending
router.get('/gif/trending', authMiddleware, limits.search(), async (req, res) => {
  const provider = activeGifProvider();
  if (!provider.isConfigured()) return res.status(503).json({ error: 'GIF feature not configured' });

  const items = await provider.trending(clampGifLimit(req.query.limit));
  res.json({ items, provider: provider.name });
});

// GET /api/media/gif/search?q=...
router.get('/gif/search', authMiddleware, limits.search(), async (req, res) => {
  const provider = activeGifProvider();
  if (!provider.isConfigured()) return res.status(503).json({ error: 'GIF feature not configured' });

  const q = String(req.query.q ?? '').trim().slice(0, GIF_MAX_QUERY);
  if (!q) return res.status(400).json({ error: 'q required' });

  const items = await provider.search(q, clampGifLimit(req.query.limit));
  res.json({ items, provider: provider.name });
});

// POST /api/media/translate
router.post('/translate', authMiddleware, limits.write(), async (req, res) => {
  const url = process.env.LIBRETRANSLATE_URL;
  if (!url) return res.status(503).json({ error: 'Translation not configured' });
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const q = body.q;
  const source = body.source ?? 'auto';
  const target = body.target ?? 'tr';
  if (typeof q !== 'string' || !q.trim()) return res.status(400).json({ error: 'q required' });
  const languageCode = /^(?:auto|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)$/;
  if (typeof source !== 'string' || !languageCode.test(source) ||
      typeof target !== 'string' || !languageCode.test(target)) {
    return res.status(400).json({ error: 'source/target invalid' });
  }
  const r = await fetchT(`${url}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: q.slice(0, 5000), source, target, format: 'text',
      api_key: process.env.LIBRETRANSLATE_API_KEY || '',
    }),
    timeoutMs: 15_000,
    skipSsrfCheck: true, // LIBRETRANSLATE_URL yönetici tarafından yapılandırılır (self-hosted servis)
  });
  const data = await r.json();
  res.json(data);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
