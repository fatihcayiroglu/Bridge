/**
 * @openapi
 * tags:
 *   - name: LinkPreview
 *     description: LinkPreview API endpoints

 *
 * /link-preview:
 *   get:
 *     tags: [Messages]
 *     summary: URL onizleme bilgisi getir (OG meta)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: OG title, description, image
 *       400:
 *         description: Gecersiz URL
 *
 * /link-preview/allowed:
 *   get:
 *     tags: [Messages]
 *     summary: Onizlemeye izin verilen domain listesi
 *     security: []
 *     responses:
 *       200:
 *         description: Domain listesi
 */

import express from 'express';
import { authMiddleware } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { extractUrls, fetchLinkPreview } from '../lib/linkPreview';
import type { LinkPreviewValue } from '../lib/linkPreview';

const router = express.Router();

router.get('/', authMiddleware, limits.api, async (req, res) => {
  const rawUrl = String(req.query.url ?? '').trim();
  if (!rawUrl) return res.status(400).json({ error: 'url query param required' });

  const preview = await fetchLinkPreview(rawUrl);
  if (!preview) return res.status(404).json({ error: 'Preview not available' });
  res.json(preview);
});

router.post('/', authMiddleware, limits.api, async (req, res) => {
  const content = String(req.body?.content || '');
  const urls = extractUrls(content, 3);
  if (!urls.length) return res.json({ previews: [] });

  const previews: LinkPreviewValue[] = [];
  for (const url of urls) {
    const preview = await fetchLinkPreview(url);
    if (preview) previews.push(preview);
  }
  res.json({ previews });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
