// server/socket/handlers/infra.js
// Altyapı socket event'leri:
//   typing, status, notif:pref, friend, server/channel yönetimi,
//   polls, soundboard, bot modals, member nicknames, disconnect

'use strict';

const logger = require('../../lib/logger');
const { Users, Members, Notifications } = require('../../db/repositories');

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
function registerInfraHandlers(socket, rawSocket, io, user, {
  socketUsers, typingTimers, TYPING_TIMEOUT_MS,
  _socketRateStore, leaveVoice, voiceActivity,
  refreshMemberships, safeUser,
}) {

  // ── TYPING INDICATORS ─────────────────────────────────────────
  socket.on('typing:start', ({ channelId }) => {
    if (!channelId) return;
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

  socket.on('typing:stop', ({ channelId }) => {
    if (!channelId) return;
    const key = `${channelId}:${user._id}`;
    const timer = typingTimers.get(key);
    if (timer) { clearTimeout(timer); typingTimers.delete(key); }
    rawSocket.to(`channel:${channelId}`).emit('typing:stop', { channelId, userId: user._id });
  });

  // ── STATUS ────────────────────────────────────────────────────
  socket.on('status:update', async ({ status, statusText, statusEmoji }) => {
    const allowed = ['online', 'idle', 'dnd', 'offline'];
    if (!allowed.includes(status)) return;
    try {
      await Users.update(user._id, { status, statusText: statusText || '', statusEmoji: statusEmoji || '' });
      const current = await Members.findByUser(user._id);
      for (const m of current) {
        io.to(`server:${m.serverId}`).emit('user:status', { userId: user._id, status, statusText: statusText || '', statusEmoji: statusEmoji || '' });
      }
    } catch {}
  });

  // ── NOTIFICATION PREFS ────────────────────────────────────────
  socket.on('notif:pref', async ({ channelId, level }) => {
    const allowed = ['all', 'mentions', 'mute'];
    if (!allowed.includes(level)) return;
    try {
      await Notifications.upsertPref(user._id, channelId, { level, updatedAt: Date.now() });
      rawSocket.emit('notif:pref:updated', { channelId, level });
    } catch {}
  });

  // ── FRIEND EVENTS ─────────────────────────────────────────────
  socket.on('friend:request:notify', ({ toUserId }) => {
    for (const [sid, su] of socketUsers) {
      if ((su._id || su.id) === toUserId) io.to(sid).emit('friend:request:received', { from: safeUser });
    }
  });

  // ── SERVER MEMBERSHIP ─────────────────────────────────────────
  socket.on('server:joined', async ({ serverId }) => {
    rawSocket.join(`server:${serverId}`);
    await refreshMemberships();
  });
  socket.on('server:left', ({ serverId }) => rawSocket.leave(`server:${serverId}`));

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
  socket.on('soundboard:play', ({ channelId, soundUrl, soundName, emoji }) =>
    rawSocket.to(`voice:${channelId}`).emit('soundboard:play', { channelId, soundUrl, soundName, emoji })
  );

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
async function handleDisconnect(rawSocket, user, {
  socketUsers, typingTimers, _socketRateStore,
  leaveVoice, voiceActivity, tokenCheckTimer, io,
}) {
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
  if (rawSocket.currentVoiceChannel) leaveVoice(rawSocket, rawSocket.currentVoiceChannel, rawSocket.currentVoiceServer, io);
  voiceActivity.delete(rawSocket.id);

  // 5. Multi-tab: başka bağlantı yoksa offline yap
  const stillConnected = [...socketUsers.values()].some(u => (u._id || u.id) === user._id);
  if (!stillConnected) {
    try { await Users.update(user._id, { status: 'offline' }); } catch {}
    const current = await Members.findByUser(user._id).catch(() => []);
    for (const m of current) io.to(`server:${m.serverId}`).emit('user:status', { userId: user._id, status: 'offline' });
  }
}

module.exports = { registerInfraHandlers, handleDisconnect };
export {};
