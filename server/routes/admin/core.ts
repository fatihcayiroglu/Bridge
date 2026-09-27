// server/routes/admin/core.ts
// Sprint 105: Refactor — admin route'ları ayrı modüllere taşındı
// Kullanıcı/sunucu yönetimi → admin/users.ts
// IP ban/karantina          → admin/moderation.ts
// Shared middleware         → admin/middleware.ts

/**
 * @openapi
 * /admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: Platform istatistikleri (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: 'Kullanıcı, sunucu, mesaj, aktif oturum sayıları' }
 * /admin/logs:
 *   get:
 *     tags: [Admin]
 *     summary: Admin eylem logları
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: limit, in: query, schema: { type: integer, default: 50 } }
 *     responses:
 *       200: { description: Admin log listesi }
 * /admin/broadcast:
 *   post:
 *     tags: [Admin]
 *     summary: Tüm kullanıcılara bildirim gönder
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               message: { type: string, maxLength: 500 }
 *               type:    { type: string, enum: [info, warning, maintenance] }
 *     responses:
 *       200: { description: Broadcast gönderildi }
 * /admin/make-first-admin:
 *   post:
 *     tags: [Admin]
 *     summary: İlk admin kullanıcısını ata (kurulum)
 *     description: Yalnızca hiçbir admin yokken çalışır — kurulum sonrası devre dışı
 *     responses:
 *       200: { description: Admin atandı }
 *       403: { description: Admin zaten mevcut }
 * /admin/captcha-stats:
 *   get:
 *     tags: [Admin]
 *     summary: CAPTCHA istatistikleri
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: CAPTCHA pass/fail oranları }
 */

import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
export const router = express.Router();
import { Users, Servers, Messages, Members, Auth, Dms } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import * as captcha from '../../lib/captcha';
import { limits } from '../../middleware/rateLimit';
import { adminOnly, logAction } from './middleware';
import { parseBoundedPositiveIntQuery } from '../../lib/queryNumbers';
import { usersRouter }      from './users';
import { moderationRouter } from './moderation';

// NOT: eski `adminRateLimit` KALDIRILDI — hicbir rotaya baglanmamisti.
// Mutasyon yapan TUM admin uclari `limits.moderation()` kullanir (kanonik).
// Baglanmamis bir limitin durmasi, admin'in ayri bir kotasi varmis
// yanilgisi uretiyordu.

// Sub-routers
router.use('/', usersRouter);
router.use('/', moderationRouter);

// ── GET /api/admin/stats ───────────────────────────────────────
router.get('/stats', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const since7d  = Date.now() - 7  * 24 * 60 * 60 * 1000;
  const since30d = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const [
    totalUsers, totalServers, totalMessages, totalDMs,
    onlineUsers, verifiedEmails, twoFaEnabled, newUsers7d,
  ] = await Promise.all([
    Users.count({}),
    Servers.count({}),
    Messages.count({}),
    Dms.countMessages(),
    Users.count({ status: { $ne: 'offline' } }),
    Users.count({ emailVerified: 1 }),
    Users.count({ twoFactorEnabled: 1 }),
    Users.count({ createdAt: { $gt: since7d } }),
  ]);

  const recentMsgDates = await Messages.findProjected(
    { createdAt: { $gt: since7d } },
    { fields: { createdAt: 1 } },
  );
  const dayBuckets: Record<string, number> = {};
  for (const m of recentMsgDates) {
    const day = Math.floor(m.createdAt / 86400000);
    dayBuckets[day] = (dayBuckets[day] || 0) + 1;
  }
  const msgsByDay = Object.entries(dayBuckets)
    .map(([day, n]) => ({ day: parseInt(day), n }))
    .sort((a, b) => a.day - b.day);

  const allServers = await Servers.find({});
  const topCandidates = allServers.slice(0, 50);
  const candidateIds  = topCandidates.map(s => s._id);
  const allMembers    = await Members.findByServerIds(candidateIds, { fields: { serverId: 1 } });
  const memberCounts: Record<string, number> = {};
  for (const m of allMembers) memberCounts[m.serverId] = (memberCounts[m.serverId] || 0) + 1;
  const topServers = topCandidates
    .map(s => ({ _id: s._id, name: s.name, memberCount: memberCounts[s._id] || 0 }))
    .sort((a, b) => b.memberCount - a.memberCount)
    .slice(0, 10);

  const recentMsgs30 = await Messages.findProjected(
    { createdAt: { $gt: since30d } },
    { fields: { userId: 1, displayName: 1 } },
  );
  const userMsgCount: Record<string, { userId: string; displayName?: string; msgCount: number }> = {};
  for (const m of recentMsgs30) {
    if (!userMsgCount[m.userId]) userMsgCount[m.userId] = { userId: m.userId, displayName: m.displayName, msgCount: 0 };
    userMsgCount[m.userId]!.msgCount++;
  }
  const topUsers = Object.values(userMsgCount)
    .sort((a, b) => b.msgCount - a.msgCount)
    .slice(0, 10);

  res.json({
    totals: { totalUsers, totalServers, totalMessages, totalDMs, onlineUsers, verifiedEmails, twoFaEnabled, newUsers7d },
    msgsByDay,
    topServers: topServers.slice(0, 10),
    topUsers,
  });
});

// User/server CRUD lives exclusively in ./users.ts (mounted above).

// ── GET /api/admin/logs ────────────────────────────────────────
router.get('/logs', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const limit = parseBoundedPositiveIntQuery(req.query.limit, 50, 200);
  if (limit === null) return res.status(400).json({ error: 'limit must be a positive safe integer' });
  const logs = await Auth.findAdminLogs({}, limit);
  const adminIds = [...new Set(logs.map(l => l.adminId).filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const admins   = adminIds.length ? await Users.findByIds(adminIds) : [];
  const adminMap = Object.fromEntries(admins.map(u => [u._id, u.username]));
  const enriched = logs.map(l => ({ ...l, adminUsername: typeof l.adminId === 'string' ? adminMap[l.adminId] || 'unknown' : 'unknown' }));
  res.json(enriched);
});

// ── POST /api/admin/broadcast ──────────────────────────────────
router.post('/broadcast', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const rawMessage = (req.body && typeof req.body === 'object') ? (req.body as Record<string, unknown>).message : undefined;
  if (typeof rawMessage !== 'string') return res.status(400).json({ error: 'message must be a string' });
  const message = rawMessage.trim();
  if (!message) return res.status(400).json({ error: 'message required' });
  if (message.length > 500) return res.status(400).json({ error: 'message too long (max 500)' });

  const io = req.app.get('io');
  if (io) {
    io.emit('system_announcement', {
      message,
      from:    req.adminUser?.displayName || req.adminUser?.username || 'admin',
      ts:      Date.now(),
    });
  }
  await logAction(_u.id, 'broadcast', null, { message });
  res.json({ ok: true });
});

// ── POST /api/admin/make-first-admin ───────────────────────────
function constantTimeSetupSecretEqual(provided: string, expected: string): boolean {
  // Hash both values first so comparison length never leaks the configured secret
  // length and timingSafeEqual always receives equal-size buffers.
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

router.post('/make-first-admin', limits.adminSetup(), async (req: Request, res: Response) => {
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const secret = body.secret;
  const usernameRaw = body.username;
  const adminSecret = process.env.ADMIN_SETUP_SECRET;
  if (!adminSecret || typeof secret !== 'string' || !constantTimeSetupSecretEqual(secret, adminSecret))
    return res.status(403).json({ error: 'Invalid secret' });

  const existingAdminCount = await Users.count({ isAdmin: true });
  if (existingAdminCount > 0) return res.status(400).json({ error: 'Admin already exists' });
  if (typeof usernameRaw !== 'string' || !usernameRaw.trim()) return res.status(400).json({ error: 'username required' });
  const username = usernameRaw.trim();

  const user = await Users.findByUsername(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await Users.update(user._id, { isAdmin: true });
  res.json({ ok: true, message: `${user.username} is now admin` });
});

// ── GET /api/admin/captcha-stats ───────────────────────────────
router.get('/captcha-stats', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const stats = await captcha.getAdminStats();
  res.json(stats);
});


export default router;

export { adminOnly, logAction } from './middleware';
