// server/app/setupSocket.ts
// Socket.IO sunucusunu başlatır; mediasoup SFU'yu async olarak başlatır
// ve Redis adapter'ı uygular.

import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import logger from '../lib/logger';

export function createSocketServer(
  httpServer: HttpServer,
  allowedOrigins: string[],
): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors:              { origin: allowedOrigins, methods: ['GET', 'POST'] },
    transports:        ['websocket', 'polling'],
    maxHttpBufferSize: 1e6,
  });

  // Dynamic import — no-var-requires suppress'e gerek kalmaz,
  // projenin geri kalanındaki ESM/TS import stiliyle tutarlı.
  Promise.all([
    import('../socket/index.js'),
    import('../socket/handlers/mediasoup/index.js'),
  ]).then(([{ setupSocket }, { initMediasoup }]) => {
    initMediasoup()
      .then((ok: boolean) => {
        if (ok) logger.info({ event: 'mediasoup.start' }, '[Server] Mediasoup SFU aktif');
        else    logger.info({ event: 'mediasoup.skip'  }, '[Server] Mediasoup kapalı, P2P fallback aktif');
      })
      .catch((err: unknown) =>
        logger.error({ event: 'mediasoup.error', err }, '[Server] Mediasoup başlatma hatası'),
      );

    setupSocket(io);
  }).catch((err: unknown) =>
    logger.error({ event: 'socket.import.error', err }, '[Server] Socket modülleri yüklenemedi'),
  );

  return io;
}

export async function setupSocketInfra(io: SocketIOServer): Promise<void> {
  const { applyAdapter } = await import('../lib/redisAdapter.js');
  await applyAdapter(io);
}
