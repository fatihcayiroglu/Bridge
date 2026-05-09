// server/socket/handlers/dm-read.js
// DM Okundu Bilgisi — WhatsApp/Telegram çift tik
// Olaylar: dm:read (client→server), dm:read-ack (server→karşı taraf)
// DB: dmConversations.readAt[userId] = timestamp  (mevcut koleksiyona patch)

'use strict';

const db = require('../../db/loader');

/**
 * dmId için kullanıcının "son okunan" zamanını güncelle,
 * diğer katılımcılara dm:read-ack gönder.
 */
async function markRead(socket, io, { dmId, userId }) {
  if (!dmId || !userId) return;

  const conv = await db.dmConversations.findOne({ _id: dmId });
  if (!conv) return;

  // Güvenlik: kullanıcı bu konuşmanın katılımcısı mı?
  if (!(conv.participants || []).includes(userId)) return;

  const readAt = { ...(conv.readAt || {}), [userId]: Date.now() };
  await db.dmConversations.update({ _id: dmId }, { $set: { readAt } });

  // Diğer katılımcılara bildir
  const others = (conv.participants || []).filter(p => p !== userId);
  for (const otherId of others) {
    const otherSockets = getUserSockets(io, otherId);
    for (const sid of otherSockets) {
      io.to(sid).emit('dm:read-ack', {
        dmId,
        readBy:  userId,
        readAt:  readAt[userId],
      });
    }
  }
}

/**
 * io'dan belirli userId'nin socket ID'lerini döner.
 * Socket'lerde socket.userId set edilmiş olmalı (auth.js'te yapılıyor).
 */
function getUserSockets(io, userId) {
  const ids: string[] = [];
  try {
    const sockets = io.sockets.sockets;
    for (const [, s] of sockets) {
      if (s.userId === userId || s.user?._id === userId) ids.push(s.id);
    }
  } catch (_) {}
  return ids;
}

function registerDmReadHandlers(socket, io, user) {
  socket.on('dm:read', ({ dmId }) => {
    markRead(socket, io, { dmId, userId: user._id }).catch(e =>
      console.error('[dm:read] error:', e.message)
    );
  });
}

module.exports = { registerDmReadHandlers, markRead };
export {};
