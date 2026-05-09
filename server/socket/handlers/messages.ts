// server/socket/handlers/messages.js
const { v4: uuidv4 } = require('uuid');
const { Messages, Members, Channels, ReactionRoles, Users, Notifications, Bridges } = require('../../db/repositories');
const { hasPermission, PERMS, resolvePermissions } = require('../../routes/roles');
const { sanitizeUser } = require('../../lib/userUtils');
const { getCachedPerms, invalidatePerms } = require('../../lib/permCache');
let _dispatchEvent: ((sid: string, ev: string, d: any) => Promise<any>) | null = null;
try { _dispatchEvent = require('../../routes/outgoingWebhooks').dispatchEvent; } catch {}
// Plugin hooks
let _pluginHooks: { emit: (ev: string, d: any) => any } | null = null;
try { _pluginHooks = require('../../plugins/loader').hooks; } catch {}

// ── Link önizleme yardımcısı ──────────────────────────────────
const { extractUrls, fetchLinkPreview } = require('../../lib/linkPreview');

// DB transaction — message:delete atomic wrapper için
let _db = null;
function getDb() {
  if (_db) return _db;
  try { _db = require('../../db/loader'); } catch { _db = null; }
  return _db;
}

function systemMsg(channelId, serverId, content) {
  return {
    _id: uuidv4(), channelId, serverId,
    userId: 'system', username: 'Bridge Bot',
    displayName: '🤖 Bridge Bot', avatarColor: '#5865f2',
    content, type: 'system', reactions: {}, createdAt: Date.now(),
  };
}

function formatDuration(seconds) {
  if (!seconds) return '?:??';
  const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function registerMessageHandlers(socket, io, user, socketUsers) {
  async function sendChannelMessage({ channelId, content, serverId, replyToId, type, fileUrl, fileName, fileType }) {
    if (type !== 'file' && !content?.trim()) return;
    if (content && content.length > 2000) return;

    const membership = await Members.findOne(user._id, serverId);
    if (!membership) return;

    if (membership.timeoutUntil && membership.timeoutUntil > Date.now()) {
      socket.emit('error:timeout', { remaining: Math.ceil((membership.timeoutUntil - Date.now()) / 1000) });
      return;
    }

    const channel = await Channels.findByIdAndServer(channelId, serverId);
    if (!channel) return;

    const sendPerms = await getCachedPerms(user._id, serverId, resolvePermissions);
    if (!hasPermission(sendPerms, PERMS.SEND_MESSAGES)) return;

    // Anti-spam kontrolü
    if (type !== 'file' && content?.trim()) {
      const { checkSpam } = require('../../lib/security');
      const spamResult = checkSpam(user._id, content);
      if (spamResult.blocked) {
        socket.emit('error:spam', { reason: spamResult.reason, remainingMs: spamResult.remainingMs || 30000 });
        return;
      }
      if (spamResult.warning) {
        socket.emit('warn:spam', { message: 'Çok hızlı mesaj gönderiyorsunuz. Yavaşlayın.' });
      }
    }

    // İçerik sanitizasyonu — XSS koruması
    const { sanitizeMessage } = require('../../lib/security');
    if (content?.startsWith('!')) {
      const { handleMusicCommand } = require('./music');
      const handled = await handleMusicCommand({ content, channelId, serverId, user, io, socket });
      if (handled) return;
    }

    const msgData: Record<string,any> = {
      _id: uuidv4(), channelId, serverId,
      userId: user._id, username: user.username,
      displayName: membership.nickname || user.displayName,
      avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
      content: content ? sanitizeMessage(content) : '',
      type: type || 'normal',
      reactions: {},
      createdAt: Date.now(),
    };
    if (type === 'file') { msgData.fileUrl = fileUrl; msgData.fileName = fileName; msgData.fileType = fileType; }
    if (replyToId) {
      const replyTo = await Messages.findById(replyToId);
      if (replyTo) msgData.replyTo = { _id: replyTo._id, displayName: replyTo.displayName, content: replyTo.content?.slice(0, 100) };
    }

    const msg = await Messages.create(msgData);
    io.to(`channel:${channelId}`).emit('message:new', msg);
    if (_dispatchEvent) _dispatchEvent(serverId, 'message:new', { channelId, messageId: msg._id, content: msg.content?.slice(0,500), username: msg.displayName }).catch(()=>{});
//     plugin hook
    if (_pluginHooks) _pluginHooks.emit('message:created', { messageId: msg._id, channelId, serverId, userId: user.id, content: msg.content, displayName: msg.displayName }).catch?.(()=>{});

    // ── Otomatik link önizleme (non-blocking) ────────────────
    if (type !== 'file' && content) {
      const urls = extractUrls(content, 3);
      if (urls.length) {
        (async () => {
          try {
            const embeds: any[] = [];
            for (const u of urls) {
              const preview = await fetchLinkPreview(u);
              if (preview) embeds.push(preview);
            }
            if (embeds.length) {
              await Messages.update(msg._id, { embeds: JSON.stringify(embeds) });
              io.to(`channel:${channelId}`).emit('message:embedUpdate', { messageId: msg._id, embeds });
            }
          } catch { /* non-fatal */ }
        })();
      }
    }

    // Cache invalidate — bu kanalın first page cache'ini temizle
    try {
      const { cache } = require('../../lib/redisAdapter');
      await cache.del(`messages:${channelId}:first:50`);
      await cache.del(`messages:${channelId}:first:100`);
    } catch { /* non-fatal */ }

    // Mention notification sistemi
    try {
      const { processNotifications } = require('../../lib/notifications');
      await processNotifications(msg, io, socketUsers);
    } catch { /* non-fatal */ }

    // Bridge forwarding
    try {
      const bridges = await Bridges.findActiveFromSourceChannel(channelId);
      for (const bridge of bridges) {
        if (type === 'file') continue;
        const bMsg = await Messages.create({
          _id: uuidv4(), channelId: bridge.targetChannelId, serverId: bridge.targetServerId,
          userId: user._id, username: user.username, displayName: user.displayName, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
          content: `🌉 **[${bridge.label || 'Bridge'}]** ${content?.trim() || ''}`,
          type: 'normal', reactions: {}, createdAt: Date.now(),
          bridgedFrom: { channelId, serverId },
        });
        io.to(`channel:${bridge.targetChannelId}`).emit('message:new', bMsg);
      }
    } catch { /* non-fatal */ }

    // @mention notifications
    const mentionIds: string[] = [];
    const newMentions = content?.match(/<@([a-zA-Z0-9_-]+)>/g);
    if (newMentions) mentionIds.push(...newMentions.map(m => m.slice(2, -1)));
    const oldMentions = content?.match(/@([a-zA-Z0-9_]+)/g);
    if (oldMentions) {
      const usernames = oldMentions.map(m => m.slice(1).toLowerCase());
      const found = await Users.findByUsernames(usernames);
      mentionIds.push(...found.map(u => u._id));
    }
    for (const uid of [...new Set(mentionIds)]) {
      if (uid === user._id) continue;
      const pref = await Notifications.findPref(uid, channelId);
      if (pref && pref.level === 'mute') continue;
      for (const [sid, su] of socketUsers) {
        if (su.id === uid) io.to(sid).emit('mention:received', { fromUser: sanitizeUser(user), channelId, serverId, messageId: msg._id, preview: content.slice(0, 80) });
      }
    }
  }

  socket.on('message:send',  (data) => sendChannelMessage(data));
  socket.on('message:reply', (data) => sendChannelMessage({ ...data, replyToId: data.replyToId }));

  socket.on('file:send', async ({ channelId, serverId, fileName, fileUrl, fileType }) => {
    if (!fileUrl || !fileName) return;
    if (!fileUrl.startsWith('/uploads/')) return;
    const safeFileName = String(fileName).replace(/[<>"']/g, '_').slice(0, 200);
    const membership = await Members.findOne(user._id, serverId);
    if (!membership) return;
    if (membership.timeoutUntil && membership.timeoutUntil > Date.now()) {
      socket.emit('error:timeout', { remaining: Math.ceil((membership.timeoutUntil - Date.now()) / 1000) });
      return;
    }
    const channel = await Channels.findByIdAndServer(channelId, serverId);
    if (!channel) return;
    const sendPerms = await getCachedPerms(user._id, serverId, resolvePermissions);
    if (!hasPermission(sendPerms, PERMS.SEND_MESSAGES)) return;
    const msg = await Messages.create({
      _id: uuidv4(), channelId, serverId, userId: user._id, username: user.username,
      displayName: user.displayName, avatarColor: user.avatarColor, avatarUrl: user.avatarUrl || null,
      content: '', type: 'file', fileName: safeFileName, fileUrl, fileType,
    });
    io.to(`channel:${channelId}`).emit('message:new', msg);
  });

  socket.on('message:pin', async ({ messageId, channelId, serverId }) => {
    const msg = await Messages.findById(messageId);
    if (!msg) return;
    const perms = await getCachedPerms(user._id, serverId, resolvePermissions);
    if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return;
    const pinned = !msg.pinned;
    await Messages.update(messageId, { pinned });
    io.to(`channel:${channelId}`).emit('message:pinned', { messageId, pinned });
  });

  socket.on('message:delete', async ({ messageId, channelId }) => {
    const msg = await Messages.findById(messageId);
    if (!msg) return;

    const perms = await getCachedPerms(user._id, msg.serverId, resolvePermissions);
    const canDelete = msg.userId === user._id || hasPermission(perms, PERMS.MANAGE_MESSAGES);
    if (!canDelete) return;

    // ── Atomic delete: mesaj + thread cascade + unread sayacı ────
    // Partial failure riski: mesaj silindi ama unread sayacı güncellenmedi gibi
    // durumları önlemek için tüm işlemler tek transaction'da yapılır.
    const db = getDb();
    const withTx = (db as any)?._transaction;

    try {
      if (typeof withTx === 'function') {
        // PostgreSQL — BEGIN / COMMIT / ROLLBACK garantisi
        await withTx(async (client) => {
          // 1. Thread varsa önce thread mesajlarını + thread kaydını sil
          if (msg.threadId) {
            await client.query('DELETE FROM thread_messages WHERE "threadId" = $1', [msg.threadId]);
            await client.query('DELETE FROM threads WHERE _id = $1', [msg.threadId]);
          }
          // 2. Ana mesajı sil
          await client.query('DELETE FROM messages WHERE _id = $1', [messageId]);
          // 3. unread_counts: bu kanalda silinen mesaj okunmamışsa sayacı düşür
          //    Kullanıcıların lastRead timestamp'inden sonra gelen mesajlar "okunmamış".
          //    Tek bir DELETE+UPDATE ile atomic yapıyoruz.
          await client.query(
            `UPDATE unread_counts
             SET count = GREATEST(0, count - 1), "updatedAt" = $1
             WHERE "channelId" = $2
               AND count > 0
               AND "userId" IN (
                 SELECT m."userId" FROM members m WHERE m."serverId" = $3
               )`,
            [Date.now(), channelId, msg.serverId]
          );
        });
      } else {
        // SQLite / mock (test ortamı) — senkron, transaction yoksa sıralı yap
        if (msg.threadId) {
          await Messages.deleteByChannel?.(msg.threadId);          // thread_messages
          const Threads = require('../../db/repositories/ThreadRepository');
          await Threads.delete(msg.threadId);
        }
        await Messages.delete(messageId);
      }
    } catch (err) {
      const logger = require('../../lib/logger');
      logger.error({ err: err.message, messageId, event: 'message.delete.tx.error' },
        'message:delete transaction failed — no changes committed');
      return; // client'a hata emit etme, sadece sessizce fail et
    }

    io.to(`channel:${channelId}`).emit('message:deleted', { id: messageId });
  });

  socket.on('message:edit', async ({ messageId, channelId, content }) => {
    if (!content?.trim() || content.length > 2000) return;
    const msg = await Messages.findById(messageId);
    if (!msg || msg.userId !== user._id) return;

    const history = Array.isArray(msg.editHistory) ? msg.editHistory : [];
    history.push({ content: msg.content, editedAt: msg.editedAt || msg.createdAt });
    const trimmedHistory = history.slice(-10);

    await Messages.update(messageId, { content: content.trim(), editedAt: Date.now(), editHistory: trimmedHistory });
    const updated = await Messages.findById(messageId);
    io.to(`channel:${channelId}`).emit('message:edited', updated);
  });

  socket.on('message:react', async ({ messageId, channelId, emoji }) => {
    if (!emoji || typeof emoji !== 'string' || emoji.length > 10) return;
    const msg = await Messages.findById(messageId);
    if (!msg) return;
    const membership = await Members.findOne(user._id, msg.serverId);
    if (!membership) return;

    const reactions = msg.reactions || {};
    const users     = reactions[emoji] || [];
    const idx       = users.indexOf(user._id);
    const added     = idx === -1;
    if (added) users.push(user._id); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;
    await Messages.update(messageId, { reactions });
    io.to(`channel:${channelId}`).emit('message:reaction', { messageId, reactions });

    // ── Reaction Role ────────────────────────────────────────
    try {
      const rules = await ReactionRoles.findByMessageAndEmoji(messageId, emoji);
      for (const rule of rules) {
        const member = await Members.findOne(user._id, rule.serverId);
        if (!member) continue;
        let roles = JSON.parse(member.roles || '[]');
        if (added) {
          if (!roles.includes(rule.roleId)) {
            roles.push(rule.roleId);
            await Members.setRoles(user._id, rule.serverId, roles);
            for (const [sid, su] of socketUsers) {
              if ((su._id || su.id) === user._id)
                io.to(sid).emit('role:granted', { serverId: rule.serverId, roleId: rule.roleId, emoji });
            }
          }
        } else {
          roles = roles.filter(r => r !== rule.roleId);
          await Members.setRoles(user._id, rule.serverId, roles);
          for (const [sid, su] of socketUsers) {
            if ((su._id || su.id) === user._id)
              io.to(sid).emit('role:revoked', { serverId: rule.serverId, roleId: rule.roleId, emoji });
          }
        }
      }
    } catch (err) { console.warn('[ReactionRole]', err.message); }
  });

  socket.on('typing:start', ({ channelId }) => socket.to(`channel:${channelId}`).emit('typing:update', { userId: user._id, displayName: user.displayName, typing: true }));
  socket.on('typing:stop',  ({ channelId }) => socket.to(`channel:${channelId}`).emit('typing:update', { userId: user._id, displayName: user.displayName, typing: false }));
}

// ── THREAD SOCKET EVENTS ──────────────────────────────────────
function registerThreadSocketEvents(socket, io, user) {
  // Real-time: broadcast new thread message to channel room
  socket.on('thread:message:new', ({ threadId, msg }) => {
    if (!threadId || !msg) return;
    // Broadcast to everyone in the parent channel so thread count updates
    if (msg.channelId) io.to(`channel:${msg.channelId}`).emit('thread:message:new', { threadId, msg });
    // Also broadcast to dedicated thread room
    io.to(`thread:${threadId}`).emit('thread:message:new', { threadId, msg });
  });

  socket.on('thread:join', (threadId) => {
    for (const room of socket.rooms) if (room.startsWith('thread:')) socket.leave(room);
    socket.join(`thread:${threadId}`);
  });

  socket.on('thread:leave', (threadId) => socket.leave(`thread:${threadId}`));
}

module.exports = { registerMessageHandlers, registerThreadSocketEvents, systemMsg, formatDuration };
export {};
