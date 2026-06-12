// server/socket/handlers/infra.ts
// Altyapı socket event'leri:
//   typing, status, notif:pref, friend, server/channel yönetimi,
//   polls, soundboard, bot modals, member nicknames, disconnect

import logger from '../../lib/logger';
import { Users, Members, Notifications } from '../../db/repositories';
import { pushMemberCount } from './discover';
import {
  getMembershipsCached,
  invalidateMemberships,
  throttleStatusWrite,
  markOnline,
  markOffline,
  releaseSocket,
} from '../../lib/presenceCache';

import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { Server, Socket } from 'socket.io';
import type { SafeUser } from '../../lib/userUtils';

interface InfraHandlerOptions {
  socketUsers:       Map<string, SafeUser>;
  typingTimers:      Map<string, ReturnType<typeof setTimeout>>;
  TYPING_TIMEOUT_MS: number;
  _socketRateStore:  Map<string, number[]>;
  leaveVoice:        (socket: Socket, channelId: string, serverId: string | undefined, io: Server) => Promise<void>;
  voiceActivity:     Map<string, number>;
  refreshMemberships:(userId: string) => Promise<void>;
  safeUser:          SafeUser;
}

interface DisconnectOptions {
  socketUsers:     Map<string, SafeUser>;
  typingTimers:    Map<string, ReturnType<typeof setTimeout>>;
  _socketRateStore:Map<string, number[]>;
  leaveVoice:      (socket: Socket, channelId: string, serverId: string | undefined, io: Server) => Promise<void>;
  voiceActivity:   Map<string, number>;
  tokenCheckTimer: ReturnType<typeof setInterval>;
  io:              Server;
}


/**
 * Tüm altyapı olaylarını kaydeder.
 * @param {object} socket         — rate-limited socket proxy
 * @param {object} rawSocket      — ham Socket.IO socket (room join/leave için)
 * @param {object} io             — Socket.IO server instance
 * @param {object} user           — kimliği doğrulanmış kullanıcı
 * @param {Map}    socketUsers    — socketId → sanitizedUser
 * @param {Map}    typingTimers   — channelId:userId → timeout handle
 * @param {number} TYPING_TIMEOUT_MS
 * @param {Map}    _socketRateStore
 * @param {Function} leaveVoice
 * @param {object} voiceActivity
 * @param {Function} refreshMemberships
 * @param {object} safeUser       — sanitize edilmiş user
 */
function registerInfraHandlers(
  socket: Socket,
  rawSocket: Socket,
  io: Server,
  user: SafeUser & { _id: string },
  { socketUsers, typingTimers, TYPING_TIMEOUT_MS, _socketRateStore, leaveVoice, voiceActivity, refreshMemberships, safeUser }: InfraHandlerOptions,
): void {

  // ── TYPING INDICATORS ─────────────────────────────────────────
  // FIX: channelId artık socket room üyeliğiyle doğrulanıyor.
  // Kullanıcı o kanala join olmamışsa (channel:join event'i gelmediyse) typing
  // event'i yayılmaz. Bu, herhangi bir authenticated kullanıcının rastgele
  // bir channelId ile typing broadcast yapmasını engelliyor.
  socket.on('typing:start', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.typingChannel).valid) return;
    const { channelId } = payload;
    // Kanal üyelik kontrolü: rawSocket ancak channel:join sonrası ilgili room'a girer.
    if (!rawSocket.rooms.has(`channel:${channelId}`)) return;
    const key = `${channelId}:${user._id}`;
    const existing = typingTimers.get(key);
    if (existing) clearTimeout(existing);
    rawSocket.to(`channel:${channelId}`).emit('typing:start', {
      channelId, userId: user._id, displayName: user.displayName, avatarColor: user.avatarColor,
    });
    const timer = setTimeout(() => {
      typingTimers.delete(key);
      rawSocket.to(`channel:${channelId}`).emit('typing:stop', { channelId, userId: user._id });
    }, TYPING_TIMEOUT_MS);
    typingTimers.set(key, timer);
  });

  socket.on('typing:stop', (payload: { channelId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.typingChannel).valid) return;
    const { channelId } = payload;
    // Üye olunmayan kanallar için stop event'i de görmezden gel.
    if (!rawSocket.rooms.has(`channel:${channelId}`)) return;
    const key = `${channelId}:${user._id}`;
    const timer = typingTimers.get(key);
    if (timer) { clearTimeout(timer); typingTimers.delete(key); }
    rawSocket.to(`channel:${channelId}`).emit('typing:stop', { channelId, userId: user._id });
  });

  // ── STATUS ────────────────────────────────────────────────────
  socket.on('status:update', async (payload: { status: string; statusText?: string; statusEmoji?: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.statusUpdate).valid) return;
    const { status, statusText, statusEmoji } = payload;
    const allowed = ['online', 'idle', 'dnd', 'offline'];
    if (!allowed.includes(status)) return;
    try {
      // Throttle: aynı status kısa sürede tekrar gelirse DB yazmasını atla.
      // statusText/Emoji değişimlerinde her zaman yaz (içerik farklı olabilir).
      const hasExtra = (statusText || '') || (statusEmoji || '');
      const shouldWrite = hasExtra || await throttleStatusWrite(user._id, status);
      if (shouldWrite) {
        await Users.update(user._id, { status, statusText: statusText || '', statusEmoji: statusEmoji || '' });
      }

      // Üyelik listesini cache'den al — Members.findByUser DB yükünü azaltır
      const current = await getMembershipsCached(user._id, () => Members.findByUser(user._id));
      const payload = { userId: user._id, status, statusText: statusText || '', statusEmoji: statusEmoji || '' };
      for (const m of current) {
        io.to(`server:${m.serverId}`).emit('user:status', payload);
      }

      // Presence heartbeat
      if (status !== 'offline') await markOnline(user._id);
      else await markOffline(user._id);
    } catch (e) {
      logger.warn({ userId: user._id, event: 'socket.status_update.error', err: (e as Error).message },
        'status:update işlemi başarısız.');
    }
  });
  socket.on('notif:pref', async (payload: { channelId: string; level: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.notifPref).valid) return;
    const { channelId, level } = payload;
    const allowed = ['all', 'mentions', 'mute'];
    if (!allowed.includes(level)) return;
    try {
      await Notifications.upsertPref(user._id, channelId, { level, updatedAt: Date.now() });
      rawSocket.emit('notif:pref:updated', { channelId, level });
    } catch (e) {
      logger.warn({ userId: user._id, channelId, event: 'socket.notif_pref.error', err: (e as Error).message },
        'notif:pref kaydedilemedi.');
    }
  });
  socket.on('friend:request:notify', (payload: { toUserId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.friendRequestNotify).valid) return;
    const { toUserId } = payload;
    for (const [sid, su] of socketUsers) {
      if ((su._id || su.id) === toUserId) io.to(sid).emit('friend:request:received', { from: safeUser });
    }
  });

  // ── SERVER MEMBERSHIP ─────────────────────────────────────────
  socket.on('server:joined', async (payload: { serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.serverIdPayload).valid) return;
    const { serverId } = payload;
    rawSocket.join(`server:${serverId}`);
    // Üyelik değişti — cache'i geçersiz kıl
    await invalidateMemberships(user._id);
    await refreshMemberships(user._id);
    // Keşif sayfasındaki üye sayısını güncelle
    pushMemberCount(io, serverId).catch(() => {});
  });
  socket.on('server:left', async (payload: { serverId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.serverIdPayload).valid) return;
    const { serverId } = payload;
    rawSocket.leave(`server:${serverId}`);
    await invalidateMemberships(user._id);
    // Keşif sayfasındaki üye sayısını güncelle
    pushMemberCount(io, serverId).catch(() => {});
  });

  // ── CHANNEL MANAGEMENT ────────────────────────────────────────
  socket.on('channel:created', ({ serverId, channel })   => io.to(`server:${serverId}`).emit('channel:created', channel));
  socket.on('channel:deleted', ({ serverId, channelId }) => io.to(`server:${serverId}`).emit('channel:deleted', { channelId }));
  socket.on('channel:updated', ({ serverId, channel })   => io.to(`server:${serverId}`).emit('channel:updated', channel));

  socket.on('category:created', ({ serverId, category })   => io.to(`server:${serverId}`).emit('category:created', category));
  socket.on('category:updated', ({ serverId, category })   => io.to(`server:${serverId}`).emit('category:updated', category));
  socket.on('category:deleted', ({ serverId, categoryId }) => io.to(`server:${serverId}`).emit('category:deleted', { categoryId }));

  // ── POLLS ─────────────────────────────────────────────────────
  socket.on('poll:created', ({ channelId, poll }) =>
    io.to(`channel:${channelId}`).emit('poll:created', { channelId, poll })
  );

  // ── SOUNDBOARD ────────────────────────────────────────────────
  socket.on('soundboard:play', (payload: { channelId: string; soundUrl: string; soundName?: string; emoji?: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.soundboardPlay).valid) return;
    const { channelId, soundUrl, soundName, emoji } = payload;
    rawSocket.to(`voice:${channelId}`).emit('soundboard:play', { channelId, soundUrl, soundName, emoji });
  });

  // ── BOT MODAL ─────────────────────────────────────────────────
  socket.on('bot:showModal', ({ userId, modal }) => {
    if (!modal?.customId || !modal?.title) return;
    const targetSockets = [...socketUsers.entries()]
      .filter(([, u]) => (u._id || u.id) === userId)
      .map(([sid]) => sid);
    targetSockets.forEach(sid => io.to(sid).emit('bot:showModal', { modal }));
  });

  // ── MEMBER NICKNAME UPDATE ────────────────────────────────────
  socket.on('member:nicknameUpdate', (data) => {
    if (data?.serverId) io.to(`server:${data.serverId}`).emit('member:nicknameUpdate', data);
  });
}

/**
 * Disconnect temizlik işlemleri — token timer dahil.
 * socket/index.js'deki disconnect handler'ında çağrılır.
 */
async function handleDisconnect(
  rawSocket: Socket,
  user: SafeUser & { _id: string },
  { socketUsers, typingTimers, _socketRateStore, leaveVoice, voiceActivity, tokenCheckTimer, io }: DisconnectOptions,
): Promise<void> {
  // 0. Token check timer'ı temizle
  clearInterval(tokenCheckTimer);
  socketUsers.delete(rawSocket.id);

  // 1. Tüm room'lardan çık
  for (const room of [...rawSocket.rooms]) {
    if (room !== rawSocket.id) rawSocket.leave(room);
  }

  // 2. Typing timer'ları temizle
  for (const [key, timer] of typingTimers) {
    if (key.endsWith(`:${user._id}`)) { clearTimeout(timer); typingTimers.delete(key); }
  }

  // 3. Rate limit kayıtlarını serbest bırak
  const userPrefix = `${user._id}:`;
  for (const key of _socketRateStore.keys()) {
    if (key.startsWith(userPrefix)) _socketRateStore.delete(key);
  }

  // 4. Ses kanalından çık
  if (rawSocket.currentVoiceChannel) leaveVoice(rawSocket, rawSocket.currentVoiceChannel, rawSocket.currentVoiceServer ?? undefined, io);
  voiceActivity.delete(rawSocket.id);

  // 5. Multi-tab: başka bağlantı yoksa offline yap
  // releaseSocket, presenceCache'deki socket map'ini günceller ve son socket
  // kapanınca Redis'e markOffline + cluster pub/sub bildirimi gönderir.
  const remainingSockets = await releaseSocket(user._id, rawSocket.id);
  const stillConnected   = remainingSockets > 0
    // Fallback: presenceCache'de socket yoksa socketUsers Map'ten kontrol et
    || [...socketUsers.values()].some(u => (u._id || u.id) === user._id);

  if (!stillConnected) {
    try { await Users.update(user._id, { status: 'offline' }); } catch (e) {
      logger.warn({ userId: user._id, event: 'socket.disconnect.offline_update_error', err: (e as Error).message },
        'Offline durum güncellenemedi.');
    }
    // markOffline artık releaseSocket() içinde çağrılıyor; burada tekrar çağrılmaz
    const current = await getMembershipsCached(user._id, () => Members.findByUser(user._id).catch(() => []));
    for (const m of current) io.to(`server:${m.serverId}`).emit('user:status', { userId: user._id, status: 'offline' });
  }
}

export { registerInfraHandlers, handleDisconnect };
