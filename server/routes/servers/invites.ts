/**
 * @openapi
 * tags:
 *   - name: Servers
 *     description: Servers API endpoints

 *
 * /servers/{sid}/invites:
 *   post:
 *     tags: [Servers]
 *     summary: Davet linki olustur
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               maxUses:   { type: integer, nullable: true }
 *               expiresIn: { type: integer, description: 'Saniye cinsinden sure', nullable: true }
 *     responses:
 *       201:
 *         description: Davet olusturuldu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 code: { type: string }
 *                 url:  { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /invites/{code}/use:
 *   post:
 *     tags: [Servers]
 *     summary: Davet kodunu kullanarak sunucuya katil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sunucuya katilindi
 *       404: { $ref: '#/components/responses/NotFound' }
 *
 * /invites/{code}/qr:
 *   get:
 *     tags: [Servers]
 *     summary: Davet QR kodu (HTML sayfasi)
 *     security: []
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: QR kodu HTML
 *         content:
 *           text/html:
 *             schema: { type: string }
 *
 * /invites/{code}/qr/data:
 *   get:
 *     tags: [Servers]
 *     summary: Davet QR kodu JSON verisi
 *     security: []
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: QR veri URL'i ve metadata
 *
 * /invites/{code}/qr/png:
 *   get:
 *     tags: [Servers]
 *     summary: Davet QR kodu PNG gorsel
 *     security: []
 *     parameters:
 *       - in: path
 *         name: code
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: PNG gorsel
 *         content:
 *           image/png:
 *             schema: { type: string, format: binary }
 *       404: { $ref: '#/components/responses/NotFound' }
 */

// server/routes/servers/invites.ts — Invite CRUD + QR code routes
import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router({ mergeParams: true });

import { Invites, Members, Servers } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { invalidateMemberCount } from '../discover';
import { tryRequire } from '../../lib/_optional-require';


function assertInvite(invite: Awaited<ReturnType<typeof Invites.findByCode>>, res: express.Response): asserts invite is NonNullable<Awaited<ReturnType<typeof Invites.findByCode>>> {
  const err = Invites.isValid(invite);
  if (err) {
    res.status(invite ? 410 : 404).json({ error: err });
    throw new Error('invalid invite');
  }
}

const _dispatchEvent = tryRequire<{ dispatchEvent: (sid: string, ev: string, d: unknown) => Promise<unknown> }>('../outgoingWebhooks')?.dispatchEvent ?? null;

// POST /api/servers/invites
router.post('/', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.body as Record<string, string>;
  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this server' });

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const maxUses = parseInt(req.body.maxUses) || 0;
  const { code, expiresAt } = await Invites.create({ serverId, createdBy: _u.id, maxUses });
  res.json({ code, expiresAt, maxUses, serverName: server.name });
});

// POST /api/servers/invites/:code/use
router.post('/:code/use', authMiddleware, limits.servers(), async (req, res) => {
  const _u   = castAuthed(req).user;
  const code = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const existing = await Members.findOne(_u.id, invite.serverId);
  if (existing) return res.status(400).json({ error: 'Already a member' });

  await Members.insert(_u.id, invite.serverId);
  invalidateMemberCount(invite.serverId).catch(() => {});
  if (_dispatchEvent) _dispatchEvent(invite.serverId, 'member:join', { userId: _u.id }).catch(() => {});
  await Invites.incrementUses(invite._id);

  const server = await Servers.findById(invite.serverId);
  res.json(server);
});

// GET /api/servers/invites/:code/qr  — SVG
router.get('/:code/qr', authMiddleware, async (req, res) => {
  const code   = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;
  const qrSvg    = generateQrSvg(inviteUrl);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(qrSvg);
});

// GET /api/servers/invites/:code/qr/data  — JSON data URL
router.get('/:code/qr/data', authMiddleware, async (req, res) => {
  const code   = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const server    = await Servers.findById(invite.serverId);
  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;
  const qrSvg    = generateQrSvg(inviteUrl);
  const dataUrl  = 'data:image/svg+xml;base64,' + Buffer.from(qrSvg ?? '').toString('base64');

  res.json({ code, inviteUrl, qrDataUrl: dataUrl, serverName: server?.name, expiresAt: invite.expiresAt });
});

// GET /api/servers/invites/:code/qr/png  — PNG (requires 'qrcode' package)
router.get('/:code/qr/png', authMiddleware, async (req, res) => {
   
  let QRCode: { toBuffer: (url: string, opts: unknown) => Promise<Buffer> } | undefined;
  try { QRCode = await import('qrcode') as typeof QRCode; } catch {
    return res.status(501).json({ error: 'QR PNG için: npm install qrcode', hint: 'SVG endpoint kullanın: /qr' });
  }

  const code   = String(String(req.params.code ?? '')).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  try { assertInvite(invite, res); } catch { return; }

  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;

  if (!QRCode) return res.status(501).json({ error: 'QR PNG için qrcode modülü yüklenemedi' });
  const pngBuffer = await QRCode.toBuffer(inviteUrl, { width: 300, margin: 2, color: { dark: '#2d9cdb', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(pngBuffer);
});

// ── QR SVG generator (no external dependency) ─────────────────
function generateQrSvg(text: string): string {
  const escaped = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240" viewBox="0 0 200 240">
  <rect width="200" height="240" fill="white"/>
  <rect x="10" y="10" width="180" height="180" rx="8" fill="none" stroke="#2d9cdb" stroke-width="3" stroke-dasharray="8,4"/>
  <text x="100" y="105" font-family="monospace" font-size="11" fill="#2d9cdb" text-anchor="middle">QR için:</text>
  <text x="100" y="120" font-family="monospace" font-size="9" fill="#2d9cdb" text-anchor="middle">npm i qrcode</text>
  <text x="100" y="210" font-family="sans-serif" font-size="9" fill="#666" text-anchor="middle">${escaped.slice(0, 40)}</text>
  <text x="100" y="225" font-family="sans-serif" font-size="8" fill="#999" text-anchor="middle">Bridge Davet Linki</text>
</svg>`;
}

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
