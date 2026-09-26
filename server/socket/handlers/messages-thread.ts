// server/socket/handlers/messages-thread.ts
// Thread socket event handler'ları — join, leave, yeni mesaj yayını.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.
// Sprint 118: try/catch ile hata yönetimi eklendi.

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import type { AuthUser } from './messages-types';
import logger from '../../lib/logger';
import { Threads, Members } from '../../db/repositories';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { isolateSocketHandler } from '../handlerIsolation';


export function registerThreadSocketEvents(
  socket: HandlerSocket,
  _io: HandlerServer,
  _user: AuthUser,
): void {
  // ── BAYAT ASENKRON JOIN KORUMASI ────────────────────────────────────────
  // Bu sayac BILDIRILMEMISTI. `++joinGeneration` her cagrildiginda
  // `ReferenceError: joinGeneration is not defined` firlatiyordu:
  //
  //   · `thread:join`  → hata `socket.join(...)` SATIRINDAN ONCE olusuyor,
  //     try/catch onu yutuyordu. Yani soket thread odasina HIC katilmiyordu
  //     ve `routes/threads.ts`'in `io.to('thread:<id>')` yayinlarini KIMSE
  //     almiyordu — gercek zamanli thread'ler tamamen olu idi.
  //   · `thread:leave` → hata `socket.leave(...)` SATIRINDAN ONCE olusuyordu.
  //
  // KAPSAM SOKET BASINADIR: `registerThreadSocketEvents` her baglanti icin bir
  // kez cagrilir. Modul duzeyinde tek bir sayac olsaydi bir kullanicinin join'i
  // BASKA bir kullanicinin ucustaki join'ini iptal ederdi.
  let joinGeneration = 0;

  // NOT: thread:message:new sunucu tarafında emit edilmeli; istemciden gelen event'ler
  // sahte mesaj içeriği enjekte etmek için kullanılabilir.
  // Bu handler, istemci tetiklemelerini reddeder — relay işlemi routes/threads.ts'de yapılır.
  socket.on('thread:message:new', isolateSocketHandler(socket, 'thread:message:new', () => {
    // Güvenlik: istemci bu eventi emit etmemeli. Sunucu, REST POST /threads/:id/messages
    // yanıtında doğrudan io.to() ile yayın yapar. Burada sessizce red.
    return;
  }));

  socket.on('thread:join', isolateSocketHandler(socket, 'thread:join', async (threadId: string) => {
    try {
      if (!threadId || typeof threadId !== 'string') return;
      const generation = ++joinGeneration;
      const thread = await Threads.findById(threadId);
      if (!thread) return;
      const member = await Members.findOne(_user._id, thread.serverId);
      if (!member) return;
      const perms = await resolvePermissions(_user._id, thread.serverId, thread.channelId).catch(() => 0);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.READ_HISTORY)) return;
      if (generation !== joinGeneration) return;
      for (const room of socket.rooms) {
        if (room.startsWith('thread:')) socket.leave(room);
      }
      socket.join(`thread:${threadId}`);
      socket.emit('thread:joined', { threadId });
    } catch (err) {
      logger.error({ event: 'thread.join.error', err, threadId }, 'thread:join hatası');
    }
  }));

  socket.on('thread:leave', isolateSocketHandler(socket, 'thread:leave', (threadId: string) => {
    try {
      if (!threadId || typeof threadId !== 'string') return;
      // Also cancels an in-flight join so leaving cannot be undone by a stale await.
      ++joinGeneration;
      socket.leave(`thread:${threadId}`);
    } catch (err) {
      logger.error({ event: 'thread.leave.error', err, threadId }, 'thread:leave hatası');
    }
  }));
}
