// server/socket/middleware/wsConnectionLimit.ts
// Sprint 119: Tehdit modeli D5 — WebSocket bağlantı limitsizliği giderildi.
//
// Tek bir IP'den açılabilecek eş zamanlı WS bağlantı sayısını sınırlar.
// Socket.IO middleware olarak çalışır; io.use() ile bağlanır.
//
// Kullanım (server/socket/index.ts):
//   import { wsConnectionLimitMiddleware } from './middleware/wsConnectionLimit';
//   io.use(wsConnectionLimitMiddleware(io));

import type { Server, Socket } from 'socket.io';
import { createLogger } from '../../lib/logger';

const log = createLogger('wsConnectionLimit');

// Ortam değişkeninden al, varsayılan 10 (aynı IP'den max WS)
const MAX_WS_PER_IP = parseInt(process.env.MAX_WS_PER_IP || '10', 10);
// Kimlik doğrulanmamış bağlantılar için daha sıkı limit (D5 — env.ts'te de validate edilir)
const MAX_UNAUTH_WS_PER_IP = parseInt(process.env.MAX_UNAUTH_WS_PER_IP || '3', 10);
// Authenticated kullanıcı başına max bağlantı (çoklu sekme senaryosu)
const MAX_WS_PER_USER = parseInt(process.env.MAX_WS_PER_USER || '5', 10);

interface SocketWithUserId extends Socket {
  userId?: string;
}

/**
 * IP ve kullanıcı başına WS bağlantı sayısını sınırlayan middleware.
 * MAX_UNAUTH_WS_PER_IP: Kimlik doğrulanmamış bağlantılar için daha sıkı limit.
 * MAX_WS_PER_IP: Toplam (auth + unauth) IP başına üst sınır.
 * MAX_WS_PER_USER: Authenticated kullanıcı başına tab/cihaz limiti.
 */
export function wsConnectionLimitMiddleware(io: Server) {
  return (socket: SocketWithUserId, next: (err?: Error) => void) => {
    const ip = getClientIp(socket);

    // Aynı IP'den açık tüm bağlantıları al
    const sockets = [...io.sockets.sockets.values()] as SocketWithUserId[];
    const ipSockets = sockets.filter(s => getClientIp(s) === ip);
    const ipCount = ipSockets.length;

    // Toplam IP limiti kontrolü
    if (ipCount >= MAX_WS_PER_IP) {
      log.warn({ event: 'ws_limit_ip', ip, count: ipCount, limit: MAX_WS_PER_IP });
      return next(new Error('TOO_MANY_CONNECTIONS_FROM_IP'));
    }

    // Kimlik doğrulanmamış bağlantı limiti — JWT token yoksa unauth sayılır
    // Bu; bu middleware auth'dan ÖNCE çalıştığı için token varlığına bakıyoruz
    const hasToken = Boolean(socket.handshake.auth?.token);
    if (!hasToken) {
      const unauthCount = ipSockets.filter(s => !(s as SocketWithUserId).userId).length;
      if (unauthCount >= MAX_UNAUTH_WS_PER_IP) {
        log.warn({ event: 'ws_limit_unauth_ip', ip, count: unauthCount, limit: MAX_UNAUTH_WS_PER_IP });
        return next(new Error('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP'));
      }
    }

    // Auth tamamlandıktan sonra kullanıcı bazlı kontrol için hook.
    // Not: 'userAuthenticated' event'i socket/index.ts'deki connection bloğunda
    // socket.emit('userAuthenticated', user._id) ile tetiklenir.
    socket.once('userAuthenticated', (userId: string) => {
      if (!userId) return;

      // Taze anlık görüntü al — middleware zamanındaki eski listeyi değil
      const liveSockets = [...io.sockets.sockets.values()] as SocketWithUserId[];
      const userCount = liveSockets
        .filter(s => s.userId === userId && s.id !== socket.id)
        .length;

      if (userCount >= MAX_WS_PER_USER) {
        log.warn({
          event: 'ws_limit_user',
          userId,
          count: userCount,
          limit: MAX_WS_PER_USER,
        });
        // Eski bağlantıyı kapat (LIFO — en eski bağlantı korunur)
        const oldestSocket = liveSockets
          .filter(s => s.userId === userId && s.id !== socket.id)
          .sort((a, b) => {
            const ta = (a.handshake as unknown as { time?: number }).time ?? 0;
            const tb = (b.handshake as unknown as { time?: number }).time ?? 0;
            return ta - tb;
          })[0];

        if (oldestSocket) {
          log.info({
            event: 'ws_evict_oldest',
            userId,
            evictedId: oldestSocket.id,
          });
          oldestSocket.emit('error', { code: 'SESSION_REPLACED', message: 'Yeni bir sekme/cihazdan bağlandınız' });
          oldestSocket.disconnect(true);
        }
      }
    });

    log.debug({ event: 'ws_connect_allow', ip, ipCount });
    next();
  };
}

/**
 * Socket'ten gerçek istemci IP'sini alır.
 * HAProxy/nginx arkasında X-Forwarded-For'a bakar.
 * TRUSTED_PROXY_COUNT ortam değişkeni ile proxy sayısı ayarlanır (varsayılan: 1).
 * Tek proxy varsayımı ile ilk IP alınırsa IP spoofing riski doğar;
 * TRUSTED_PROXY_COUNT bu riski azaltır.
 */
const TRUSTED_PROXY_COUNT_WS = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '1', 10);

function getClientIp(socket: Socket): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const hops = forwarded.split(',').map(s => s.trim()).filter(Boolean);
    if (TRUSTED_PROXY_COUNT_WS === 0) {
      return socket.handshake.address || 'unknown';
    }
    // X-Forwarded-For: client, proxy1, proxy2 — güvenilen proxy sayısına göre gerçek client
    const clientIdx = hops.length - TRUSTED_PROXY_COUNT_WS;
    const ip = clientIdx >= 0 ? hops[clientIdx] : hops[0];
    return (ip || socket.handshake.address || 'unknown').replace(/^::ffff:/, '');
  }
  return (socket.handshake.address || 'unknown').replace(/^::ffff:/, '');
}
