// server/socket/handlers/dm-read.ts
// DM Okundu Bilgisi — WhatsApp/Telegram çift tik
// Olaylar: dm:read (client→server), dm:read-ack (server→karşı taraf)
// DB: dmConversations.readAt[userId] = timestamp  (mevcut koleksiyona patch)
//
// DÜZELTME: .js CJS karışımı → pure ESM TypeScript.
//           DmReadReceiptPayload tipi socket/contracts.ts'ten import ediliyor.
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';

import type { Server as IOServer, Socket } from 'socket.io';
import type { DmReadReceiptPayload } from '../contracts';
import db from '../../db/loader';
import logger from '../../lib/logger';

/** io'dan belirli userId'nin socket ID'lerini döner. */
function getUserSockets(io: IOServer, userId: string): string[] {
  const ids: string[] = [];
  try {
    const sockets = io.sockets.sockets;
    for (const [, s] of sockets) {
      const su = s as Socket & { userId?: string; user?: { _id: string } };
      if (su.userId === userId || su.user?._id === userId) ids.push(s.id);
    }
  } catch {
    // ignore – socket map erişim hatası
  }
  return ids;
}

/**
 * dmId için kullanıcının "son okunan" zamanını günceller,
 * diğer katılımcılara dm:read-ack gönderir.
 */
async function markRead(
  io: IOServer,
  dmId: string,
  userId: string,
): Promise<void> {
  if (!dmId || !userId) return;

  const conv = await db.dmConversations.findOne({ _id: dmId });
  if (!conv) return;

  // Güvenlik: kullanıcı bu konuşmanın katılımcısı mı?
  const participants: string[] = conv.participants ?? [];
  if (!participants.includes(userId)) return;

  const readAt: Record<string, number> = {
    ...(conv.readAt as Record<string, number> | undefined ?? {}),
    [userId]: Date.now(),
  };
  await db.dmConversations.update({ _id: dmId }, { $set: { readAt } });

  // Diğer katılımcılara bildir
  const others = participants.filter((p) => p !== userId);
  for (const otherId of others) {
    const otherSockets = getUserSockets(io, otherId);
    const payload: DmReadReceiptPayload = {
      dmId,
      readBy: userId,
      readAt: readAt[userId] ?? Date.now(),
    };
    for (const sid of otherSockets) {
      io.to(sid).emit('dm:read-ack', payload);
    }
  }
}

/** Socket handler kaydı. socket/index.ts içinden çağrılır. */
export function registerDmReadHandlers(
  socket: Socket & { user?: { _id: string } },
  io: IOServer,
  _user?: { _id: string },
): void {
  const userId = socket.user?._id;
  if (!userId) return;

  socket.on('dm:read', (payload: { dmId: string }) => {
    if (!validateSocketPayload(payload, socketSchemas.dmRead).valid) return;
    const { dmId } = payload;
    markRead(io, dmId, userId).catch((e: Error) =>
      logger.error({ err: e.message, dmId, event: 'dm_read.error' }, '[dm:read] işlem hatası'),
    );
  });
}

export { markRead };
