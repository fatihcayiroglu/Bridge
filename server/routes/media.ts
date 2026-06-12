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
const router  = express.Router();
import { authMiddleware } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { fetchT } from '../lib/fetch';

// GET /api/media/gif/trending
router.get('/gif/trending', authMiddleware, async (req, res) => {
  const key = process.env.TENOR_API_KEY;
  if (!key) return res.status(503).json({ error: 'GIF feature not configured' });
  const r = await fetchT(`https://tenor.googleapis.com/v2/featured?key=${key}&limit=20&media_filter=gif&contentfilter=medium`, { timeoutMs: 8000 });
  const data = await r.json();
  res.json(data);
});

// GET /api/media/gif/search?q=...
router.get('/gif/search', authMiddleware, async (req, res) => {
  const key = process.env.TENOR_API_KEY;
  if (!key) return res.status(503).json({ error: 'GIF feature not configured' });
  const q = String(req.query.q ?? '').slice(0, 100);
  if (!q) return res.status(400).json({ error: 'q required' });
  const r = await fetchT(`https://tenor.googleapis.com/v2/search?key=${key}&q=${encodeURIComponent(q)}&limit=20&media_filter=gif&contentfilter=medium`, { timeoutMs: 8000 });
  const data = await r.json();
  res.json(data);
});

// POST /api/media/translate
router.post('/translate', authMiddleware, limits.write(), async (req, res) => {
  const url = process.env.LIBRETRANSLATE_URL;
  if (!url) return res.status(503).json({ error: 'Translation not configured' });
  const { q, source = 'auto', target = 'tr' } = req.body as Record<string, string>;
  if (!q?.trim()) return res.status(400).json({ error: 'q required' });
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
