// server/socket/handlers/messages-types.ts
// Paylaşılan tip tanımları — messages, messages-send, messages-edit modülleri arasında ortak kullanım
// Sprint 107: messages.ts (505 satır) üç odaklanmış modüle ayrıldı.
// Sprint 118: uuid import ES module static'e çekildi; systemMsg try/catch ile güçlendirildi.

import type { Server as IOServer, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import logger from '../../lib/logger';

export interface SocketUser {
  _id?: string;
  id: string;
}

export interface AuthUser {
  _id: string;
  username: string;
  displayName?: string;
  avatarColor?: string;
  avatarUrl?: string | null;
}

export interface SendMessagePayload {
  channelId: string;
  content?: string;
  serverId: string;
  replyToId?: string;
  type?: string;
  fileUrl?: string;
  fileName?: string;
  fileType?: string;
  /** Sprint 89: E2EE kanal mesajı — server OPAK olarak saklar, içeriği açmaz */
  encryptedContent?: string; // base64 AES-GCM ciphertext
  /** Sprint 89: E2EE IV (12 byte, base64) */
  iv?: string;
  /** Sprint 89: Opt-in delivery ACK — client üretilen benzersiz ID */
  ackId?: string;
  /** Sprint 96: Optimistic render için client-side geçici ID */
  _tmpId?: string;
}

export interface MessageHandlerContext {
  socket: Socket;
  io: IOServer;
  user: AuthUser;
  socketUsers: Map<string, SocketUser>;
}

export function systemMsg(
  channelId: string,
  serverId: string,
  content: string,
): Record<string, unknown> {
  try {
    return {
      _id: uuidv4(), channelId, serverId,
      userId: 'system', username: 'Bridge Bot',
      displayName: '🤖 Bridge Bot', avatarColor: '#2d9cdb',
      content, type: 'system', reactions: {}, createdAt: Date.now(),
    };
  } catch (err) {
    logger.error({ event: 'systemMsg.error', err }, 'systemMsg üretimi başarısız');
    return { _id: 'err', channelId, serverId, content, type: 'system', createdAt: Date.now() };
  }
}

export function formatDuration(seconds: number): string {
  try {
    if (!seconds || typeof seconds !== 'number') return '?:??';
    const m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  } catch {
    return '?:??';
  }
}
