// @ts-nocheck
import 'dotenv/config';
import './lib/env'; // Ortam değişkeni doğrulama — hatalı config'de erken exit
import http from 'http';
import seed from './db/seed';
import db from './db/loader';
import { socketUsers, voiceRooms } from './socket';
import { authMiddleware } from './middleware/auth';
import logger from './lib/logger';
import { createApp } from './app/createApp';
import { setupRoutes } from './app/setupRoutes';
import { createSocketServer, setupSocketInfra } from './app/setupSocket';
import { startCleanupJob } from './jobs/cleanupUploads';
import { startScheduledJob } from './jobs/scheduledMessages';
import { startAutoModerationJob } from './jobs/autoModeration';
import { startFederationHeartbeat } from './jobs/federationHeartbeat';

import { loadPlugins, registerPluginListRoute } from './plugins/loader';

if (!process.env.JWT_SECRET) {
  logger.warn(
    { event: 'config.jwt_secret.missing' },
    'JWT_SECRET is not configured; development fallback will be used.'
  );
}

const { app, allowedOrigins } = createApp();
setupRoutes(app);
const server = http.createServer(app);
const io = createSocketServer(server, allowedOrigins);

registerPluginListRoute(app, authMiddleware);
loadPlugins(app, db, io).catch((e: Error) =>
  logger.error({ err: e, event: 'plugins.load.failed' }, 'Plugin loading failed.')
);

app.get('/api/voice/:channelId', authMiddleware, (req, res) => {
  res.json((voiceRooms as Record<string, unknown[]>)[req.params.channelId] || []);
});

app.get('/api/config', (_, res) =>
  res.json({
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB || '2048'),
    chunkSizeMB: parseInt(process.env.CHUNK_SIZE_MB || '5'),
    tenorEnabled: !!process.env.TENOR_API_KEY,
    translateEnabled: !!process.env.LIBRETRANSLATE_URL,
  })
);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((
  err: { status?: number; statusCode?: number; message?: string },
  req: import('express').Request,
  res: import('express').Response,
  _next: import('express').NextFunction
) => {
  const status = err.status || err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production' && status === 500
      ? 'Internal server error'
      : err.message || 'Internal server error';
  if (status >= 500) {
    logger.error(
      { err, status, path: req.originalUrl, method: req.method, event: 'http.request.failed' },
      'Unhandled request error.'
    );
  }
  res.status(status).json({ error: message });
});

const PORT = process.env.PORT || 3001;
app.set('io', io);
app.set('socketUsers', socketUsers);

async function start(): Promise<void> {
  const dbAny = db as { _initSchema?: () => Promise<void> };
  if (process.env.DATABASE_URL && dbAny._initSchema) await dbAny._initSchema();
  await seed();
  await setupSocketInfra(io);
  startCleanupJob();
  startScheduledJob(io);
  startAutoModerationJob(io);
  startFederationHeartbeat(db);
  server.listen(PORT, () =>
    logger.info({ port: PORT, db: 'PostgreSQL', event: 'server.started' }, 'Bridge server started.')
  );
}

start().catch((err: Error) => {
  logger.fatal({ err, event: 'server.start.failed' }, 'Server startup failed.');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason, event: 'process.unhandled_rejection' }, 'Unhandled promise rejection captured.');
});

process.on('uncaughtException', (err: Error) => {
  logger.fatal({ err, event: 'process.uncaught_exception' }, 'Uncaught exception captured, exiting process.');
  process.exit(1);
});

// ── Graceful Shutdown ─────────────────────────────────────────
let _shuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (_shuttingDown) return;
  _shuttingDown = true;
  logger.info({ signal, event: 'server.shutdown.start' }, 'Graceful shutdown initiated.');

  server.close(async () => {
    logger.info({ event: 'server.shutdown.http_closed' }, 'HTTP server closed.');

    try {
      await new Promise<void>((resolve) => {
        io.close(() => resolve());
        setTimeout(resolve, 3000);
      });
      logger.info({ event: 'server.shutdown.sockets_closed' }, 'Socket.IO connections closed.');
    } catch (err) {
      logger.warn({ err, event: 'server.shutdown.sockets_error' }, 'Socket.IO close error.');
    }

    try {
      const dbPool = db as { _pool?: { end: () => Promise<void> } };
      if (dbPool._pool && typeof dbPool._pool.end === 'function') {
        await dbPool._pool.end();
      }
    } catch { /* ignore db shutdown errors */ }

    logger.info({ event: 'server.shutdown.complete' }, 'Shutdown complete. Exiting.');
    process.exit(0);
  });

  setTimeout(() => {
    logger.fatal({ event: 'server.shutdown.forced' }, 'Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
export {};
