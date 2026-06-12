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
 *       200: { description: Kullanıcı, sunucu, mesaj, aktif oturum sayıları }
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
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
export const router = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Users, Servers, Messages, Members, Channels, Roles, Auth, Dms } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import * as captcha from '../../lib/captcha';
import { rateLimit, limits } from '../../middleware/rateLimit';
import { adminOnly, logAction } from './middleware';
import { usersRouter }      from './users';
import { moderationRouter } from './moderation';

const adminRateLimit = rateLimit(30, 60_000, 'admin');

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

// ── GET /api/admin/users ───────────────────────────────────────
router.get('/users', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const { q = '' } = req.query;
  const pageNum  = Math.max(1, parseInt(String(req.query.page ?? '1'))  || 1);
  const limitNum = Math.min(100, parseInt(String(req.query.limit ?? '50')) || 50);
  const offset   = (pageNum - 1) * limitNum;

  let query: Record<string, unknown> = {};
  if (String(q ?? '').trim()) {
    query = { $or: [
      { username:    { $regex: String(q ?? '').trim() } },
      { displayName: { $regex: String(q ?? '').trim() } },
      { email:       { $regex: String(q ?? '').trim() } },
    ]};
  }

  const total = await Users.count(query);
  const users = (await Users.searchPaginated(query, { skip: offset, limit: limitNum }))
    .map(u => ({
      _id: u._id, username: u.username, displayName: u.displayName,
      email: u.email || null, emailVerified: u.emailVerified || false,
      isAdmin: u.isAdmin || false, twoFactorEnabled: u.twoFactorEnabled || false,
      status: u.status, createdAt: u.createdAt,
    }));

  res.json({ users, total, page: pageNum, pages: Math.ceil(total / limitNum) });
});

// ── PATCH /api/admin/users/:id ─────────────────────────────────
router.patch('/users/:id', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { isAdmin } = req.body as Record<string, string>;
  const target = await Users.findById(String(req.params.id ?? ''));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot modify yourself' });

  const updates: Record<string, unknown> = {};
  if (typeof isAdmin === 'boolean') updates.isAdmin = isAdmin ? 1 : 0;
  if (Object.keys(updates).length) {
    await Users.update(target._id, updates);
    await logAction(_u.id, 'update_user', target._id, { updates });
  }
  res.json({ ok: true });
});

// ── DELETE /api/admin/users/:id ────────────────────────────────
router.delete('/users/:id', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const target = await Users.findById(String(req.params.id ?? ''));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  await Promise.all([
    Messages.removeByUser(target._id),
    Members.removeAllForUser(target._id),
    Auth.revokeAllForUser(target._id),
  ]);
  await Users.delete(target._id);
  await logAction(_u.id, 'delete_user', target._id, { username: target.username });
  res.json({ ok: true });
});

// ── GET /api/admin/servers ─────────────────────────────────────
router.get('/servers', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const allServers = await Servers.findRecentSorted(100);
  const serverIds  = allServers.map(s => s._id);
  const allMembers = await Members.findByServerIds(serverIds, { fields: { serverId: 1 } });
  const countMap: Record<string, number> = {};
  for (const m of allMembers) countMap[m.serverId] = (countMap[m.serverId] || 0) + 1;
  const result = allServers
    .map(s => ({ _id: s._id, name: s.name, icon: s.icon, discoverable: s.discoverable, createdAt: s.createdAt, memberCount: countMap[s._id] || 0 }))
    .sort((a, b) => b.memberCount - a.memberCount);
  res.json(result);
});

// ── DELETE /api/admin/servers/:id ──────────────────────────────
router.delete('/servers/:id', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.id ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });

  await Promise.all([
    Messages.removeByServer(server._id),
    Channels.deleteByServer(server._id),
    Members.removeAllFromServer(server._id),
    Roles.deleteByServer(server._id),
  ]);
  await Servers.delete(server._id);
  await logAction(_u.id, 'delete_server', server._id, { name: server.name });
  res.json({ ok: true });
});

// ── GET /api/admin/logs ────────────────────────────────────────
router.get('/logs', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const logs = await Auth.findAdminLogs({}, 200);
  const adminIds = [...new Set(logs.map(l => l.adminId).filter((v): v is string => typeof v === 'string' && v.length > 0))];
  const admins   = adminIds.length ? await Users.findByIds(adminIds) : [];
  const adminMap = Object.fromEntries(admins.map(u => [u._id, u.username]));
  const enriched = logs.map(l => ({ ...l, adminUsername: typeof l.adminId === 'string' ? adminMap[l.adminId] || 'unknown' : 'unknown' }));
  res.json(enriched);
});

// ── POST /api/admin/broadcast ──────────────────────────────────
router.post('/broadcast', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { message } = req.body as Record<string, string>;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const io = req.app.get('io');
  if (io) {
    io.emit('system_announcement', {
      message: message.trim(),
      from:    req.adminUser?.displayName || req.adminUser?.username || 'admin',
      ts:      Date.now(),
    });
  }
  await logAction(_u.id, 'broadcast', null, { message: message.trim() });
  res.json({ ok: true });
});

// ── POST /api/admin/make-first-admin ───────────────────────────
router.post('/make-first-admin', async (req: Request, res: Response) => {
  const { secret, username } = req.body as Record<string, string>;
  const adminSecret = process.env.ADMIN_SETUP_SECRET;
  if (!adminSecret || secret !== adminSecret)
    return res.status(403).json({ error: 'Invalid secret' });

  const existingAdminCount = await Users.count({ isAdmin: 1 });
  if (existingAdminCount > 0) return res.status(400).json({ error: 'Admin already exists' });
  if (!username) return res.status(400).json({ error: 'username required' });

  const user = await Users.findByUsername(username);
  if (!user) return res.status(404).json({ error: 'User not found' });

  await Users.update(user._id, { isAdmin: 1 });
  res.json({ ok: true, message: `${user.username} is now admin` });
});

// ── GET /api/admin/captcha-stats ───────────────────────────────
router.get('/captcha-stats', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const stats = await captcha.getAdminStats();
  res.json(stats);
});


export default router;

export { adminOnly, logAction } from './middleware';
