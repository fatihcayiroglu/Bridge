// server/routes/admin/moderation.ts
// Sprint 105: admin/core.ts'den ayrıştırıldı — IP ban & Karantina yönetimi
// GET  /api/admin/ip-bans
// POST /api/admin/ip-bans
// DELETE /api/admin/ip-bans/:ip
// GET  /api/admin/quarantine
// DELETE /api/admin/quarantine/:filename

/**
 * @openapi
 * /admin/ip-bans:
 *   get:
 *     tags: [Admin]
 *     summary: IP ban listesi (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Banlı IP listesi }
 *   post:
 *     tags: [Admin]
 *     summary: IP banla (admin)
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
 *       200: { description: IP banlandı }
 * /admin/ip-bans/{ip}:
 *   delete:
 *     tags: [Admin]
 *     summary: IP ban kaldır (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: ip, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Ban kaldırıldı }
 * /admin/quarantine:
 *   get:
 *     tags: [Admin]
 *     summary: Karantina dosyaları listele (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Karantina dosya listesi }
 * /admin/quarantine/{filename}:
 *   delete:
 *     tags: [Admin]
 *     summary: Karantina dosyasını sil (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: filename, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Dosya silindi }
 */

import express, { Request, Response } from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
export const moderationRouter = express.Router();
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { adminOnly, logAction } from './middleware';
import { banIp, unbanIp, listBans, getClientIp } from '../../middleware/ipBan';
import { listQuarantinedFiles, deleteQuarantinedFile } from '../../lib/contentScanner';
import path from 'path';
import fs from 'fs';

// ── IP Ban endpoints ───────────────────────────────────────────

moderationRouter.get('/ip-bans', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const bans = await listBans();
  bans.sort((a, b) => b.bannedAt - a.bannedAt);
  res.json(bans);
});

moderationRouter.post('/ip-bans', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { ip, reason = 'Admin ban', durationMs = null } = req.body as Record<string, string>;

  if (!ip?.trim()) return res.status(400).json({ error: 'ip zorunlu' });

  const ipTrimmed = ip.trim();
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ipTrimmed);
  const ipv6 = /^[0-9a-fA-F:]+$/.test(ipTrimmed) && ipTrimmed.includes(':');
  if (!ipv4 && !ipv6) return res.status(400).json({ error: 'Geçersiz IP formatı' });

  const adminIp = getClientIp(req);
  if (ipTrimmed === adminIp) {
    return res.status(400).json({ error: 'Kendi IP adresinizi engelleyemezsiniz' });
  }

  const dur = durationMs ? parseInt(durationMs) : null;
  const entry = await banIp(ipTrimmed, {
    reason: reason.trim().slice(0, 200) || 'Admin ban',
    durationMs: dur && dur > 0 ? dur : null,
    adminId: _u.id,
  });

  await logAction(_u.id, 'ip_ban', ipTrimmed, {
    reason: entry.reason,
    durationMs: entry.expiresAt ? (entry.expiresAt - entry.bannedAt) : null,
  });

  res.json({ ok: true, ban: entry });
});

moderationRouter.delete('/ip-bans/:ip', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const ip = decodeURIComponent(String(req.params.ip ?? '')).trim();
  if (!ip) return res.status(400).json({ error: 'ip zorunlu' });
  await unbanIp(ip);
  await logAction(_u.id, 'ip_unban', ip);
  res.json({ ok: true });
});

// ── Karantina endpoints ────────────────────────────────────────

moderationRouter.get('/quarantine', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const files = listQuarantinedFiles();
  res.json({
    count: files.length,
    files: files.map(f => ({
      filename:      f.filename,
      size:          f.size,
      reason:        f.reason,
      severity:      f.severity,
      quarantinedAt: f.quarantinedAt,
      userId:        f.userId,
      username:      f.username,
      originalName:  f.filename,
      hash:          f.hash,
    })),
  });
});

moderationRouter.delete('/quarantine/:filename', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const filename = String(req.params.filename ?? '');
  if (!filename || filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Geçersiz dosya adı' });
  }
  deleteQuarantinedFile(filename);
  await logAction(_u.id, 'quarantine_delete', filename);
  res.json({ ok: true });
});

