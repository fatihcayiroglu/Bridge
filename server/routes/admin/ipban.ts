// server/routes/admin/ipban.ts
// IP ban yönetimi — admin-only routes
// GET /api/admin/ip-bans
// POST /api/admin/ip-bans
// DELETE /api/admin/ip-bans/:ip

/**
 * @openapi
 * /admin/ip-bans:
 *   get:
 *     tags: [Admin]
 *     summary: IP ban listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Ban listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/IpBanEntry' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Admin]
 *     summary: IP ban ekle
 *     description: durationMs null/0 = kalıcı. Kendi IP yasaklanamaz.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ip]
 *             properties:
 *               ip:         { type: string, example: '1.2.3.4' }
 *               reason:     { type: string, maxLength: 200 }
 *               durationMs: { type: integer, nullable: true, example: 3600000 }
 *     responses:
 *       200:
 *         description: Ban eklendi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:    { type: boolean }
 *                 entry: { $ref: '#/components/schemas/IpBanEntry' }
 *       400: { description: 'Geçersiz IP' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/ip-bans/{ip}:
 *   delete:
 *     tags: [Admin]
 *     summary: IP ban kaldır
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: ip
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Ban kaldırıldı' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * components:
 *   schemas:
 *     IpBanEntry:
 *       type: object
 *       properties:
 *         ip:        { type: string }
 *         reason:    { type: string }
 *         bannedAt:  { type: integer }
 *         expiresAt: { type: integer, nullable: true }
 *         adminId:   { type: string }

 *
 * /admin/ip-bans:
 *   post:
 *     tags: [Admin]
 *     summary: IP ban ekle (TypeScript route)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ip]
 *             properties:
 *               ip:     { type: string }
 *               reason: { type: string }
 *     responses:
 *       200:
 *         description: Ban eklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

import express, { Request, Response } from 'express';
import { banIp, unbanIp, listBans, getClientIp } from '../../middleware/ipBan';
import { limits } from '../../middleware/rateLimit';
import { authMiddleware} from '../../middleware/auth';
import { adminOnly, logAction } from './core';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

// ── GET /api/admin/ip-bans ──────────────────────────────────────
// Aktif tüm IP yasaklarını listele
router.get('/ip-bans', authMiddleware, adminOnly, async (_req: Request, res: Response) => {
  const bans = await listBans();
  bans.sort((a, b) => b.bannedAt - a.bannedAt);
  res.json(bans);
});

// ── POST /api/admin/ip-bans ─────────────────────────────────────
// Yeni IP yasağı ekle
// Body: { ip, reason?, durationMs? }
//   durationMs = null veya 0  → kalıcı
//   durationMs = 3600000      → 1 saat
router.post('/ip-bans', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { ip, reason = 'Admin ban', durationMs = null } = req.body as {
    ip?: string;
    reason?: string;
    durationMs?: number | string | null;
  };

  if (!ip?.trim()) return res.status(400).json({ error: 'ip zorunlu' });

  const ipTrimmed = ip.trim();

  // Basit IP format kontrolü (IPv4 + IPv6)
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ipTrimmed);
  const ipv6 = /^[0-9a-fA-F:]+$/.test(ipTrimmed) && ipTrimmed.includes(':');
  if (!ipv4 && !ipv6) return res.status(400).json({ error: 'Geçersiz IP formatı' });

  // Kendi IP'ini yasaklama
  const adminIp = getClientIp(req);
  if (ipTrimmed === adminIp) {
    return res.status(400).json({ error: 'Kendi IP adresinizi engelleyemezsiniz' });
  }

  const dur = durationMs ? parseInt(String(durationMs)) : null;
  const entry = await banIp(ipTrimmed, {
    reason: String(reason).trim().slice(0, 200) || 'Admin ban',
    durationMs: dur && dur > 0 ? dur : null,
    adminId: _u.id,
  });

  await logAction(_u.id, 'ip_ban', ipTrimmed, {
    reason: entry.reason,
    durationMs: entry.expiresAt ? (entry.expiresAt - entry.bannedAt) : null,
  });

  res.json({ ok: true, ban: entry });
});

// ── DELETE /api/admin/ip-bans/:ip ──────────────────────────────
// IP yasağını kaldır
// :ip URL-encoded olabilir (ör. 192.168.1.1 → 192.168.1.1)
router.delete('/ip-bans/:ip', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const ip = decodeURIComponent(String(req.params.ip ?? '')).trim();
  if (!ip) return res.status(400).json({ error: 'ip zorunlu' });

  await unbanIp(ip);
  await logAction(_u.id, 'ip_unban', ip);
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
