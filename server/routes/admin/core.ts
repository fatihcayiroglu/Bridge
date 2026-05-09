// @ts-nocheck
// server/routes/admin/core.js
// Admin panel: kullanıcı, sunucu, log, broadcast, IP ban, karantina

'use strict';

const express    = require('express');
const router     = express.Router();
const { v4: uuidv4 } = require('uuid');
const {
  Users, Servers, Messages, Members, Channels, Roles, Auth, Dms,
} = require('../../db/repositories');
const { authMiddleware, castAuthed } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { rateLimit, limits } = require('../../middleware/rateLimit');

const adminRateLimit = rateLimit(30, 60_000, 'admin');

// ── Admin kontrol middleware ───────────────────────────────────
async function adminOnly(req, res, next) {
  const user = await Users.findById(req.user.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  req.adminUser = user;
  next();
}

async function logAction(adminId, action, target = null, detail = null) {
  await Auth.insertAdminLog({
    adminId, action, target,
    detail: detail ? JSON.stringify(detail) : null,
  });
}

// ── GET /api/admin/stats ───────────────────────────────────────
router.get('/stats', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
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
  const dayBuckets = {};
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
  const memberCounts  = {};
  for (const m of allMembers) memberCounts[m.serverId] = (memberCounts[m.serverId] || 0) + 1;
  const topServers = topCandidates
    .map(s => ({ _id: s._id, name: s.name, memberCount: memberCounts[s._id] || 0 }))
    .sort((a, b) => b.memberCount - a.memberCount)
    .slice(0, 10);

  const recentMsgs30 = await Messages.findProjected(
    { createdAt: { $gt: since30d } },
    { fields: { userId: 1, displayName: 1 } },
  );
  const userMsgCount = {};
  for (const m of recentMsgs30) {
    if (!userMsgCount[m.userId]) userMsgCount[m.userId] = { userId: m.userId, displayName: m.displayName, msgCount: 0 };
    userMsgCount[m.userId].msgCount++;
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
}));

// ── GET /api/admin/users ───────────────────────────────────────
router.get('/users', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const { q = '', page = 1, limit = 50 } = req.query;
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(100, parseInt(limit) || 50);
  const offset   = (pageNum - 1) * limitNum;

  let query = {};
  if (q.trim()) {
    query = { $or: [
      { username:    { $regex: q.trim() } },
      { displayName: { $regex: q.trim() } },
      { email:       { $regex: q.trim() } },
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
}));

// ── PATCH /api/admin/users/:id ─────────────────────────────────
router.patch('/users/:id', authMiddleware, limits.moderation(), adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { isAdmin } = req.body;
  const target = await Users.findById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot modify yourself' });

  const updates = {};
  if (typeof isAdmin === 'boolean') updates.isAdmin = isAdmin ? 1 : 0;
  if (Object.keys(updates).length) {
    await Users.update(target._id, updates);
    await logAction(_u.id, 'update_user', target._id, { updates });
  }
  res.json({ ok: true });
}));

// ── DELETE /api/admin/users/:id ────────────────────────────────
router.delete('/users/:id', authMiddleware, limits.moderation(), adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const target = await Users.findById(req.params.id);
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
}));

// ── GET /api/admin/servers ─────────────────────────────────────
router.get('/servers', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const allServers = await Servers.findRecentSorted(100);
  const serverIds  = allServers.map(s => s._id);
  const allMembers = await Members.findByServerIds(serverIds, { fields: { serverId: 1 } });
  const countMap   = {};
  for (const m of allMembers) countMap[m.serverId] = (countMap[m.serverId] || 0) + 1;
  const result = allServers
    .map(s => ({ _id: s._id, name: s.name, icon: s.icon, discoverable: s.discoverable, createdAt: s.createdAt, memberCount: countMap[s._id] || 0 }))
    .sort((a, b) => b.memberCount - a.memberCount);
  res.json(result);
}));

// ── DELETE /api/admin/servers/:id ──────────────────────────────
router.delete('/servers/:id', authMiddleware, limits.moderation(), adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(req.params.id);
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
}));

// ── GET /api/admin/logs ────────────────────────────────────────
router.get('/logs', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const logs = await Auth.findAdminLogs({}, 200);
  const adminIds = [...new Set(logs.map(l => l.adminId).filter(Boolean))];
  const admins   = adminIds.length ? await Users.findByIds(adminIds) : [];
  const adminMap = Object.fromEntries(admins.map(u => [u._id, u.username]));
  const enriched = logs.map(l => ({ ...l, adminUsername: adminMap[l.adminId] || 'unknown' }));
  res.json(enriched);
}));

// ── POST /api/admin/broadcast ──────────────────────────────────
router.post('/broadcast', authMiddleware, limits.moderation(), adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message required' });

  const io = req.app.get('io');
  if (io) {
    io.emit('system_announcement', {
      message: message.trim(),
      from:    req.adminUser.displayName,
      ts:      Date.now(),
    });
  }
  await logAction(_u.id, 'broadcast', null, { message: message.trim() });
  res.json({ ok: true });
}));

// ── POST /api/admin/make-first-admin ───────────────────────────
router.post('/make-first-admin', asyncHandler(async (req, res) => {
  const { secret, username } = req.body;
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
}));

// ── GET /api/admin/captcha-stats ───────────────────────────────
router.get('/captcha-stats', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const captcha = require('../../lib/captcha');
  const stats = await captcha.getAdminStats();
  res.json(stats);
}));

// ── IP Ban endpoints ───────────────────────────────────────────
const { banIp, unbanIp, listBans, getClientIp } = require('../../middleware/ipBan');

router.get('/ip-bans', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const bans = await listBans();
  bans.sort((a, b) => b.bannedAt - a.bannedAt);
  res.json(bans);
}));

router.post('/ip-bans', authMiddleware, limits.moderation(), adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { ip, reason = 'Admin ban', durationMs = null } = req.body;

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
}));

router.delete('/ip-bans/:ip', authMiddleware, limits.moderation(), adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const ip = decodeURIComponent(req.params.ip).trim();
  if (!ip) return res.status(400).json({ error: 'ip zorunlu' });
  await unbanIp(ip);
  await logAction(_u.id, 'ip_unban', ip);
  res.json({ ok: true });
}));

// ── Karantina endpoints ────────────────────────────────────────
const { listQuarantinedFiles, deleteQuarantinedFile } = require('../../lib/contentScanner');

router.get('/quarantine', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
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
}));

router.delete('/quarantine/:filename', authMiddleware, adminOnly, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const filename = req.params.filename;
  if (!filename || filename.includes('/') || filename.includes('..')) {
    return res.status(400).json({ error: 'Geçersiz dosya adı' });
  }
  deleteQuarantinedFile(filename);
  await logAction(_u.id, 'quarantine_delete', filename);
  res.json({ ok: true });
}));

module.exports = { router, adminOnly, logAction };
export {};
