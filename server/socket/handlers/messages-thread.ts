// server/socket/handlers/messages-thread.ts
// Thread socket event handler'ları — join, leave, yeni mesaj yayını.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.
// Sprint 118: try/catch ile hata yönetimi eklendi.

import type { Server as IOServer, Socket } from 'socket.io';
import type { AuthUser } from './messages-types';
import logger from '../../lib/logger';
import { Threads, Members } from '../../db/repositories';

export function registerThreadSocketEvents(
  socket: Socket,
  io: IOServer,
  user: AuthUser,
): void {
  // İstemci bu eventi publish edemez; thread mesajları REST katmanından
  // oluşturulur ve yalnızca server tarafından broadcast edilir.
  socket.on('thread:message:new', () => undefined);

  socket.on('thread:join', async (threadId: string) => {
    try {
      if (!threadId || typeof threadId !== 'string' || threadId.length > 128) return;

      const thread = await Threads.findById(threadId);
      if (!thread?.serverId) return;

      // Kritik: socket client'ın istediği herhangi bir thread room'una
      // katılmasına izin verilmemeli. Önce server membership doğrulanır.
      const member = await Members.findOne(user._id, thread.serverId);
      if (!member) return;

      for (const room of socket.rooms) {
        if (room.startsWith('thread:')) socket.leave(room);
      }
      await socket.join(`thread:${thread._id}`);
    } catch (err) {
      logger.error({ event: 'thread.join.error', err, threadId }, 'thread:join hatası');
    }
  });

  socket.on('thread:leave', async (threadId: string) => {
    try {
      if (!threadId || typeof threadId !== 'string' || threadId.length > 128) return;

      // Leave işlemi için DB sorgusu gerekmese de yalnızca canonical room
      // adı kullanılır; istemci tarafından room prefix enjeksiyonu mümkün değil.
      socket.leave(`thread:${threadId}`);
    } catch (err) {
      logger.error({ event: 'thread.leave.error', err, threadId }, 'thread:leave hatası');
    }
  });
}
