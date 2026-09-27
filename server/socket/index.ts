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

import { verifyToken, verifiedTokenSubject, _invalidateTokenCache } from '../middleware/auth';
import { sanitizeUser, normalizePresenceVisibility, normalizePresenceStatus } from '../lib/userUtils';
import { Members, Users } from '../db/repositories';
import { resolveBotToken } from '../middleware/botAuth';
import { getBan, getClientIp } from '../middleware/ipBan';

import { registerMessageHandlers, registerThreadSocketEvents } from './handlers/messages';
import { registerVoiceHandlers, leaveVoice, voiceRooms, voiceActivity, getVoiceRoomCount } from './handlers/voice';
import { registerMusicHandlers } from './handlers/music';
import { registerDmHandlers, registerGroupDmHandlers } from './handlers/dm';
import { bindStageMediaClusterControl, registerStageHandlers } from './handlers/stage';
import { registerVideoGridHandlers } from './handlers/stage-video-grid'; // Sprint 83
import { registerSFUHandlers, isSFUReady } from './handlers/mediasoup/index';
import { registerInfraHandlers, handleDisconnect } from './handlers/infra';
import { registerCanvasHandlers } from './handlers/canvas';
import { registerDmReadHandlers } from './handlers/dm-read';
import { registerDiscoverHandlers, pushMemberCount } from './handlers/discover';
import { trackSocket, markOffline, getMembershipsCached, startPresenceReaper } from '../lib/presenceCache';
import { bindVoiceEvictionClusterControl, registerLocalVoiceEvictor } from '../lib/liveMembership';
import { evictLocalVoiceSessions } from './voiceEviction';
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
import { ipRateCheckFor, IP_SOCKET_RL } from './ipRateLimit';
import { createRateLimitedSocket, _socketRateStore } from './socketRateLimit';
// Sprint 120: D5 — WS bağlantı limiti entegre edildi (wsConnectionLimitMiddleware)
import { wsConnectionLimitMiddleware } from './middleware/wsConnectionLimit';
import { parseTokenVersion } from '../lib/tokenVersion';
import { bindPluginSocketEvents } from '../plugins/loader';

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
}, 10 * 60_000).unref?.();

// socketUsers boyut izleyici
setInterval(() => {
  if (socketUsers.size > 10_000) {
    logger.warn(`[Socket] ⚠️ socketUsers Map boyutu yüksek: ${socketUsers.size}`);
  }
}, 5 * 60_000).unref?.();

let _io: import('socket.io').Server | null = null;
function getIo(): import('socket.io').Server | null { return _io; }

async function releaseConnectionLimitReservation(socket: import('socket.io').Socket): Promise<void> {
  try {
    await (socket as typeof socket & { _bridgeReleaseConnectionLimit?: () => void | Promise<void> })
      ._bridgeReleaseConnectionLimit?.();
  } catch (err) {
    logger.warn({ err, event: 'socket.connection_limit.release_failed' },
      '[Socket] Bağlantı limiti rezervasyonu temizlenemedi.');
  }
}

function setupSocket(io: import('socket.io').Server): { voiceRooms: typeof voiceRooms } {
  _io = io;
  bindStageMediaClusterControl(io);
  registerLocalVoiceEvictor(evictLocalVoiceSessions);
  bindVoiceEvictionClusterControl(io);
  // Users whose only remaining sockets belonged to a dead node: the same
  // offline transition a last-socket disconnect performs (handleDisconnect).
  startPresenceReaper(async (userId) => {
    await Users.update(userId, { status: 'offline' });
    const memberships = await getMembershipsCached(userId, () => Members.findByUser(userId).catch(() => []));
    for (const m of memberships) io.to(`server:${m.serverId}`).emit('user:status', { userId, status: 'offline' });
  });

  // ── MİDDLEWARE 0: WS bağlantı limiti (Sprint 120 / D5) ─────────
  // Tek IP'den aşırı WS bağlantısını engeller — DDoS/flood'a karşı
  io.use(wsConnectionLimitMiddleware(io));

  // ── MİDDLEWARE 1: IP Ban kontrolü (auth öncesi) ────────────────
  io.use(async (socket, next) => {
    const ip = getSocketIp(socket);
    socket._clientIp = ip;
    try {
      const ban = await getBan(ip);
      if (ban) {
        const remaining = ban.expiresAt
          ? Math.max(0, Math.ceil((ban.expiresAt - Date.now()) / 1000))
          : null;
        logger.warn(`[Socket] Banlı IP bağlantı girişimi: ${ip} reason="${ban.reason}"`);
        const err = Object.assign(new Error('IP banned'), { data: { reason: ban.reason, expiresAt: ban.expiresAt, remainingSeconds: remaining } });
        await releaseConnectionLimitReservation(socket);
        return next(err);
      }
    } catch (e) {
      logger.error('[Socket] IP ban kontrolü hatası:', (e as Error).message);
      const err = Object.assign(new Error('IP access control unavailable'), { data: { retryable: true } });
      await releaseConnectionLimitReservation(socket);
      return next(err);
    }
    next();
  });

  // ── MİDDLEWARE 2: IP bağlantı rate limit (auth öncesi) ─────────
  io.use(async (socket, next) => {
    const ip = socket._clientIp || getSocketIp(socket);
    // Kimlik YALNIZCA imzası doğrulanan jetondan gelir (sayaç anahtarı; yetki kararı değil).
    // Aynı NAT arkasındaki kişiler artık birbirinin bağlantı kotasını tüketmez (Faz 19).
    const allowed = await ipRateCheckFor(ip, 'connect', verifiedTokenSubject(socket.handshake.auth?.token));
    if (!allowed) {
      logger.warn(`[Socket] IP bağlantı rate limit aşıldı: ${ip}`);
      const err = Object.assign(new Error('Too many connections'), { data: { retryAfter: Math.ceil(IP_SOCKET_RL.connect.windowMs / 1000) } });
      await releaseConnectionLimitReservation(socket);
      return next(err);
    }
    next();
  });

  // ── MİDDLEWARE 3: user JWT OR canonical bot-token auth ───────────
  io.use(async (socket, next) => {
    // Dedicated SFU signaling sockets may ask the load balancer for a specific
    // room-owner node. Do not silently accept an LB/configuration mismatch: a
    // socket that reached the wrong node would otherwise enter a redirect loop.
    const requestedNodeRaw = socket.handshake.query?.bridgeNode;
    const requestedNode = Array.isArray(requestedNodeRaw) ? requestedNodeRaw[0] : requestedNodeRaw;
    if (typeof requestedNode === 'string' && requestedNode.length > 0) {
      const localNode = process.env.INSTANCE_ID || `node-${process.pid}`;
      if (requestedNode !== localNode) {
        logger.error({ requestedNode, localNode, event: 'socket.sfu_route_mismatch' },
          '[Socket] SFU targeted socket yanlış node\'a yönlendirildi.');
        await releaseConnectionLimitReservation(socket);
        return next(new Error('SFU route mismatch'));
      }
    }

    const rawToken = socket.handshake.auth.token;
    if (typeof rawToken === 'string' && rawToken.startsWith('brg_bot_')) {
      try {
        const bot = await resolveBotToken(rawToken);
        if (!bot) {
          await releaseConnectionLimitReservation(socket);
          return next(new Error('Unauthorized'));
        }
        socket.isBot = true;
        socket.botId = bot._id;
        socket.botServerId = bot.serverId;
        socket.username = bot.username;
        const mark = (socket as typeof socket & { _bridgeMarkAuthenticated?: (userId: string) => boolean | Promise<boolean> })
          ._bridgeMarkAuthenticated;
        if (mark && !(await mark(`bot:${bot._id}`))) {
          await releaseConnectionLimitReservation(socket);
          return next(new Error('TOO_MANY_CONNECTIONS_FROM_USER'));
        }
        return next();
      } catch {
        await releaseConnectionLimitReservation(socket);
        return next(new Error('Auth check failed'));
      }
    }

    const decoded = verifyToken(rawToken);
    if (!decoded) {
      await releaseConnectionLimitReservation(socket);
      return next(new Error('Unauthorized'));
    }

    try {
      const user = await Users.findById(decoded.id);
      if (!user) {
        await releaseConnectionLimitReservation(socket);
        return next(new Error('Unauthorized'));
      }
      if ((decoded.v ?? 0) !== parseTokenVersion(user.tokenVersion)) {
        await releaseConnectionLimitReservation(socket);
        return next(new Error('Token revoked'));
      }
    } catch {
      await releaseConnectionLimitReservation(socket);
      return next(new Error('Auth check failed'));
    }

    socket.userId   = decoded.id;
    socket.username = decoded.username;
    socket.tokenV   = decoded.v ?? 0;
    socket.tokenExp = decoded.exp;
    // Connection-limit user accounting is a server-internal transition.
    // Never accept a client-originated `userAuthenticated` event as identity.
    try {
      const mark = (socket as typeof socket & { _bridgeMarkAuthenticated?: (userId: string) => boolean | Promise<boolean> })
        ._bridgeMarkAuthenticated;
      if (mark && !(await mark(decoded.id))) {
        await releaseConnectionLimitReservation(socket);
        return next(new Error('TOO_MANY_CONNECTIONS_FROM_USER'));
      }
    } catch (err) {
      logger.warn({ err, userId: decoded.id, event: 'socket.connection_limit.user_rejected' },
        '[Socket] Kullanıcı bağlantı kotası reddetti.');
      await releaseConnectionLimitReservation(socket);
      return next(new Error((err as Error)?.message || 'Too many user connections'));
    }
    next();
  });

  io.on('connection', async (socket) => {
    // Bot sockets are deliberately command/interaction-scoped. They join only
    // their private bot room; they are NOT subscribed to every server/channel
    // room, which would leak private-channel traffic to server-wide bots.
    if (socket.isBot && socket.botId && socket.botServerId) {
      socket.join(`bot:${socket.botId}`);
      socket.emit('botAuthenticated', { botId: socket.botId, serverId: socket.botServerId });
      return;
    }

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

    // ════════════════════════════════════════════════════════════════════════
    // KISISEL ODA, HAZIR SINYALINDEN ONCE
    // ════════════════════════════════════════════════════════════════════════
    // KAPATILAN GERCEK KUSUR: `user:<id>` odasina katilma, asagida
    // `userAuthenticated` yayildiktan VE iki `await`ten (durum guncelleme,
    // uyelik kurulumu — ikisi de DB'ye gider) SONRA yapiliyordu.
    //
    // `userAuthenticated` istemci icin "artik hazirsin" anlamina gelir; bu
    // sirayla sinyal, soket HENUZ HICBIR DM/arama/gelen-kutusu olayini
    // ALAMAZKEN gonderiliyordu. Pencere gercek: uyelik kurulumu DB okumasi
    // yapar ve yuk altinda genisler.
    //
    // Olcum (iki ornek, ayni Redis): B'den yayilan `dm:call:incoming`,
    // A'daki istemci `userAuthenticated` aldiktan hemen sonra arama
    // baslattiginda KAYBOLUYORDU — A'daki soket odaya daha katilmamisti.
    // Ayni pencere tek ornekte de gecerlidir: yeniden baglanan bir istemci
    // bu araliktaki DM'leri ve gelen aramalari sessizce kacirir.
    //
    // Sira artik: odaya katil → HAZIR sinyalini yay. Sinyalin anlami boylece
    // dogrudur.
    socket.join(`user:${user._id}`);
    socket.on('user:join-room', (uid) => { if (uid === user._id) socket.join(`user:${uid}`); });

    // Presence cache: kalıcı görünürlük tercihi ilk broadcast'ten ÖNCE
    // uygulanır. Gizli kullanıcı bağlantı kursa bile kısa süreli "online"
    // sızıntısı üretmez.
    // Kanonik degere gore karar verilir; ham dizge karsilastirmasi
    // `'Hidden'` gibi alan disi bir degerde varligi SIZDIRIRDI.
    const presenceVisible = normalizePresenceVisibility(user.presenceVisibility) === 'visible';
    try {
      await trackSocket(user._id, socket.id, presenceVisible);
    } catch (err) {
      socketUsers.delete(socket.id);
      logger.error({ err, userId: user._id, event: 'socket.presence_registration_failed' },
        'Authoritative presence registration failed; disconnecting fail-closed.');
      return socket.disconnect(true);
    }
    const preferredStatus = normalizePresenceStatus((user as unknown as { presenceStatus?: unknown }).presenceStatus);
    const connectedStatus = presenceVisible ? preferredStatus : 'offline';
    // `presenceStatus` is the durable user preference. `status` is only the
    // effective live state and may be forced offline by privacy/disconnect.
    try { await Users.update(user._id, { status: connectedStatus }); } catch {}
    if (connectedStatus === 'offline') {
      try { await markOffline(user._id); } catch (err) {
        logger.warn({ err, userId: user._id, event: 'socket.presence_manual_offline_failed' },
          'Manual offline preference could not be reflected in presence cache.');
      }
    }

    // Sprint 108: membership mantığı handlers/members.ts'e taşındı
    const { memberships, refreshMemberships } = await setupMemberships(socket, user);

    // ════════════════════════════════════════════════════════════════════════
    // TEK YAYIN, ÇOK ODA (Final21 Faz 16)
    // ════════════════════════════════════════════════════════════════════════
    // Döngü her sunucu odasına AYRI bir yayın yapıyordu. Kullanıcılar sunucu
    // paylaşır; ortak N sunucusu olan bir alıcı AYNI `user:status` olayını
    // N KEZ alıyordu. Ölçüldü (`p16-perm-revocation-probe` tanılama günlüğü):
    // tek bir bağlantıda alıcıya 8 kopya ulaştı.
    //
    // Socket.IO oda LİSTESİYLE yayın yapıldığında alıcıyı TEKİLLEŞTİRİR: aynı
    // bilgi tek kopya gider. Kapsam birebir aynı — aynı odalar, aynı olay.
    const membershipRooms = [...new Set(memberships.map(m => `server:${m.serverId}`))];
    if (membershipRooms.length) {
      io.to(membershipRooms).emit('user:status', { userId: user._id, status: connectedStatus });
    }

    // FEATURE HANDLERS — rate limiting inject edilmiş
    const rateLimitedSocket = createRateLimitedSocket(socket, user._id);

    registerMessageHandlers(rateLimitedSocket, io, socketUser, socketUsers);
    registerChannelE2EEHandlers(rateLimitedSocket, io, socketUser);   // Sprint 89
    registerVoiceHandlers(rateLimitedSocket, io, socketUser, { sfuReady: isSFUReady() });
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

    // Plugin socket API is a real production surface, but it is intentionally
    // bound through the same global rate-limited socket as first-party events.
    // The loader only exposes plugin-owned namespaced events and passes a
    // minimal emit-only facade to plugin code, never the server-side Socket.
    bindPluginSocketEvents(rateLimitedSocket, {
      id: String(user._id),
      username: user.username,
      displayName: user.displayName ?? user.username,
    });

    // ════════════════════════════════════════════════════════════════════════
    // HAZIR SINYALI — TUM DINLEYICILER KAYITLI OLDUKTAN SONRA
    // ════════════════════════════════════════════════════════════════════════
    // KAPATILAN GERCEK KUSUR: `userAuthenticated` yukarida, `trackSocket`in
    // hemen ardindan yayiliyordu — yani ozellik dinleyicileri (`dm:*`,
    // `message:*`, `voice:*` …) HENUZ KAYITLI DEGILKEN. Arada iki `await`
    // vardi (`Users.update`, `setupMemberships`; ikisi de DB'ye gider).
    //
    // Socket.IO, dinleyicisi olmayan bir olayi SESSIZCE ATAR: hata yok, log
    // yok, istemciye geri bildirim yok. Istemci "hazirsin" sinyalini alip
    // hemen bir olay yayarsa, o olay HICBIR ZAMAN islenmez.
    //
    // Olcum: her soketin YAYDIGI ILK OLAY dusuyordu. Iki ornekli testte
    // `dm:call:start` hicbir sey uretmiyordu — arayana `dm:call:outgoing`
    // bile donmuyordu, cunku sunucuda dinleyici yoktu. Ayni olay ikinci kez
    // yayildiginda calisiyordu; bu yuzden kusur "cok ornekli teslimat
    // sorunu" gibi gorunuyordu, oysa TEK ornekte de gecerlidir.
    //
    // Gercek etki: yeniden baglanan istemcinin ilk eylemi (kuyruktaki mesaj,
    // sesli kanala geri katilma, gelen aramayi kabul) sessizce kayboluyordu.
    //
    // Sinyal artik yalnizca soket GERCEKTEN hazir oldugunda yayilir:
    // kisisel odaya katilmis (yukarida) VE tum dinleyiciler kayitli.
    socket.emit('userAuthenticated', user._id);

    // Periodic token re-auth — JWT expire olsa bile açık kalan bağlantıları kapat
    const TOKEN_CHECK_INTERVAL = 5 * 60_000;
    const tokenCheckTimer = setInterval(async () => {
      try {
        const freshUser = await Users.findById(user._id);
        if (!freshUser) { clearInterval(tokenCheckTimer); return socket.disconnect(true); }
        if ((socket.tokenV ?? 0) !== parseTokenVersion(freshUser.tokenVersion)) {
          clearInterval(tokenCheckTimer);
          socket.emit('auth:revoked', { reason: 'token_revoked' });
          socket.disconnect(true);
        }
      } catch (err) {
        // Authentication state is authoritative DB state. If it cannot be
        // revalidated, keeping a long-lived socket alive turns an auth-store
        // outage into a fail-open authorization window.
        clearInterval(tokenCheckTimer);
        logger.warn({ userId: user._id, event: 'socket.auth_recheck_failed', err: (err as Error)?.message },
          'Periodic socket authentication re-check failed; connection revoked fail-closed.');
        socket.emit('auth:revoked', { reason: 'auth_check_failed' });
        socket.disconnect(true);
      }
    }, TOKEN_CHECK_INTERVAL);
    const tokenExpiryTimer = Number.isSafeInteger(socket.tokenExp)
      ? setTimeout(() => {
          socket.emit('auth:revoked', { reason: 'token_expired' });
          socket.disconnect(true);
        }, Math.max(0, Number(socket.tokenExp) * 1000 - Date.now()))
      : null;
    tokenExpiryTimer?.unref?.();

    // DISCONNECT
    socket.on('disconnect', async (reason) => {
      socket.removeAllListeners();
      try {
        await handleDisconnect(socket, socketUser, {
          socketUsers, typingTimers, _socketRateStore,
          leaveVoice, voiceActivity, tokenCheckTimer, tokenExpiryTimer, io,
        });
      } catch (err) {
        logger.error({ err, userId: user._id, event: 'socket.disconnect_cleanup_failed' }, 'Socket disconnect cleanup failed.');
      }
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

export { setupSocket, voiceRooms, getVoiceRoomCount, getSocketStats, getIo, socketUsers, pushMemberCount };
