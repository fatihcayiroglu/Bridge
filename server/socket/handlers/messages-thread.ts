// server/socket/handlers/messages-thread.ts
// Thread socket event handler'ları — join, leave, yeni mesaj yayını.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.
// Sprint 118: try/catch ile hata yönetimi eklendi.

import type { Server as IOServer, Socket } from 'socket.io';
import type { AuthUser } from './messages-types';
import logger from '../../lib/logger';
import { Threads } from '../../db/repositories';

export function registerThreadSocketEvents(
  socket: Socket,
  io: IOServer,
  _user: AuthUser,
): void {
  // NOT: thread:message:new sunucu tarafında emit edilmeli; istemciden gelen event'ler
  // sahte mesaj içeriği enjekte etmek için kullanılabilir.
  // Bu handler, istemci tetiklemelerini reddeder — relay işlemi routes/threads.ts'de yapılır.
  socket.on('thread:message:new', () => {
    // Güvenlik: istemci bu eventi emit etmemeli. Sunucu, REST POST /threads/:id/messages
    // yanıtında doğrudan io.to() ile yayın yapar. Burada sessizce red.
    return;
  });

  socket.on('thread:join', (threadId: string) => {
    try {
      if (!threadId || typeof threadId !== 'string') return;
      for (const room of socket.rooms) {
        if (room.startsWith('thread:')) socket.leave(room);
      }
      socket.join(`thread:${threadId}`);
    } catch (err) {
      logger.error({ event: 'thread.join.error', err, threadId }, 'thread:join hatası');
    }
  });

  socket.on('thread:leave', (threadId: string) => {
    try {
      if (!threadId || typeof threadId !== 'string') return;
      socket.leave(`thread:${threadId}`);
    } catch (err) {
      logger.error({ event: 'thread.leave.error', err, threadId }, 'thread:leave hatası');
    }
  });
}
