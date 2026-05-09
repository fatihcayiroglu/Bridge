// @ts-nocheck
// server/routes/health.js
// Docker HEALTHCHECK + sistem metrikleri

'use strict';

const express = require('express');
const router  = express.Router();
const loader  = require('../db/loader');
const { Users, Servers, Members, Channels, Messages, Invites } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');

const VERSION = require('../../package.json').version;
const DB_KIND = loader._pool ? 'postgresql' : 'sqlite';
async function pingDb() {
  if (loader._pool?.query) {
    await loader._pool.query('SELECT 1');
    return;
  }
  await Users.count({});
}

// ── GET /api/health — Docker HEALTHCHECK ───────────────────────
router.get('/', async (req, res) => {
  try {
    await pingDb();
    res.json({
      status:  'ok',
      version: VERSION,
      uptime:  Math.floor(process.uptime()),
      ts:      Date.now(),
      db:      DB_KIND,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// GET /api/health/live — process liveness probe
router.get('/live', (_req, res) => {
  res.json({
    status: 'ok',
    check: 'liveness',
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    ts: Date.now(),
  });
});

// GET /api/health/ready — dependency readiness probe
router.get('/ready', async (_req, res) => {
  try {
    await pingDb();
    res.json({
      status: 'ok',
      check: 'readiness',
      version: VERSION,
      db: DB_KIND,
      ts: Date.now(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', check: 'readiness', error: err.message });
  }
});

// ── GET /api/health/stats — detaylı metrikler ──────────────────
// Sadece localhost / iç ağ (production), development'ta herkese açık
router.get('/stats', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    const ip = req.ip || req.connection?.remoteAddress || '';
    const isInternal =
      ip === '127.0.0.1' || ip === '::1' ||
      ip.startsWith('172.') || ip.startsWith('10.');
    if (!isInternal) return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const mem = process.memoryUsage();
    let socketStats = {};
    try {
      const { getSocketStats } = require('../socket');
      socketStats = getSocketStats();
    } catch { /* socket modülü henüz init olmadıysa geç */ }

    const [userCount, serverCount, messageCount] = await Promise.all([
      Users.count({}),
      Servers.count({}),
      Messages.count({}),
    ]);

    res.json({
      status:  'ok',
      version: VERSION,
      uptime:  Math.floor(process.uptime()),
      db:      DB_KIND,
      memory: {
        rss:       Math.round(mem.rss       / 1024 / 1024) + ' MB',
        heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024) + ' MB',
        heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
      },
      socket: socketStats,
      counts: { users: userCount, servers: serverCount, messages: messageCount },
    });
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message });
  }
});

// ── GET /api/health/server/:sid — sunucu başına istatistikler ──
// Sunucu üyelerine açık; sahip daha detaylı veri alır
router.get('/server/:sid', authMiddleware, async (req, res) => {
  try {
    const { sid } = req.params;

    const server = await Servers.findById(sid);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const membership = await Members.findOne(req.user.id, sid);
    if (!membership) return res.status(403).json({ error: 'Not a member' });

    const isOwner = server.ownerId === req.user.id;

    const [memberCount, channelCount, messageCount] = await Promise.all([
      Members.countWhere({ serverId: sid }),
      Channels.count(sid),
      Messages.count({ serverId: sid }),
    ]);

    const now     = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentMessages = await Messages.findWhere({
      serverId:  sid,
      createdAt: { $gte: weekAgo },
    });

    // Günlük dağılım
    const dailyCounts = {};
    for (let d = 0; d < 7; d++) {
      const dayStart = new Date(now - d * 86400000);
      dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart.getTime() + 86400000);
      const dayIso = dayStart.toISOString().slice(0, 10);
      dailyCounts[dayIso] = recentMessages.filter(m =>
        m.createdAt >= dayStart.getTime() && m.createdAt < dayEnd.getTime()
      ).length;
    }

    // En aktif kanallar
    const channelActivity = {};
    for (const m of recentMessages) {
      channelActivity[m.channelId] = (channelActivity[m.channelId] || 0) + 1;
    }
    const channels = await Channels.findByServer(sid);
    const topChannels = Object.entries(channelActivity)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([cid, count]) => {
        const ch = channels.find(c => c._id === cid);
        return { channelId: cid, name: ch?.name || 'Unknown', messages: count };
      });

    const stats = {
      serverId:      sid,
      serverName:    server.name,
      serverIcon:    server.icon,
      createdAt:     server.createdAt,
      members:       memberCount,
      channels:      channelCount,
      totalMessages: messageCount,
      last7Days: {
        messages: recentMessages.length,
        daily:    dailyCounts,
      },
      topChannels,
    };

    // Sahip ek verileri görebilir
    if (isOwner) {
      const invites = await Invites.findByServer(sid);
      stats.invites = {
        total:     invites.length,
        active:    invites.filter(i => i.expiresAt > now).length,
        totalUses: invites.reduce((a, i) => a + (i.uses || 0), 0),
      };

      const userActivity = {};
      for (const m of recentMessages) {
        userActivity[m.userId] = (userActivity[m.userId] || 0) + 1;
      }
      const topUserIds = Object.entries(userActivity)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([uid]) => uid);
      const topUsers = await Users.findByIds(topUserIds);
      stats.topMembers = topUserIds.map(uid => {
        const u = topUsers.find(u => u._id === uid);
        return { userId: uid, username: u?.username || '?', displayName: u?.displayName || '?', messages: userActivity[uid] };
      });
    }

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/health/ice-config — ICE sunucu konfigürasyonu ─────
router.get('/ice-config', authMiddleware, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const turnUrl  = process.env.TURN_URL;
  const turnUser = process.env.TURN_USERNAME;
  const turnCred = process.env.TURN_CREDENTIAL;
  const turnTls  = process.env.TURN_URL_TLS;

  if (turnUrl && turnUser && turnCred) {
    iceServers.push({ urls: turnUrl,  username: turnUser, credential: turnCred });
    if (turnTls) {
      iceServers.push({ urls: turnTls, username: turnUser, credential: turnCred });
    }
  }

  res.json({ iceServers });
});

module.exports = router;
export {};
