// server/runtime.ts
// Sprint 38: require() karışımı → ES import (Sprint 33+ TypeScript altyapısıyla uyumlu)
// Önceki: 8 adet eslint-disable-next-line @typescript-eslint/no-var-requires
// Sonraki: sıfır disable comment, tam tip güvenliği

import './lib/env';
import './lib/telemetry'; // OTel + Sentry — auto-instrumentation için en erken init

import http from 'http';
import type { Server as SocketServer } from 'socket.io';

// ── DB & Seed ────────────────────────────────────────────────────────────────
import db from './db/loader';
import seed from './db/seed';
import { seedMarketplace } from './db/seed-marketplace'; // canonical marketplace seed owner

// ── Socket ───────────────────────────────────────────────────────────────────
import { socketUsers, voiceRooms } from './socket';

// ── Logger ───────────────────────────────────────────────────────────────────
import logger from './lib/logger';
import { reportLimits } from './lib/limitsReport';
import { getPrivateStorageAdapter, getStorageAdapter } from './lib/storageAdapter';

// ── Jobs ─────────────────────────────────────────────────────────────────────
import { startCleanupJob, stopCleanupJob }        from './jobs/cleanupUploads';
import { startChunkSessionSweeper, stopChunkSessionSweeper } from './jobs/chunkSessionSweeper';
import { startNodeLiveness, stopNodeLiveness } from './lib/nodeLiveness';
import { startScheduledJob, stopScheduledJob }      from './jobs/scheduledMessages';
import { startAutoModerationJob, stopAutoModerationJob } from './jobs/autoModeration';
import { startFederationHeartbeat, stopFederationHeartbeat } from './jobs/federationHeartbeat';
import { startEventReminderJob, stopEventReminderJob } from './jobs/eventReminders';
import { startSavedMessageReminderJob, stopSavedMessageReminderJob } from './jobs/savedMessageReminders';
import { startOutgoingWebhookDeliveryJob, stopOutgoingWebhookDeliveryJob } from './routes/outgoingWebhooks';
// Sprint 120: A4 — pgvector geçmiş mesaj batch embed job kayıt altına alındı
import { scheduleEmbedHistoryJob, cancelEmbedHistoryJob } from './jobs/embedHistory';

// ── App ──────────────────────────────────────────────────────────────────────
import { authMiddleware, startAuthCleanup, stopAuthCleanup }     from './middleware/auth';
import { createApp }                            from './app/createApp';
import { pluginRouterOf, setupRoutes }          from './app/setupRoutes';
import { createSocketServer, setupSocketInfra } from './app/setupSocket';
import { loadPlugins, registerPluginListRoute } from './plugins/loader';
import { envSafeInt } from './lib/envNumbers';
import { createGracefulShutdown } from './lib/gracefulShutdown';

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
app.set('io', io);
const pluginRouter = pluginRouterOf(app);
registerPluginListRoute(pluginRouter, authMiddleware);

const PORT = envSafeInt('PORT', 3000, { min: 1, max: 65_535 });
const HOST = process.env.HOST ?? '0.0.0.0';

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  // Validate storage configuration before DB/job/listener startup. A remote
  // private/public bucket typo must fail at boot, not after the first upload.
  // Construction performs credential/bucket isolation checks without network IO.
  getStorageAdapter();
  getPrivateStorageAdapter();
  const pgDb = db as { _initSchema?: () => Promise<void> };
  if (typeof pgDb._initSchema === 'function') {
    await pgDb._initSchema();
  }
  await setupSocketInfra(io);
  await seed();
  await seedMarketplace(); // idempotent marketplace catalog seed
  await loadPlugins(pluginRouter, db, io, authMiddleware);

  startCleanupJob();
  startChunkSessionSweeper();
  startNodeLiveness();
  startAuthCleanup();
  startScheduledJob(io);
  startAutoModerationJob(io);
  startEventReminderJob();
  startSavedMessageReminderJob();
  startFederationHeartbeat();
  startOutgoingWebhookDeliveryJob();
  // Sprint 120: A4 — pgvector geçmiş mesaj embed job'u (her gün 03:00 UTC)
  scheduleEmbedHistoryJob(db._pool);

  server.listen(PORT, HOST, () => {
    logger.info({ event: 'server.start', port: PORT, host: HOST }, `Bridge listening on ${HOST}:${PORT}`);
    // Katmanli sinirlar TEK BIR YERDE gorunur olsun (operator kesfedilebilirligi).
    reportLimits();

    // CALISMA-ZAMANI VERITABANI AYRICALIGI: bu kurulumda rol SUPERUSER olarak
    // olculdu. Uygulamanin ihtiyaci yalnizca CRUD'dur; fazlasi ele gecirilmis
    // bir surece tum kumeyi ve `COPY TO PROGRAM` ile kabuk erisimi verir.
    // En az ayricalik modeli kanitlandi: scripts/db-least-privilege-proof.cjs
    void (async () => {
      try {
        const { pool } = await import('./db/postgres/pool');
        const { checkDbPrivileges } = await import('./lib/dbPrivilegeCheck');
        await checkDbPrivileges((sql: string) => pool.query(sql));
      } catch { /* teshis araci onyuklemeyi bozmaz */ }
    })();
  });
}

bootstrap().catch((err: Error) => {
  logger.fatal({ event: 'server.boot_error', err }, 'Bootstrap failed');
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// SIGTERM: Kubernetes pod sonlandırma, `docker stop`
// SIGINT:  Ctrl-C (geliştirme ortamı)
// Socket.IO kapatılmadan HTTP sunucusu kapanamıyordu: bağlı tek bir istemci bile kapanışı
// zorlamaya (kod 1) düşürüyordu (Final21 Faz 19; lib/gracefulShutdown.ts).
const gracefulShutdown = createGracefulShutdown({
  io,
  stopJobs: () => {
    stopAuthCleanup();
    stopEventReminderJob();
    stopSavedMessageReminderJob();
    stopFederationHeartbeat();   // Sprint 97: zaten vardı
    stopOutgoingWebhookDeliveryJob();
    stopAutoModerationJob();     // Sprint 98
    stopScheduledJob();          // Sprint 98
    stopCleanupJob();            // Sprint 98
    stopChunkSessionSweeper();
    stopNodeLiveness();
    cancelEmbedHistoryJob();     // Sprint 120: A4
  },
  exit: (code) => process.exit(code),
  log: logger,
});

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

export { socketUsers, voiceRooms, authMiddleware };
