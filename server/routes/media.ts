// server/routes/media.js
// Tenor GIF proxy + LibreTranslate proxy (moved from index.js)
const express = require('express');
const router  = express.Router();
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// GET /api/media/gif/trending
router.get('/gif/trending', authMiddleware, asyncHandler(async (req, res) => {
  const key = process.env.TENOR_API_KEY;
  if (!key) return res.status(503).json({ error: 'GIF feature not configured' });
  const r = await fetch(`https://tenor.googleapis.com/v2/featured?key=${key}&limit=20&media_filter=gif&contentfilter=medium`);
  const data = await r.json();
  res.json(data);
}));

// GET /api/media/gif/search?q=...
router.get('/gif/search', authMiddleware, asyncHandler(async (req, res) => {
  const key = process.env.TENOR_API_KEY;
  if (!key) return res.status(503).json({ error: 'GIF feature not configured' });
  const q = String(req.query.q ?? '').slice(0, 100);
  if (!q) return res.status(400).json({ error: 'q required' });
  const r = await fetch(`https://tenor.googleapis.com/v2/search?key=${key}&q=${encodeURIComponent(q)}&limit=20&media_filter=gif&contentfilter=medium`);
  const data = await r.json();
  res.json(data);
}));

// POST /api/media/translate
router.post('/translate', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const url = process.env.LIBRETRANSLATE_URL;
  if (!url) return res.status(503).json({ error: 'Translation not configured' });
  const { q, source = 'auto', target = 'tr' } = req.body;
  if (!q?.trim()) return res.status(400).json({ error: 'q required' });
  const r = await fetch(`${url}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      q: q.slice(0, 5000), source, target, format: 'text',
      api_key: process.env.LIBRETRANSLATE_API_KEY || '',
    }),
  });
  const data = await r.json();
  res.json(data);
}));

module.exports = router;
export {};
