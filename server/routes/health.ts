// server/routes/health.ts
// Docker HEALTHCHECK + sistem metrikleri
 
import express, { Request, Response, Router } from 'express';
import { AuthedRequest, authMiddleware } from '../middleware/auth';
import { databaseAdminOnly } from '../lib/adminAuthority';

import loader from '../db/loader';
import { Users, Servers, Members, Channels, Messages, Invites } from '../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { getPrivateStorageAdapter, getPrivateStorageProvider, getStorageAdapter, getProvider } from '../lib/storageAdapter';
import { getRtcIceConfig, getTurnStatus } from '../lib/turnConfig';
import { healthCheck as redisHealthCheck } from '../lib/redisAdapter';
import logger from '../lib/logger';


import pkg from '../../package.json';
const VERSION: string = (pkg as { version: string }).version;
const DB_KIND = 'postgresql' as const;

async function pingDb(): Promise<void> {
  if (loader._pool?.query) { await loader._pool.query('SELECT 1'); return; }
  await Users.count({});
}

async function pingStorage(): Promise<void> {
  // Public assets and protected attachments can use different providers. A
  // configured provider is part of the node's traffic-serving contract, so a
  // broken bucket/volume must remove the node from rotation. Deduplicate the
  // common local adapter used by both roles.
  const adapters = [getStorageAdapter(), getPrivateStorageAdapter()];
  const seen = new Set<typeof adapters[number]>();
  for (const adapter of adapters) {
    if (seen.has(adapter)) continue;
    seen.add(adapter);
    if (!await adapter.healthCheck()) throw new Error('Configured storage is unavailable');
  }
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

// The public 503 body stays generic; the operator learns WHICH dependency
// removed the node from rotation from one structured log line per state
// change (not per probe — orchestrators probe every few seconds).
let readinessFailure: string | null = null;

router.get('/ready', async (_req: Request, res: Response) => {
  let dependency = 'database';
  try {
    await pingDb();
    // Redis is optional for a deliberately single-node deployment, but once
    // REDIS_URL is configured it becomes authoritative for cluster-sensitive
    // state (rate limits, voice/stage locks, SFU ownership, etc.). Advertising
    // readiness while that configured dependency is unavailable sends traffic
    // to a node that cannot uphold those invariants.
    if (process.env.REDIS_URL) {
      dependency = 'redis';
      const redis = await redisHealthCheck();
      if (!redis.redis) throw new Error(redis.error || 'Configured Redis is unavailable');
    }
    dependency = 'storage';
    await pingStorage();
    // Optional media infrastructure becomes part of node readiness only when
    // the operator explicitly declares it required. This keeps deliberately
    // P2P/STUN-only self-hosted nodes valid while making production media
    // commitments fail closed instead of advertising a false green state.
    dependency = 'turn';
    if (process.env.REQUIRE_TURN === 'true' && !getTurnStatus().turn) {
      throw new Error('Required TURN relay is unavailable');
    }
    dependency = 'sfu';
    if (process.env.REQUIRE_SFU === 'true') {
      const sfu = await import('../socket/handlers/mediasoup/workers') as {
        getWorkerStats?(): Promise<{ workers: number; healthy: number }>;
      };
      const stats = sfu.getWorkerStats ? await sfu.getWorkerStats() : { workers: 0, healthy: 0 };
      if (stats.healthy < 1) throw new Error('Required SFU is unavailable');
    }
    if (readinessFailure !== null) {
      logger.info({ event: 'health.readiness_recovered', previous: readinessFailure }, '[Health] Node is ready again');
      readinessFailure = null;
    }
    res.json({ status: 'ok', check: 'readiness', version: VERSION, db: DB_KIND, ts: Date.now() });
  } catch (err) {
    if (readinessFailure !== dependency) {
      logger.warn(
        { event: 'health.readiness_failed', dependency, reason: err instanceof Error ? err.message.slice(0, 200) : 'unknown' },
        '[Health] Node is NOT ready; removed from load-balancer rotation',
      );
      readinessFailure = dependency;
    }
    res.status(503).json({ status: 'error', check: 'readiness', version: VERSION, db: DB_KIND, ts: Date.now() });
  }
});

router.get('/stats', authMiddleware, databaseAdminOnly, async (_req: Request, res: Response) => {
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

type ServiceState = 'operational' | 'degraded' | 'unavailable';
type ServiceHealth = { key: string; label: string; status: ServiceState; detail: string };

// Compact, non-surveillance operational health for authorized server admins.
// No process memory, hostnames, credentials, ICE entries or raw errors leave
// this endpoint.
router.get('/server/:sid/services', authMiddleware, async (req: Request, res: Response) => {
  const authed = req as AuthedRequest;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid);
  if (!server) return void res.status(404).json({ error: 'Server not found' });
  const membership = await Members.findOne(authed.user.id, sid);
  if (!membership) return void res.status(403).json({ error: 'Not a member' });

  const perms = await resolvePermissions(authed.user.id, sid);
  const authorized = server.ownerId === authed.user.id
    || hasPermission(perms, PERMS.MANAGE_SERVER)
    || hasPermission(perms, PERMS.ADMINISTRATOR);
  if (!authorized) return void res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const services: ServiceHealth[] = [];

  try {
    await pingDb();
    services.push({ key: 'database', label: 'Veri hizmeti', status: 'operational', detail: 'Sunucu verileri erişilebilir.' });
  } catch {
    services.push({ key: 'database', label: 'Veri hizmeti', status: 'unavailable', detail: 'Veri hizmeti şu anda yanıt vermiyor.' });
  }

  try {
    const ok = await getStorageAdapter().healthCheck();
    services.push({
      key: 'uploads', label: 'Dosya yükleme', status: ok ? 'operational' : 'unavailable',
      detail: ok ? `${getProvider()} depolama sağlayıcısı erişilebilir.` : 'Depolama sağlayıcısı sağlık kontrolünü geçemedi.',
    });
  } catch {
    services.push({ key: 'uploads', label: 'Dosya yükleme', status: 'unavailable', detail: 'Depolama sağlayıcısına erişilemiyor.' });
  }


  try {
    const ok = await getPrivateStorageAdapter().healthCheck();
    services.push({
      key: 'protected_uploads', label: 'Özel dosya yükleme', status: ok ? 'operational' : 'unavailable',
      detail: ok
        ? `${getPrivateStorageProvider()} private depolama sağlayıcısı erişilebilir.`
        : 'Private depolama sağlayıcısı sağlık kontrolünü geçemedi.',
    });
  } catch {
    services.push({ key: 'protected_uploads', label: 'Özel dosya yükleme', status: 'unavailable', detail: 'Private depolama sağlayıcısına erişilemiyor.' });
  }

  try {
    const socketMod = await import('../socket') as { getSocketStats?(): { connectedSockets?: number } };
    const stats = socketMod.getSocketStats?.();
    services.push({
      key: 'realtime', label: 'Gerçek zamanlı bağlantı', status: stats ? 'operational' : 'unavailable',
      detail: stats ? `Socket hizmeti yanıt veriyor · ${Number(stats.connectedSockets ?? 0)} etkin bağlantı.` : 'Socket sağlık bilgisi alınamadı.',
    });
  } catch {
    services.push({ key: 'realtime', label: 'Gerçek zamanlı bağlantı', status: 'unavailable', detail: 'Socket hizmeti sağlık bilgisi alınamadı.' });
  }

  try {
    const sfuMod = await import('../socket/handlers/mediasoup') as { isSFUReady?(): boolean };
    const sfuReady = sfuMod.isSFUReady?.() === true;
    const turn = getTurnStatus();
    const status: ServiceState = (sfuReady || turn.turn) ? 'operational' : 'degraded';
    services.push({
      key: 'voice', label: 'Ses ve ekran paylaşımı', status,
      detail: sfuReady
        ? 'SFU ses/video hizmeti hazır.'
        : turn.turn
          ? 'TURN relay hazır; SFU isteğe bağlı veya bu node üzerinde etkin değil.'
          : 'Temel STUN hazır; TURN relay yapılandırılmadığı için bazı ağlarda bağlantı kurulamayabilir.',
    });
  } catch {
    services.push({ key: 'voice', label: 'Ses ve ekran paylaşımı', status: 'degraded', detail: 'Temel ses bağlantısı kullanılabilir; gelişmiş servis durumu alınamadı.' });
  }

  const overall: ServiceState = services.some(s => s.status === 'unavailable')
    ? 'unavailable'
    : services.some(s => s.status === 'degraded') ? 'degraded' : 'operational';
  res.json({ serverId: sid, checkedAt: Date.now(), overall, services });
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
  } catch {
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

function _handleIceConfig(req: Request, res: Response): void {
  // One authority for every RTC path. This includes self-hosted coturn
  // TURN_SECRET/TURN_HOST HMAC credentials, static providers and force-relay
  // fallback semantics. Do not duplicate TURN env parsing in routes.
  const authed = req as AuthedRequest;
  const userId = String(authed.user?._id ?? authed.user?.id ?? 'anonymous');
  res.json(getRtcIceConfig(userId));
}

// Sprint 120: /api/rtc/ice-config için tekil import edilebilir handler array
// setupRoutes.ts bu handler'ı /api/rtc altında da kullanır (yalnızca ice-config açılır)
export const iceConfigHandler = [authMiddleware as import('express').RequestHandler, _handleIceConfig];

router.get('/ice-config', ...iceConfigHandler);

export default router;

// Sprint 115: Swagger UI endpoint (docs/api/openapi.yaml'ı serer)
// GET /api/docs — Swagger UI
// GET /api/docs/openapi.yaml — raw spec
