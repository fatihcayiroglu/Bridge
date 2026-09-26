// server/app/setupSocket.ts
// Socket.IO sunucusunu kurar. Handler/SFU/Redis hazırlığı dinleme başlamadan
// önce setupSocketInfra tarafından tamamlanır.

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

export function createSocketServer(
  httpServer: HttpServer,
  allowedOrigins: string[],
): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors:              { origin: allowedOrigins, methods: ['GET', 'POST'] },
    transports:        ['websocket', 'polling'],
    maxHttpBufferSize: 1e6,
  });

  return io;
}

export async function setupSocketInfra(io: SocketIOServer): Promise<void> {
  const [{ setupSocket }, { initMediasoup }, { applyAdapter }, { default: logger }] = await Promise.all([
    import('../socket/index.js'),
    import('../socket/handlers/mediasoup/index.js'),
    import('../lib/redisAdapter.js'),
    import('../lib/logger.js'),
  ]);
  const adapterReady = await applyAdapter(io);
  if (process.env.REDIS_URL && !adapterReady) {
    throw new Error('Redis Socket.IO adapter is required when REDIS_URL is configured');
  }
  const sfuReady = await initMediasoup();
  if (sfuReady) logger.info({ event: 'mediasoup.start' }, '[Server] Mediasoup SFU aktif');
  else logger.info({ event: 'mediasoup.skip' }, '[Server] Mediasoup kapalı, P2P fallback aktif');
  setupSocket(io);
}
