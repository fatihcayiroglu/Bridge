// server/socket/handlers/messages.ts
// Barrel export — geriye dönük uyumluluk için tüm public sembolleri yeniden dışa aktarır.
//
// Sprint 107: Bu dosya 505 satırdan 4 odaklanmış modüle ayrıldı:
//   messages-types.ts  → paylaşılan tip tanımları + yardımcı fonksiyonlar
//   messages-send.ts   → mesaj/dosya gönderme, ACK, E2EE, link önizleme, bridge forwarding
//   messages-edit.ts   → düzenleme, silme, pin, reaksiyon, reaction-role
//   messages-thread.ts → thread socket events (join/leave/new)
//
// Mevcut import'lar değişmeden çalışmaya devam eder:
//   import { registerMessageHandlers, systemMsg, formatDuration } from './messages';

import type { Server as IOServer, Socket } from 'socket.io';
import type { AuthUser, SocketUser } from './messages-types';
import { systemMsg, formatDuration } from './messages-types';
import { registerSendHandlers } from './messages-send';
import { registerEditHandlers } from './messages-edit';
import { registerThreadSocketEvents } from './messages-thread';

export { systemMsg, formatDuration };
export { registerThreadSocketEvents };

/**
 * registerMessageHandlers — tüm mesaj socket event handler'larını kaydeder.
 * socket/index.ts'teki kullanım değişmez.
 */
export function registerMessageHandlers(
  socket: Socket,
  io: IOServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>,
): void {
  registerSendHandlers(socket, io, user, socketUsers);
  registerEditHandlers(socket, io, user, socketUsers);
}
