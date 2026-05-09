const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { limits } = require('../middleware/rateLimit');
const asyncHandler = require('../middleware/asyncHandler');
const { extractUrls, fetchLinkPreview } = require('../lib/linkPreview');

const router = express.Router();

router.get('/', authMiddleware, limits.read(), asyncHandler(async (req, res) => {
  const rawUrl = String(req.query.url ?? '').trim();
  if (!rawUrl) return res.status(400).json({ error: 'url query param required' });

  const preview = await fetchLinkPreview(rawUrl);
  if (!preview) return res.status(404).json({ error: 'Preview not available' });
  res.json(preview);
}));

router.post('/', authMiddleware, limits.read(), asyncHandler(async (req, res) => {
  const content = String(req.body?.content || '');
  const urls = extractUrls(content, 3);
  if (!urls.length) return res.json({ previews: [] });

  const previews: any[] = [];
  for (const url of urls) {
    const preview = await fetchLinkPreview(url);
    if (preview) previews.push(preview);
  }
  res.json({ previews });
}));

module.exports = router;
export {};
