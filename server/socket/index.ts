// server/socket/index.js
// Session 8 Fix: applyAdapter eklendi — Redis clustering desteği
// Memory leak düzeltmeleri:
//   1. socketUsers Map — disconnect'te kesin temizleme
//   2. voiceRooms — boş odalar periyodik temizleme
//   3. memberships — closure referans sızdırması önlendi
//   4. typing indicators — timeout ile otomatik temizleme
//   5. Multi-tab desteği — aynı kullanıcı birden fazla bağlantı
// IP ban + IP-bazlı socket rate limiting entegrasyonu

'use strict';
const logger = require('../lib/logger');

const { verifyToken, _invalidateTokenCache } = require('../middleware/auth');
const { sanitizeUser } = require('../lib/userUtils');
const { Users, Members, Channels, Notifications } = require('../db/repositories');
const { getBan, banIp, getClientIp } = require('../middleware/ipBan');

const { registerMessageHandlers, registerThreadSocketEvents } = require('./handlers/messages');
const { registerVoiceHandlers, leaveVoice, voiceRooms, voiceActivity } = require('./handlers/voice');
const { registerMusicHandlers } = require('./handlers/music');
const { registerDmHandlers, registerGroupDmHandlers } = require('./handlers/dm');
const { registerStageHandlers } = require('./handlers/stage');
const { registerSFUHandlers, isSFUReady } = require('./handlers/mediasoup');
const { registerInfraHandlers, handleDisconnect } = require('./handlers/infra');
const { registerCanvasHandlers } = require('./handlers/canvas');
const { registerDmReadHandlers  } = require('./handlers/dm-read');

// socketId → sanitized user
const socketUsers = new Map();

// ── IP ÇÖZÜMLEYICI (Socket.IO handshake'den) ───────────────────
// getClientIp() Express req beklediği için Socket.IO'ya uygun sarmalayıcı.
function getSocketIp(socket) {
  // Socket.IO handshake'i req benzeri nesneye çevir
  const fakeReq = {
    ip: socket.handshake.address,
    headers: socket.handshake.headers,
    socket: { remoteAddress: socket.conn?.remoteAddress || socket.handshake.address },
  };
  return getClientIp(fakeReq);
}

// ── IP BAZLI SOCKET RATE LIMITER ───────────────────────────────
// ip:event → [timestamps]  (in-memory sliding window)
// Auth öncesi de çalışır — bağlantı spam'ini önler.
// ── IP RATE STORE: Redis-backed (multi-instance safe) ─────────
// Single-instance: Map kullanılır. Redis varsa (cluster/k8s) Redis'e geçilir.
const { cache: _rateCache, applyAdapter } = require('../lib/redisAdapter');
const _ipRateStore = new Map(); // Fallback for single-instance

async function _ipRateStoreGet(key) {
  if (_rateCache) {
    try {
      const val = await _rateCache.get(`ipratelimit:${key}`);
      return val ? JSON.parse(val) : [];
    } catch { /* fallback */ }
  }
  return _ipRateStore.get(key) || [];
}

async function _ipRateStoreSet(key, hits) {
  if (_rateCache) {
    try {
      await _rateCache.set(`ipratelimit:${key}`, JSON.stringify(hits), 'EX', 120);
      return;
    } catch { /* fallback to in-memory */ }
  }
  _ipRateStore.set(key, hits);
}

async function _ipRateStoreDel(key) {
  if (_rateCache) {
    try { await _rateCache.del(`ipratelimit:${key}`); return; } catch { /* fallback */ }
  }
  _ipRateStore.delete(key);
}
const IP_SOCKET_RL = {
  connect:   { max: parseInt(process.env.RL_SOCKET_CONNECT_MAX ?? "") || 20,  windowMs: 60_000  }, // 20 bağlantı/dk
  handshake: { max: parseInt(process.env.RL_SOCKET_HS_MAX ?? "")      || 30,  windowMs: 60_000  }, // 30 handshake/dk
};

// Otomatik geçici ban eşiği: IP bu kadar kez aşarsa geçici ban
const AUTO_BAN_THRESHOLD   = parseInt(process.env.RL_AUTO_BAN_THRESHOLD ?? "") || 5;   // kaç ihlal sonrası
const AUTO_BAN_DURATION_MS = parseInt(process.env.RL_AUTO_BAN_DURATION ?? "") || 15 * 60_000; // 15 dk

// ip → ihlal sayısı + zaman
const _ipViolations = new Map();

setInterval(() => {
  const now = Date.now();
  const WINDOW = Math.max(...Object.values(IP_SOCKET_RL).map(r => r.windowMs), 120_000);
  // Redis-backed store doesn't need local cleanup (TTL handles it)
  if (!_rateCache) for (const [k, hits] of _ipRateStore) {
    const fresh = hits.filter(t => now - t < WINDOW);
    if (!fresh.length) _ipRateStore.delete(k); else _ipRateStore.set(k, fresh);
  }
  // Eski ihlal kayıtlarını temizle (1 saat)
  for (const [ip, rec] of _ipViolations) {
    if (now - rec.firstAt > 3_600_000) _ipViolations.delete(ip);
  }
}, 2 * 60_000);

/**
 * IP bazlı rate check. İhlal sayısı AUTO_BAN_THRESHOLD'u aşarsa otomatik geçici ban uygular.
 * @returns {boolean} true = geçebilir, false = engellendi
 */
async function ipRateCheck(ip, event) {
  const cfg = IP_SOCKET_RL[event];
  if (!cfg) return true;

  const key = `ip:${ip}:${event}`;
  const now = Date.now();
  const _stored = await _ipRateStoreGet(key);
  const hits = _stored.filter(t => now - t < cfg.windowMs);
  hits.push(now);
  await _ipRateStoreSet(key, hits);

  if (hits.length <= cfg.max) return true;

  // Limit aşıldı — ihlal sayacını artır
  const rec = _ipViolations.get(ip) || { count: 0, firstAt: now };
  rec.count += 1;
  if (rec.count === 1) rec.firstAt = now;
  _ipViolations.set(ip, rec);

  logger.warn(`[SocketRL] IP rate limit aşıldı: ip=${ip} event=${event} ihlal=${rec.count}`);

  // Eşik aşıldıysa otomatik geçici ban
  if (rec.count >= AUTO_BAN_THRESHOLD) {
    try {
      const existing = await getBan(ip);
      if (!existing) {
        await banIp(ip, {
          reason:     `Otomatik ban: socket ${event} rate limit ${rec.count}x aşıldı`,
          durationMs: AUTO_BAN_DURATION_MS,
          adminId:    'system',
        });
        logger.warn(`[SocketRL] Otomatik IP ban uygulandı: ip=${ip} süre=${AUTO_BAN_DURATION_MS / 60_000}dk`);
        _ipViolations.delete(ip); // sıfırla
      }
    } catch (err) {
      logger.error('[SocketRL] Auto-ban hatası:', err.message);
    }
  }

  return false;
}

// ── KULLANICI BAZLI SOCKET RATE LIMITER ────────────────────────
// userId:event → [timestamps]  (in-memory sliding window)
const _socketRateStore = new Map();
const SOCKET_RL = {
  'message:send':  { max: 20,  windowMs: 10_000  },  // 20 mesaj / 10 sn
  'dm:send':       { max: 10,  windowMs: 10_000  },  // 10 DM / 10 sn
  'gdm:send':      { max: 10,  windowMs: 10_000  },
  'typing:start':  { max: 30,  windowMs: 5_000   },
  'voice:signal':  { max: 60,  windowMs: 10_000  },
  'channel:join':  { max: 20,  windowMs: 10_000  },
  '*':             { max: 200, windowMs: 60_000  },   // global fallback / kullanıcı / dk
};
setInterval(() => {
  const now = Date.now();
  for (const [k, hits] of _socketRateStore) {
    const fresh = hits.filter(t => now - t < 120_000);
    if (!fresh.length) _socketRateStore.delete(k); else _socketRateStore.set(k, fresh);
  }
}, 2 * 60_000);

function socketRateCheck(userId, event) {
  const cfg = SOCKET_RL[event] || SOCKET_RL['*'];
  const key = `${userId}:${event}`;
  const now = Date.now();
  const hits = (_socketRateStore.get(key) || []).filter(t => now - t < cfg.windowMs);
  hits.push(now);
  _socketRateStore.set(key, hits);
  return hits.length <= cfg.max;
}

// Global kullanıcı başına genel hız limiti
function socketGlobalCheck(userId) {
  return socketRateCheck(userId, '*');
}

// "channelId:userId" → timeout handle (typing indicator)
const typingTimers = new Map();
const TYPING_TIMEOUT_MS = 5_000;

// Boş voice room temizleyici — her 10 dk
setInterval(() => {
  for (const [channelId, peers] of Object.entries(voiceRooms)) {
    if (!peers || (peers as any[]).length === 0) delete voiceRooms[channelId];
  }
}, 10 * 60_000);

// socketUsers boyut izleyici
setInterval(() => {
  if (socketUsers.size > 10_000) {
    logger.warn(`[Socket] ⚠️ socketUsers Map boyutu yüksek: ${socketUsers.size}`);
  }
}, 5 * 60_000);

let _io = null;
function getIo() { return _io; }

function setupSocket(io) {
  _io = io;

  // ── Redis adapter — Socket.IO clustering (multi-instance) ───────
  // REDIS_URL tanımlıysa adapter bağlanır, yoksa in-memory modunda devam eder.
  applyAdapter(io).then(ok => {
    if (ok) logger.info({ event: 'socket.redis_adapter.applied' }, '[Socket] Redis adapter aktif — cluster modu.');
    else logger.warn({ event: 'socket.redis_adapter.skipped' }, '[Socket] Redis yok — tek instance modunda çalışılıyor. Yatay ölçekleme için REDIS_URL ekleyin.');
  }).catch(err => logger.error({ err, event: 'socket.redis_adapter.error' }, '[Socket] Redis adapter hatası.'));

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
        const err = new Error('IP banned');
        err.data = { reason: ban.reason, expiresAt: ban.expiresAt, remainingSeconds: remaining };
        return next(err);
      }
    } catch (e) {
      logger.error('[Socket] IP ban kontrolü hatası:', e.message);
      // Ban kontrolü hatalıysa geçişe izin ver — servisi durdurma
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
      const err = new Error('Too many connections');
      err.data = { retryAfter: Math.ceil(IP_SOCKET_RL.connect.windowMs / 1000) };
      return next(err);
    }
    next();
  });

  // ── MİDDLEWARE 3: JWT doğrulama ────────────────────────────────
  io.use(async (socket, next) => {
    const decoded = verifyToken(socket.handshake.auth.token);
    if (!decoded) return next(new Error('Unauthorized'));

    // tokenVersion kontrolü — zorla çıkış yapıldıysa bağlantıyı reddet
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
      user = await Users.findById(socket.userId);
    } catch (err) {
      logger.error('[Socket] DB hatası:', err.message);
      return socket.disconnect(true);
    }
    if (!user) return socket.disconnect(true);

    const safeUser = sanitizeUser(user);
    socketUsers.set(socket.id, safeUser);

    try { await Users.update(user._id, { status: 'online' }); } catch {}

    // Memberships — connection başında çek
    let memberships: any[] = [];
    async function refreshMemberships() {
      try {
        memberships = await Members.findByUser(user._id);
        for (const m of memberships) socket.join(`server:${m.serverId}`);
      } catch {}
    }
    await refreshMemberships();

//     personal room for GDM/DM notifications
    socket.join(`user:${user._id}`);
    socket.on('user:join-room', (uid) => { if (uid === user._id) socket.join(`user:${uid}`); });

    for (const m of memberships) {
      io.to(`server:${m.serverId}`).emit('user:status', { userId: user._id, status: 'online' });
    }

    // CHANNEL JOIN
    socket.on('channel:join', async (channelId) => {
      try {
        const channel = await Channels.findById(channelId);
        if (!channel) return;
        const membership = await Members.findOne(user._id, channel.serverId);
        if (!membership) return;
        for (const room of socket.rooms) {
          if (room.startsWith('channel:') && room !== `channel:${channelId}`) socket.leave(room);
        }
        socket.join(`channel:${channelId}`);
        socket.currentChannel = channelId;
      } catch {}
    });

    // FEATURE HANDLERS — rate limiting inject edilmiş
    // Her handler'ın socket.on'larını sarmalayan rate-limited proxy socket oluştur
    const rateLimitedSocket = new Proxy(socket, {
      get(target, prop) {
        if (prop !== 'on') return typeof target[prop] === 'function' ? target[prop].bind(target) : target[prop];
        return function(event, handler) {
          target.on(event, async (...args) => {
            // Rate-limited event'ler için kontrol
            if (SOCKET_RL[event] && !socketRateCheck(user._id, event)) {
              logger.warn(`[RateLimit] Socket event throttled: ${event} user=${user._id}`);
              target.emit('error:ratelimit', { event, message: 'Çok hızlı! Yavaşla.' });
              return;
            }
            // Global limit
            if (!socketGlobalCheck(user._id)) {
              logger.warn(`[RateLimit] Socket global throttled: user=${user._id}`);
              return;
            }
            return handler(...args);
          });
        };
      },
    });

    registerMessageHandlers(rateLimitedSocket, io, user, socketUsers);
    registerVoiceHandlers(rateLimitedSocket, io, user);
    registerMusicHandlers(rateLimitedSocket, io, user);
    registerDmHandlers(rateLimitedSocket, io, user, socketUsers);
    registerGroupDmHandlers(rateLimitedSocket, io, user, socketUsers);
    registerThreadSocketEvents(rateLimitedSocket, io, user);
    registerStageHandlers(rateLimitedSocket, io, user);
    registerCanvasHandlers(rateLimitedSocket, io, user);
    registerDmReadHandlers(rateLimitedSocket, io, user);

    // SFU: Mediasoup kuruluysa SFU event'lerini kaydet
    if (isSFUReady()) {
      registerSFUHandlers(rateLimitedSocket, io, user);
    }

    // ALTYAPI EVENT'LERİ — handlers/infra.js'e taşındı (Sprint 9)
    registerInfraHandlers(rateLimitedSocket, socket, io, user, {
      socketUsers, typingTimers, TYPING_TIMEOUT_MS,
      _socketRateStore, leaveVoice, voiceActivity,
      refreshMemberships, safeUser,
    });

//     Periodic token re-auth — JWT expire olsa bile açık kalan bağlantıları kapat
    // Her 5 dakikada bir tokenVersion kontrolü yapar
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
      } catch { /* DB hatası — bağlantıyı kesme, sadece logla */ }
    }, TOKEN_CHECK_INTERVAL);

    // DISCONNECT — handlers/infra.js'e taşındı (Sprint 9)
    socket.on('disconnect', async (reason) => {
      await handleDisconnect(socket, user, {
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
    voicePeers:       Object.values(voiceRooms).reduce((a: number, p: any) => a + (p as any[]).length, 0),
  };
}

module.exports = { setupSocket, voiceRooms, getSocketStats, getIo, socketUsers };
export {};
