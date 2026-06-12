/**
 * @openapi
 *
 * /admin/ip-bans:
 *   get:
 *     tags: [Admin]
 *     summary: IP ban listesini getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Ban listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   post:
 *     tags: [Admin]
 *     summary: IP ban ekle
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
 *
 * /admin/ip-bans/{ip}:
 *   delete:
 *     tags: [Admin]
 *     summary: IP bani kaldir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: ip
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ban kaldirildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// ════════════════════════════════════════════════════════════════
// @legacy — SADECE DOKÜMANTASYON AMAÇLIDIR
// Bu dosya bağımsız olarak derlenmez ve hiçbir yere import edilmez.
// Gerçek implementasyon: server/routes/admin/core.ts (ip-ban route'ları orada).
// Bu dosya eski bir "buraya yapıştır" talimat belgesi olarak tarihi referans için korunuyor.
// ════════════════════════════════════════════════════════════════
// NOTE: Bu dosya hiçbir yere import edilmez (legacy referans belgesi).
// Gerçek implementasyon: server/routes/admin/core.ts

import { banIp, unbanIp, listBans, getClientIp } from '../middleware/ipBan';
import { limits } from '../middleware/rateLimit';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
// ── GET /api/admin/ip-bans ──────────────────────────────────────
// Aktif tüm IP yasaklarını listele
router.get('/ip-bans', authMiddleware, adminOnly, async (req, res) => {
  const bans = await listBans();
  bans.sort((a, b) => b.bannedAt - a.bannedAt);
  res.json(bans);
});

// ── POST /api/admin/ip-bans ─────────────────────────────────────
// Yeni IP yasağı ekle
// Body: { ip, reason?, durationMs? }
//   durationMs = null veya 0  → kalıcı
//   durationMs = 3600000      → 1 saat
router.post('/ip-bans', authMiddleware, limits.moderation(), adminOnly, async (req, res) => {
  const _u = castAuthed(req).user;
  const { ip, reason = 'Admin ban', durationMs = null } = req.body as Record<string, string>;

  if (!ip?.trim()) return res.status(400).json({ error: 'ip zorunlu' });

  // Basit IP format kontrolü (IPv4 + IPv6)
  const ipTrimmed = ip.trim();
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ipTrimmed);
  const ipv6 = /^[0-9a-fA-F:]+$/.test(ipTrimmed) && ipTrimmed.includes(':');
  if (!ipv4 && !ipv6) return res.status(400).json({ error: 'Geçersiz IP formatı' });

  // Kendi IP'ini yasaklama
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

// ── DELETE /api/admin/ip-bans/:ip ──────────────────────────────
// IP yasağını kaldır
// :ip URL-encoded olabilir (ör. 192.168.1.1 → 192.168.1.1)
router.delete('/ip-bans/:ip', authMiddleware, limits.moderation(), adminOnly, async (req, res) => {
  const _u = castAuthed(req).user;
  const ip = decodeURIComponent(String(req.params.ip ?? '')).trim();
  if (!ip) return res.status(400).json({ error: 'ip zorunlu' });

  await unbanIp(ip);
  await logAction(_u.id, 'ip_unban', ip);
  res.json({ ok: true });
});
