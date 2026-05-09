import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

/* eslint-disable @typescript-eslint/no-var-requires */
const { setupSocket }    = require('../socket') as { setupSocket: (io: SocketIOServer) => void };
const { initMediasoup }  = require('../socket/handlers/mediasoup') as { initMediasoup: () => Promise<boolean> };
const { applyAdapter }   = require('../lib/redisAdapter') as { applyAdapter: (io: SocketIOServer) => Promise<void> };
/* eslint-enable @typescript-eslint/no-var-requires */

export function createSocketServer(
  httpServer: HttpServer,
  allowedOrigins: string[]
): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    cors: { origin: allowedOrigins, methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e6,
  });

  initMediasoup().then((ok: boolean) => {
    if (ok) console.log('[Server] Mediasoup SFU aktif');
    else    console.log('[Server] Mediasoup kapali, P2P fallback aktif');
  });

  setupSocket(io);
  return io;
}

export async function setupSocketInfra(io: SocketIOServer): Promise<void> {
  await applyAdapter(io);
}
