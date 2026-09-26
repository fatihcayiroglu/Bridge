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

import { Invites, Servers } from '../../db/repositories';
import { Boosts } from '../../db/repositories/BoostRepository.js';

async function hasPrivatePreviewCapability(req: express.Request, serverId: string): Promise<boolean> {
  const inviteCode = typeof req.query.invite === 'string'
    ? req.query.invite.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
    : '';
  if (inviteCode) {
    const invite = await Invites.findByCode(inviteCode);
    if (invite && String(invite.serverId) === serverId && Invites.isValid(invite) === null) return true;
  }

  const vanity = typeof req.query.vanity === 'string'
    ? req.query.vanity.replace(/[^a-z0-9-]/gi, '').toLowerCase().slice(0, 40)
    : '';
  if (vanity) {
    const live = await Boosts.getLiveVanityServer(vanity);
    if (live && String(live._id) === serverId) return true;
  }
  return false;
}
// GET /api/servers/:sid/og-image
router.get('/', async (req, res) => {
  const sidParam = (req.params as { sid?: unknown }).sid;
  const sid = typeof sidParam === 'string' ? sidParam : '';
  const server = await Servers.findById(sid);
  if (!server) return res.status(404).end();

  const rawServer = server as unknown as Record<string, unknown>;
  const discoverable = rawServer.discoverable === true || rawServer.discoverable === 1;
  if (!discoverable && !await hasPrivatePreviewCapability(req, sid)) {
    // Private server IDs are not a public metadata capability. A valid invite
    // or live public vanity URL may explicitly grant preview access.
    return res.status(404).end();
  }
  const raw = (server && typeof server === 'object')
    ? server as unknown as Record<string, unknown>
    : null;
  const name = typeof raw?.name === 'string' && raw.name ? raw.name : 'Bridge';
  const icon = typeof raw?.icon === 'string' && raw.icon ? raw.icon : '🌐';
  // SVG attribute context: persisted theme data is untrusted.  Bridge server
  // colors are canonical 6-digit hex values; anything else falls back rather
  // than being interpolated into fill="..." where it could create a new
  // attribute/event handler.
  const rawColor = typeof raw?.color === 'string' ? raw.color : '';
  const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#2d9cdb';

  const safeIcon = icon.replace(/[<>&"]/g, '');
  const HTML_ESCAPES: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' };
  // Tablo eşleşmezse KARAKTERİ DÜŞÜRMEK yerine güvenli tarafta kalıp
  // orijinali değil, boş dize koymak SVG'yi bozardı; eşleşme garanti olduğu
  // için yedek olarak karakterin kendisi değil, HTML-güvenli biçimi kullanılır.
  const safeName = name.slice(0, 30).replace(/[<>&"]/g, c => HTML_ESCAPES[c] ?? '');

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
  res.setHeader('Cache-Control', discoverable
    ? 'public, max-age=3600, stale-while-revalidate=300'
    : 'private, no-store');
  res.send(svg);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
