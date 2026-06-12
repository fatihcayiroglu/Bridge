// server/routes/health.ts
// Docker HEALTHCHECK + sistem metrikleri
 
import express, { Request, Response, Router } from 'express';
import { AuthedRequest, authMiddleware } from '../middleware/auth';

import loader from '../db/loader';
import { Users, Servers, Members, Channels, Messages, Invites } from '../db/repositories';

interface ServerRow { _id: string; name: string; icon?: string; ownerId: string; createdAt: number }
interface ChannelRow { _id: string; name: string }
interface MsgRow    { _id: string; channelId: string; userId: string; serverId?: string; createdAt: number }
interface InviteRow { _id: string; expiresAt: number; uses?: number }

import pkg from '../../package.json';
const VERSION: string = (pkg as { version: string }).version;
const DB_KIND = loader._pool ? 'postgresql' : 'sqlite';

async function pingDb(): Promise<void> {
  if (loader._pool?.query) { await loader._pool.query('SELECT 1'); return; }
  await Users.count({});
}

const router: Router = express.Router();


/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Genel sağlık kontrolü (DB ping dahil)
 *     security: []
 *     responses:
 *       200: { description: Sunucu ve DB sağlıklı }
 *       503: { description: DB erişilemiyor }
 * /health/live:
 *   get:
 *     tags: [Health]
 *     summary: Liveness probe (Kubernetes)
 *     security: []
 *     responses:
 *       200: { description: Süreç ayakta }
 * /health/ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness probe — DB ve Redis bağlantısı
 *     security: []
 *     responses:
 *       200: { description: Trafik alabilir }
 *       503: { description: DB erişilemiyor }
 * /health/stats:
 *   get:
 *     tags: [Health]
 *     summary: Sistem metrikleri (CPU, memory, uptime)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Metrik objesi }
 * /health/server/{sid}:
 *   get:
 *     tags: [Health]
 *     summary: Belirli bir sunucunun sağlık durumu
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Sunucu metrikleri }
 *       404: { $ref: '#/components/responses/NotFound' }
 * /health/ice-config:
 *   get:
 *     tags: [Health]
 *     summary: WebRTC ICE yapılandırması
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: STUN/TURN listesi }
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    await pingDb();
    res.json({ status: 'ok', version: VERSION, uptime: Math.floor(process.uptime()), ts: Date.now(), db: DB_KIND });
  } catch {
    res.status(503).json({ status: 'error', version: VERSION, uptime: Math.floor(process.uptime()), ts: Date.now(), db: DB_KIND });
  }
});

router.get('/live', (_req: Request, res: Response) => {
  res.json({ status: 'ok', check: 'liveness', version: VERSION, uptime: Math.floor(process.uptime()), ts: Date.now() });
});

router.get('/ready', async (_req: Request, res: Response) => {
  try {
    await pingDb();
    res.json({ status: 'ok', check: 'readiness', version: VERSION, db: DB_KIND, ts: Date.now() });
  } catch {
    res.status(503).json({ status: 'error', check: 'readiness', version: VERSION, db: DB_KIND, ts: Date.now() });
  }
});

router.get('/stats', async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === 'production') {
    const ip = req.ip || '';
    const isInternal = ip === '127.0.0.1' || ip === '::1' || ip.startsWith('172.') || ip.startsWith('10.');
    if (!isInternal) return void res.status(403).json({ error: 'Forbidden' });
  }
  const mem = process.memoryUsage();
  let socketStats: Record<string, unknown> = {};
  try {
    const socketMod = await import('../socket') as { getSocketStats?(): Record<string, unknown> };
    socketStats = socketMod.getSocketStats?.() ?? {};
  } catch { /* ignore */ }
  const [userCount, serverCount, messageCount] = await Promise.all([Users.count({}), Servers.count({}), Messages.count({})]);
  res.json({
    status: 'ok', version: VERSION, uptime: Math.floor(process.uptime()), db: DB_KIND,
    memory: {
      rss:       Math.round(mem.rss       / 1024 / 1024) + ' MB',
      heapUsed:  Math.round(mem.heapUsed  / 1024 / 1024) + ' MB',
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + ' MB',
    },
    socket: socketStats, counts: { users: userCount, servers: serverCount, messages: messageCount },
  });
});

router.get('/server/:sid', authMiddleware, async (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  try {
    const sid = String(req.params.sid ?? '');
    const server = await Servers.findById(sid);
    if (!server) return void res.status(404).json({ error: 'Server not found' });
    const membership = await Members.findOne(authed.user.id, sid);
    if (!membership) return void res.status(403).json({ error: 'Not a member' });
    const isOwner = server.ownerId === authed.user.id;
    const [memberCount, channelCount, messageCount] = await Promise.all([
      Members.countWhere({ serverId: sid }), Channels.count(sid), Messages.count({ serverId: sid }),
    ]);
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const recentMessages = await Messages.findWhere({ serverId: sid, createdAt: { $gte: weekAgo } });
    const dailyCounts: Record<string, number> = {};
    for (let d = 0; d < 7; d++) {
      const dayStart = new Date(now - d * 86400000); dayStart.setHours(0, 0, 0, 0);
      const dayEnd   = new Date(dayStart.getTime() + 86400000);
      dailyCounts[dayStart.toISOString().slice(0, 10)] = recentMessages.filter(
        m => m.createdAt >= dayStart.getTime() && m.createdAt < dayEnd.getTime()
      ).length;
    }
    const channelActivity: Record<string, number> = {};
    for (const m of recentMessages) channelActivity[m.channelId] = (channelActivity[m.channelId] || 0) + 1;
    const channels = await Channels.findByServer(sid);
    const topChannels = Object.entries(channelActivity).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([cid, count]) => ({ channelId: cid, name: channels.find(c => c._id === cid)?.name || 'Unknown', messages: count }));

     
    const stats: Record<string, unknown> = {
      serverId: sid, serverName: server.name, serverIcon: server.icon, createdAt: server.createdAt,
      members: memberCount, channels: channelCount, totalMessages: messageCount,
      last7Days: { messages: recentMessages.length, daily: dailyCounts }, topChannels,
    };
    if (isOwner) {
      const invites = await Invites.findByServer(sid);
      stats['invites'] = { total: invites.length, active: invites.filter(i => i.expiresAt > now).length, totalUses: invites.reduce((a, i) => a + (i.uses || 0), 0) };
      const userActivity: Record<string, number> = {};
      for (const m of recentMessages) userActivity[m.userId] = (userActivity[m.userId] || 0) + 1;
      const topUserIds = Object.entries(userActivity).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([uid]) => uid);
      const topUsers   = await Users.findByIds(topUserIds);
      stats['topMembers'] = topUserIds.map(uid => {
        const u = topUsers.find(u => u._id === uid);
        return { userId: uid, username: u?.username || '?', displayName: u?.displayName || '?', messages: userActivity[uid] };
      });
    }
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /health/mediasoup — SFU worker durumu (Uptime Kuma probe) ────────────
router.get('/mediasoup', async (_req: Request, res: Response) => {
  try {
    const sfu = await import('../socket/handlers/mediasoup/workers') as {
      getWorkerStats?(): Promise<{ workers: number; healthy: number }>;
    };
    if (sfu.getWorkerStats) {
      const stats = await sfu.getWorkerStats();
      const ok = stats.healthy > 0;
      return void res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', workers: stats });
    }
  } catch { /* mediasoup kurulu değilse */ }
  // Mediasoup opsiyonel — kurulu değilse 200 döndür (self-host'ta ses/video isteğe bağlı)
  res.json({ status: 'ok', workers: null, note: 'mediasoup not configured' });
});

function _handleIceConfig(_req: Request, res: Response): void {
  const iceServers: object[] = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL, TURN_URL_TLS } = process.env;
  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    iceServers.push({ urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
    if (TURN_URL_TLS) iceServers.push({ urls: TURN_URL_TLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  // Sprint 120: I7 — FORCE_TURN desteği: tüm WebRTC trafiğini TURN üzerinden zorlar (IP sızıntısını engeller)
  // FORCE_TURN=true → istemci iceTransportPolicy='relay' kullanır, doğrudan P2P bağlantı yapılmaz
  const iceTransportPolicy = process.env.FORCE_TURN === 'true' ? 'relay' : 'all';
  if (process.env.FORCE_TURN === 'true' && (!TURN_URL || !TURN_USERNAME || !TURN_CREDENTIAL)) {
    // TURN sunucu yapılandırılmamışsa FORCE_TURN'u sessizce devre dışı bırak ve uyar
    // Aksi halde tüm ses/video bağlantıları kesilir
    res.json({ iceServers, iceTransportPolicy: 'all', warning: 'FORCE_TURN=true ama TURN sunucu yapılandırılmamış; relay modu devre dışı bırakıldı' });
    return;
  }
  res.json({ iceServers, iceTransportPolicy });
}

// Sprint 120: /api/rtc/ice-config için tekil import edilebilir handler array
// setupRoutes.ts bu handler'ı /api/rtc altında da kullanır (yalnızca ice-config açılır)
export const iceConfigHandler = [authMiddleware as import('express').RequestHandler, _handleIceConfig];

router.get('/ice-config', ...iceConfigHandler);

export default router;

// Sprint 115: Swagger UI endpoint (docs/api/openapi.yaml'ı serer)
// GET /api/docs — Swagger UI
// GET /api/docs/openapi.yaml — raw spec
