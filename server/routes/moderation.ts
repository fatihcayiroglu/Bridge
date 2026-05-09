// server/routes/moderation.js — Timeout, Audit Log, AutoMod
const express = require('express');
const router = express.Router({ mergeParams: true });
const { Auth, Users, Members, Servers, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// Helper: write audit log
async function writeAudit(serverId, actor, action, targetId, targetName, detail = '') {
  await Auth.insertAuditLog({
    serverId,
    actorId: actor._id || actor.id,
    actorName: actor.displayName || actor.username,
    action, targetId, targetName, detail,
  });
}

// GET /api/servers/:serverId/audit-log
// Query params: limit, offset, action, actorId, before, after, format (json|csv)
router.get('/audit-log', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const limit  = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? ''))  || 100));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '')) || 0);
  const format = (req.query.format || 'json').toLowerCase();

  // Filtre oluştur
  const query: Record<string,any> = { serverId };
  if (req.query.action)  query.action  = String(req.query.action ?? '');
  if (req.query.actorId) query.actorId = String(req.query.actorId ?? '');
  if (req.query.before || req.query.after) {
    query.createdAt = {};
    if (req.query.before) query.createdAt.$lt = new Date(String(req.query.before ?? '')).getTime();
    if (req.query.after)  query.createdAt.$gt = new Date(String(req.query.after ?? '')).getTime();
  }

  const all  = await Auth.findAuditLogsWhere(query);
  const page = all.slice(offset, offset + limit);

  if (format === 'csv') {
    // ── CSV Export ────────────────────────────────────────────
    const cols = ['createdAt', 'action', 'actorName', 'actorId', 'targetName', 'targetId', 'detail'];
    const escape = v => {
      if (v == null) return '';
      const s = String(v).replace(/"/g, '""');
      return /[",\n\r]/.test(s) ? `"${s}"` : s;
    };
    const rows = [cols.join(',')];
    for (const log of page) {
      rows.push(cols.map(c => {
        if (c === 'createdAt') return escape(new Date(log.createdAt).toISOString());
        return escape(log[c]);
      }).join(','));
    }
    const csv = rows.join('\r\n');
    const filename = `audit-log-${serverId}-${Date.now()}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send('\uFEFF' + csv); // BOM for Excel UTF-8
  }

  // ── JSON Response ─────────────────────────────────────────
  res.json({
    logs:    page,
    total:   all.length,
    offset,
    limit,
    hasMore: offset + limit < all.length,
  });
}));

// GET /api/servers/:serverId/audit-log/export
// Tüm log'ları (filtreli) indir — format=csv|json
router.get('/audit-log/export', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'Admin permission required for export' });
  }

  const format = (req.query.format || 'json').toLowerCase();
  const query: Record<string,any> = { serverId };
  if (req.query.action)  query.action  = String(req.query.action ?? '');
  if (req.query.actorId) query.actorId = String(req.query.actorId ?? '');

  const logs = await Auth.findAuditLogsWhere(query);
  const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  if (format === 'csv') {
    const cols   = ['createdAt', 'action', 'actorName', 'actorId', 'targetName', 'targetId', 'detail'];
    const escape = v => { if (v == null) return ''; const s = String(v).replace(/"/g, '""'); return /[",\n\r]/.test(s) ? `"${s}"` : s; };
    const rows   = [cols.join(',')];
    for (const log of logs) {
      rows.push(cols.map(c => c === 'createdAt' ? escape(new Date(log.createdAt).toISOString()) : escape(log[c])).join(','));
    }
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="audit-${serverId}-${ts}.csv"`);
    return res.send('\uFEFF' + rows.join('\r\n'));
  }

  // JSON export
  res.set('Content-Type', 'application/json');
  res.set('Content-Disposition', `attachment; filename="audit-${serverId}-${ts}.json"`);
  res.json({ serverId, exportedAt: new Date().toISOString(), total: logs.length, logs });
}));

// POST /api/servers/:serverId/timeout/:userId
router.post('/timeout/:userId', authMiddleware, limits.moderation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId, userId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });
  const { duration } = req.body; // seconds
  const allowedDurations = [60, 300, 3600, 86400, 604800];
  if (!allowedDurations.includes(parseInt(duration))) return res.status(400).json({ error: 'Invalid duration' });
  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const until = Date.now() + (parseInt(duration) * 1000);
  await Members.update(userId, serverId, { timeoutUntil: until });
  await writeAudit(serverId, req.user, 'TIMEOUT', userId, target.displayName, `${duration}s`);
  res.json({ ok: true, until });
}));

// DELETE /api/servers/:serverId/timeout/:userId — remove timeout
router.delete('/timeout/:userId', authMiddleware, limits.moderation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId, userId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });
  await Members.update(userId, serverId, { timeoutUntil: null });
  res.json({ ok: true });
}));

// GET /api/servers/:serverId/stats
router.get('/stats', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Not found' });
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.ADMIN) && server.ownerId !== _u.id)
    return res.status(403).json({ error: 'Owners only' });

  // PG-compatible: use collection count/find instead of raw SQL
  const last30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const last7  = Date.now() - 7  * 24 * 60 * 60 * 1000;

  const [totalMessages, totalMembers] = await Promise.all([
    Messages.count({ serverId }),
    Members.countWhere({ serverId }),
  ]);

  // Daily breakdown last 7 days — aggregate in JS (small window, safe)
  const recentMsgs = await Messages.findWhere({ serverId, createdAt: { $gt: last7 } });
  const dayBuckets = {};
  for (const m of recentMsgs) {
    const day = new Date(m.createdAt).toISOString().slice(0, 10);
    dayBuckets[day] = (dayBuckets[day] || 0) + 1;
  }
  const dailyRows = Object.entries(dayBuckets)
    .map(([day, cnt]) => ({ day, cnt }))
    .sort((a, b) => b.day.localeCompare(a.day))
    .slice(0, 7);

  // Top 5 active users last 30 days — aggregate in JS
  const msgs30 = await Messages.findWhere({ serverId, createdAt: { $gt: last30 } });
  const userCounts = {};
  for (const m of msgs30) {
    if (!userCounts[m.userId]) userCounts[m.userId] = { displayName: m.displayName, cnt: 0 };
    userCounts[m.userId].cnt++;
  }
  const topUsers = Object.values(userCounts)
    .sort((a: any, b: any) => b.cnt - a.cnt)
    .slice(0, 5);

  res.json({ totalMessages, totalMembers, dailyMessages: dailyRows, topUsers });
}));

module.exports = router;
module.exports.writeAudit = writeAudit;
export {};
