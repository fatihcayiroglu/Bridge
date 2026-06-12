// server/socket/index.ts
// Session 8 Fix: applyAdapter eklendi — Redis clustering desteği
// Memory leak düzeltmeleri:
//   1. socketUsers Map — disconnect'te kesin temizleme
//   2. voiceRooms — boş odalar periyodik temizleme
//   3. memberships — closure referans sızdırması önlendi
//   4. typing indicators — timeout ile otomatik temizleme
//   5. Multi-tab desteği — aynı kullanıcı birden fazla bağlantı
// IP ban + IP-bazlı socket rate limiting entegrasyonu
// Sprint 104: IP rate limiting → socket/ipRateLimit.ts
//             Kullanıcı rate limiting → socket/socketRateLimit.ts
// Sprint 108: join/leave/membership mantığı → handlers/members.ts

import logger from '../lib/logger';

import { verifyToken, _invalidateTokenCache } from '../middleware/auth';
import { sanitizeUser } from '../lib/userUtils';
import { Users, Members, Channels, Notifications } from '../db/repositories';
import { getBan, getClientIp } from '../middleware/ipBan';

import { registerMessageHandlers, registerThreadSocketEvents } from './handlers/messages';
import { registerVoiceHandlers, leaveVoice, voiceRooms, voiceActivity } from './handlers/voice';
import { registerMusicHandlers } from './handlers/music';
import { registerDmHandlers, registerGroupDmHandlers } from './handlers/dm';
import { registerStageHandlers } from './handlers/stage';
import { registerVideoGridHandlers } from './handlers/stage-video-grid'; // Sprint 83
import { registerSFUHandlers, isSFUReady } from './handlers/mediasoup/index';
import { registerInfraHandlers, handleDisconnect } from './handlers/infra';
import { registerCanvasHandlers } from './handlers/canvas';
import { registerDmReadHandlers } from './handlers/dm-read';
import { registerDiscoverHandlers, pushMemberCount } from './handlers/discover';
import { trackSocket } from '../lib/presenceCache';
// Sprint 82: Yeni handler import'ları
import { registerActivityHandlers }      from './handlers/activities';
import { registerSuperReactionHandlers } from './handlers/super-reactions';
import { registerClipHandlers }          from './handlers/clips';
import { registerDrawTogetherHandlers }  from './handlers/activities/draw-together'; // Sprint 83
import { registerChannelE2EEHandlers }   from './handlers/channelE2EEHandlers';       // Sprint 89
// Sprint 108: membership mantığı ayrıştırıldı
import { setupMemberships }              from './handlers/members';
import type { SafeUser } from '../lib/userUtils';

// Sprint 104: Ayrıştırılmış rate limit modülleri
import { applyAdapter } from '../lib/redisAdapter';
import { ipRateCheck, IP_SOCKET_RL } from './ipRateLimit';
import { createRateLimitedSocket, _socketRateStore } from './socketRateLimit';
// Sprint 120: D5 — WS bağlantı limiti entegre edildi (wsConnectionLimitMiddleware)
import { wsConnectionLimitMiddleware } from './middleware/wsConnectionLimit';

const socketUsers = new Map<string, SafeUser>();

// ── IP ÇÖZÜMLEYICI (Socket.IO handshake'den) ───────────────────
function getSocketIp(socket: import('socket.io').Socket): string {
  const fakeReq = {
    ip: socket.handshake.address,
    headers: socket.handshake.headers,
    socket: { remoteAddress: socket.conn?.remoteAddress || socket.handshake.address },
  };
  return getClientIp(fakeReq);
}

// "channelId:userId" → timeout handle (typing indicator)
const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TYPING_TIMEOUT_MS = 5_000;

// Boş voice room temizleyici — her 10 dk
setInterval(() => {
  for (const [channelId, peers] of voiceRooms.entries()) {
    if (!peers || peers.length === 0) voiceRooms.delete(channelId);
  }
}, 10 * 60_000);

// socketUsers boyut izleyici
setInterval(() => {
  if (socketUsers.size > 10_000) {
    logger.warn(`[Socket] ⚠️ socketUsers Map boyutu yüksek: ${socketUsers.size}`);
  }
}, 5 * 60_000);

let _io: import('socket.io').Server | null = null;
function getIo(): import('socket.io').Server | null { return _io; }

function setupSocket(io: import('socket.io').Server): { voiceRooms: typeof voiceRooms } {
  _io = io;

  // ── Redis adapter — Socket.IO clustering (multi-instance) ───────
  applyAdapter(io).then(ok => {
    if (ok) logger.info({ event: 'socket.redis_adapter.applied' }, '[Socket] Redis adapter aktif — cluster modu.');
    else logger.warn({ event: 'socket.redis_adapter.skipped' }, '[Socket] Redis yok — tek instance modunda çalışılıyor. Yatay ölçekleme için REDIS_URL ekleyin.');
  }).catch(err => logger.error({ err, event: 'socket.redis_adapter.error' }, '[Socket] Redis adapter hatası.'));

  // ── MİDDLEWARE 0: WS bağlantı limiti (Sprint 120 / D5) ─────────
  // Tek IP'den aşırı WS bağlantısını engeller — DDoS/flood'a karşı
  io.use(wsConnectionLimitMiddleware(io));

  // ── MİDDLEWARE 1: IP Ban kontrolü (auth öncesi) ────────────────
  io.use(async (socket, next) => {
    const ip = getSocketIp(socket);
    try {
      const ban = await getBan(ip);
      if (ban) {
        const remaining = ban.expiresAt
          ? Math.max(0, Math.ceil((ban.expiresAt - Date.now()) / 1000))
          : null;
        logger.warn(`[Socket] Banlı IP bağlantı girişimi: ${ip} reason="${ban.reason}"`);
        const err = Object.assign(new Error('IP banned'), { data: { reason: ban.reason, expiresAt: ban.expiresAt, remainingSeconds: remaining } });
        return next(err);
      }
    } catch (e) {
      logger.error('[Socket] IP ban kontrolü hatası:', (e as Error).message);
    }
    socket._clientIp = ip;
    next();
  });

  // ── MİDDLEWARE 2: IP bağlantı rate limit (auth öncesi) ─────────
  io.use(async (socket, next) => {
    const ip = socket._clientIp || getSocketIp(socket);
    const allowed = await ipRateCheck(ip, 'connect');
    if (!allowed) {
      logger.warn(`[Socket] IP bağlantı rate limit aşıldı: ${ip}`);
      const err = Object.assign(new Error('Too many connections'), { data: { retryAfter: Math.ceil(IP_SOCKET_RL.connect.windowMs / 1000) } });
      return next(err);
    }
    next();
  });

  // ── MİDDLEWARE 3: JWT doğrulama ────────────────────────────────
  io.use(async (socket, next) => {
    const decoded = verifyToken(socket.handshake.auth.token);
    if (!decoded) return next(new Error('Unauthorized'));

    try {
      const user = await Users.findById(decoded.id);
      if (!user) return next(new Error('Unauthorized'));
      if ((decoded.v ?? 0) !== (user.tokenVersion || 0)) {
        return next(new Error('Token revoked'));
      }
    } catch {
      return next(new Error('Auth check failed'));
    }

    socket.userId   = decoded.id;
    socket.username = decoded.username;
    socket.tokenV   = decoded.v ?? 0;
    next();
  });

  io.on('connection', async (socket) => {
    let user;
    try {
      if (!socket.userId) return socket.disconnect(true);
      user = await Users.findById(socket.userId);
    } catch (err) {
      logger.error('[Socket] DB hatası:', (err as Error).message);
      return socket.disconnect(true);
    }
    if (!user) return socket.disconnect(true);

    const safeUser = sanitizeUser(user);
    const socketUser = {
      ...safeUser,
      _id: user._id,
      id: user._id,
      username: user.username,
      displayName: user.displayName ?? user.username,
      avatarColor: user.avatarColor ?? '#2d9cdb',
      avatarUrl: user.avatarUrl ?? '',
    };
    socketUsers.set(socket.id, socketUser);

    // Presence cache: socket'i kaydet, online işaretle ve cluster'a bildir
    await trackSocket(user._id, socket.id);
    // Sprint 120: wsConnectionLimitMiddleware için kullanıcı bazlı limit hook'unu tetikle
    socket.emit('userAuthenticated', user._id);
    try { await Users.update(user._id, { status: 'online' }); } catch {}

    // Sprint 108: membership mantığı handlers/members.ts'e taşındı
    const { memberships, refreshMemberships } = await setupMemberships(socket, user);

    // Personal room for GDM/DM notifications
    socket.join(`user:${user._id}`);
    socket.on('user:join-room', (uid) => { if (uid === user._id) socket.join(`user:${uid}`); });

    for (const m of memberships) {
      io.to(`server:${m.serverId}`).emit('user:status', { userId: user._id, status: 'online' });
    }

    // FEATURE HANDLERS — rate limiting inject edilmiş
    const rateLimitedSocket = createRateLimitedSocket(socket, user._id);

    registerMessageHandlers(rateLimitedSocket, io, socketUser, socketUsers);
    registerChannelE2EEHandlers(rateLimitedSocket, io, socketUser);   // Sprint 89
    registerVoiceHandlers(rateLimitedSocket, io, socketUser);
    registerMusicHandlers(rateLimitedSocket, io, socketUser);
    registerDmHandlers(rateLimitedSocket, io, socketUser, socketUsers);
    registerGroupDmHandlers(rateLimitedSocket, io, socketUser, socketUsers);
    registerThreadSocketEvents(rateLimitedSocket, io, socketUser);
    registerStageHandlers(rateLimitedSocket, io, socketUser);
    registerVideoGridHandlers(rateLimitedSocket, io, socketUser); // Sprint 83: video grid
    registerCanvasHandlers(rateLimitedSocket, io, socketUser);
    registerDmReadHandlers(rateLimitedSocket, io, socketUser);
    registerDiscoverHandlers(io, rateLimitedSocket);

    // Sprint 82: Activities, Super Reactions, Clips
    registerActivityHandlers(rateLimitedSocket, io, user._id);
    registerSuperReactionHandlers(rateLimitedSocket, io, user._id);
    registerClipHandlers(rateLimitedSocket, user._id);
    // Sprint 83: Draw Together
    registerDrawTogetherHandlers(rateLimitedSocket, io, {
      _id:         user._id,
      displayName: user.displayName ?? user.username,
      avatarColor: user.avatarColor ?? '#2d9cdb',
    });

    // SFU: Mediasoup kuruluysa SFU event'lerini kaydet
    if (isSFUReady()) {
      registerSFUHandlers(rateLimitedSocket, io, socketUser);
    }

    // ALTYAPI EVENT'LERİ — handlers/infra.ts
    registerInfraHandlers(rateLimitedSocket, socket, io, socketUser, {
      socketUsers, typingTimers, TYPING_TIMEOUT_MS,
      _socketRateStore, leaveVoice, voiceActivity,
      refreshMemberships, safeUser,
    });

    // Periodic token re-auth — JWT expire olsa bile açık kalan bağlantıları kapat
    const TOKEN_CHECK_INTERVAL = 5 * 60_000;
    const tokenCheckTimer = setInterval(async () => {
      try {
        const freshUser = await Users.findById(user._id);
        if (!freshUser) { clearInterval(tokenCheckTimer); return socket.disconnect(true); }
        if ((socket.tokenV ?? 0) !== (freshUser.tokenVersion || 0)) {
          clearInterval(tokenCheckTimer);
          socket.emit('auth:revoked', { reason: 'token_revoked' });
          socket.disconnect(true);
        }
      } catch { /* DB hatası — bağlantıyı kesme */ }
    }, TOKEN_CHECK_INTERVAL);

    // DISCONNECT
    socket.on('disconnect', async (reason) => {
      socket.removeAllListeners();
      await handleDisconnect(socket, socketUser, {
        socketUsers, typingTimers, _socketRateStore,
        leaveVoice, voiceActivity, tokenCheckTimer, io,
      });
      if (process.env.NODE_ENV !== 'production') {
        logger.debug({ userId: user._id, reason, remainingSockets: socketUsers.size, event: 'socket.disconnect' }, 'Socket disconnected.');
      }
    });
  });

  return { voiceRooms };
}

function getSocketStats() {
  return {
    connectedSockets: socketUsers.size,
    activeTyping:     typingTimers.size,
    voiceRooms:       Object.keys(voiceRooms).length,
    voicePeers:       Object.values(voiceRooms).reduce((a: number, p: unknown) => a + (Array.isArray(p) ? p.length : 0), 0),
  };
}

export { setupSocket, voiceRooms, getSocketStats, getIo, socketUsers, pushMemberCount };
