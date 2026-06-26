// server/index.ts
// Sprint 38: require() karışımı → ES import (Sprint 33+ TypeScript altyapısıyla uyumlu)
// Önceki: 8 adet eslint-disable-next-line @typescript-eslint/no-var-requires
// Sonraki: sıfır disable comment, tam tip güvenliği

import 'dotenv/config';
import './lib/env';
import './lib/telemetry'; // OTel + Sentry — auto-instrumentation için en erken init

import http from 'http';
import type { Server as SocketServer } from 'socket.io';

// ── DB & Seed ────────────────────────────────────────────────────────────────
import db from './db/loader';
import seed from './db/seed';
import { ensureMarketplaceSeed } from './routes/bot-marketplace'; // Sprint 83

// ── Socket ───────────────────────────────────────────────────────────────────
import { setupSocket, socketUsers, voiceRooms } from './socket';

// ── Logger ───────────────────────────────────────────────────────────────────
import logger from './lib/logger';

// ── Jobs ─────────────────────────────────────────────────────────────────────
import { startCleanupJob, stopCleanupJob }        from './jobs/cleanupUploads';
import { startScheduledJob, stopScheduledJob }      from './jobs/scheduledMessages';
import { startAutoModerationJob, stopAutoModerationJob } from './jobs/autoModeration';
import { startFederationHeartbeat, stopFederationHeartbeat } from './jobs/federationHeartbeat';
import { startEventReminderJob, stopEventReminderJob } from './jobs/eventReminders';
// Sprint 120: A4 — pgvector geçmiş mesaj batch embed job kayıt altına alındı
import { scheduleEmbedHistoryJob, cancelEmbedHistoryJob } from './jobs/embedHistory';

// ── App ──────────────────────────────────────────────────────────────────────
import { authMiddleware, startAuthCleanup, stopAuthCleanup }     from './middleware/auth';
import { createApp }                            from './app/createApp';
import { setupRoutes }                          from './app/setupRoutes';
import { createSocketServer, setupSocketInfra } from './app/setupSocket';
import { loadPlugins, registerPluginListRoute } from './plugins/loader';

// ── Güvenlik: JWT_SECRET erken kontrol ──────────────────────────────────────
// Detaylı doğrulama lib/env.ts içinde yapılır; bu blok açık bir hata mesajı için.
if (!process.env.JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    logger.error('[FATAL] JWT_SECRET is not set. Refusing to start in production without a secret.');
    process.exit(1);
  }
  logger.warn(
    { event: 'config.jwt_secret.missing' },
    'JWT_SECRET is not configured; development fallback will be used.',
  );
}

// ── Express App ──────────────────────────────────────────────────────────────
const { app, allowedOrigins } = createApp();
setupRoutes(app);

const server = http.createServer(app);
const io: SocketServer = createSocketServer(server, allowedOrigins);
registerPluginListRoute(app, authMiddleware);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  const pgDb = db as { _initSchema?: () => Promise<void> };
  if (typeof pgDb._initSchema === 'function') {
    await pgDb._initSchema();
  }
  await setupSocketInfra(io);
  await seed();
  await ensureMarketplaceSeed(); // Sprint 83: bot marketplace seed
  await loadPlugins(app, db, io);

  startCleanupJob();
  startAuthCleanup();
  startScheduledJob(io);
  startAutoModerationJob(io);
  startEventReminderJob();
  startFederationHeartbeat();
  // Sprint 120: A4 — pgvector geçmiş mesaj embed job'u (her gün 03:00 UTC)
  scheduleEmbedHistoryJob(db as unknown as { query<T extends object = object>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> });

  server.listen(PORT, HOST, () => {
    logger.info({ event: 'server.start', port: PORT, host: HOST }, `Bridge listening on ${HOST}:${PORT}`);
  });
}

bootstrap().catch((err: Error) => {
  logger.fatal({ event: 'server.boot_error', err }, 'Bootstrap failed');
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// SIGTERM: Kubernetes pod sonlandırma, `docker stop`
// SIGINT:  Ctrl-C (geliştirme ortamı)
function gracefulShutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown sinyali alındı, kapatılıyor...');
  stopAuthCleanup();
  stopEventReminderJob();
  stopFederationHeartbeat();   // Sprint 97: zaten vardı
  stopAutoModerationJob();     // Sprint 98
  stopScheduledJob();          // Sprint 98
  stopCleanupJob();            // Sprint 98
  cancelEmbedHistoryJob();     // Sprint 120: A4
  server.close(() => {
    logger.info('HTTP server kapatıldı. Çıkılıyor.');
    process.exit(0);
  });
  // 10 saniye içinde kapanmazsa zorla çık
  setTimeout(() => {
    logger.warn('Graceful shutdown zaman aşımı — zorla çıkılıyor');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

export { socketUsers, voiceRooms, authMiddleware };
