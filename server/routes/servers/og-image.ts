/**
 * @openapi
 * tags:
 *   - name: Servers
 *     description: Servers API endpoints

 *
 * /servers/{sid}/og-image:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu Open Graph SVG gorsel
 *     security: []
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sunucu OG SVG gorseli
 *         content:
 *           image/svg+xml:
 *             schema: { type: string }
 *       404: { $ref: '#/components/responses/NotFound' }
 */

// server/routes/servers/og-image.ts — Open Graph SVG image for server invite previews
import express from 'express';
const router = express.Router({ mergeParams: true });

import { Servers } from '../../db/repositories';
// GET /api/servers/:sid/og-image
router.get('/', async (req, res) => {
  const sidParam = (req.params as { sid?: unknown }).sid;
  const sid = typeof sidParam === 'string' ? sidParam : '';
  const server = await Servers.findById(sid);
  const name   = server?.name  || 'Bridge';
  const icon   = server?.icon  || '🌐';
  const color  = (server as unknown as Record<string, unknown> | null)?.color as string || '#2d9cdb';

  const safeIcon = icon.replace(/[<>&"]/g, '');
  const safeName = name.slice(0, 30).replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as Record<string, string>)[c]);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#1a1b1e"/>
  <rect x="0" y="0" width="1200" height="8" fill="${color}"/>
  <circle cx="600" cy="260" r="120" fill="${color}" opacity="0.15"/>
  <text x="600" y="300" font-size="130" text-anchor="middle" dominant-baseline="middle">${safeIcon}</text>
  <text x="600" y="420" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle">${safeName}</text>
  <text x="600" y="490" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    font-size="28" fill="#b5bac1" text-anchor="middle">Bridge ile sohbete katıl 🌉</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=300');
  res.send(svg);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
