// server/tests/jobs-gracefulShutdown.test.ts
// Sprint 98 — graceful shutdown: stop fonksiyonları interval'ı temizler mi?
process.env.NODE_ENV = 'test';

// ── Logger mock ───────────────────────────────────────────────────────────────
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
  },
}));

// ── DB / pool mock (sorgu yapmayacağız ama import gerekli) ────────────────────
const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [] });
jest.mock('../db/postgres/pool', () => ({
  pool:    { query: (...args: unknown[]) => mockPoolQuery(...args) },
  default: { query: (...args: unknown[]) => mockPoolQuery(...args) },
}));

// ── pushSender mock ───────────────────────────────────────────────────────────
jest.mock('../lib/pushSender', () => ({
  sendPushToUser: jest.fn().mockResolvedValue(undefined),
}));

// ── redisAdapter mock ─────────────────────────────────────────────────────────
jest.mock('../lib/redisAdapter', () => ({
  cache: {
    get:               jest.fn().mockResolvedValue(null),
    set:               jest.fn().mockResolvedValue(undefined),
    del:               jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
    increment:         jest.fn().mockResolvedValue(1),
  },
}));

// ── Socket.io mock ────────────────────────────────────────────────────────────
const mockIo = {
  to:   jest.fn().mockReturnThis(),
  emit: jest.fn(),
} as unknown as import('socket.io').Server;

// ─────────────────────────────────────────────────────────────────────────────
// Yardımcı: setInterval'ın kaç kez çağrıldığını kontrol etmek için spy
// ─────────────────────────────────────────────────────────────────────────────

import {
  startAutoModerationJob,
  stopAutoModerationJob,
} from '../jobs/autoModeration';

import {
  startScheduledJob,
  stopScheduledJob,
} from '../jobs/scheduledMessages';

import {
  startCleanupJob,
  stopCleanupJob,
} from '../jobs/cleanupUploads';

// ─────────────────────────────────────────────────────────────────────────────

describe('Graceful Shutdown — Job stop fonksiyonları', () => {

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  // ── AutoModeration ─────────────────────────────────────────────────────────

  describe('AutoModerationJob', () => {
    it('stopAutoModerationJob() ilk kez çağrılınca interval'ı temizler (hata atmaz)', () => {
      startAutoModerationJob(mockIo);
      expect(() => stopAutoModerationJob()).not.toThrow();
    });

    it('stopAutoModerationJob() idempotent: iki kez çağrılınca da hata atmaz', () => {
      startAutoModerationJob(mockIo);
      stopAutoModerationJob();
      expect(() => stopAutoModerationJob()).not.toThrow();
    });

    it('stop sonrası timer ilerlese bile çalışma fonksiyonu çağrılmaz', async () => {
      // automod scan her 5 dakikada bir çalışır; stop sonrası ilerlese
      // pool.query çağrısı olmamalı
      startAutoModerationJob(mockIo);
      stopAutoModerationJob();
      mockPoolQuery.mockClear();

      // 10 dakika geçir
      jest.advanceTimersByTime(10 * 60 * 1000);
      // Micro-task kuyruğunu boşalt
      await Promise.resolve();

      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  // ── ScheduledMessages ──────────────────────────────────────────────────────

  describe('ScheduledMessages Job', () => {
    it('stopScheduledJob() hata atmaz', () => {
      startScheduledJob(mockIo);
      expect(() => stopScheduledJob()).not.toThrow();
    });

    it('stopScheduledJob() idempotent', () => {
      startScheduledJob(mockIo);
      stopScheduledJob();
      expect(() => stopScheduledJob()).not.toThrow();
    });

    it('stop sonrası 60s geçse bile dispatch çağrılmaz', async () => {
      startScheduledJob(mockIo);
      stopScheduledJob();
      mockPoolQuery.mockClear();

      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  // ── CleanupUploads ─────────────────────────────────────────────────────────

  describe('CleanupUploads Job', () => {
    it('stopCleanupJob() hata atmaz', () => {
      startCleanupJob();
      expect(() => stopCleanupJob()).not.toThrow();
    });

    it('stopCleanupJob() idempotent', () => {
      startCleanupJob();
      stopCleanupJob();
      expect(() => stopCleanupJob()).not.toThrow();
    });

    it('stop sonrası 25 saat geçse bile cleanup çalışmaz', async () => {
      startCleanupJob();
      // İlk çalışma için 5dk'lık setTimeout geçir — temizleme bu anda yapılır
      // pool.query çağrılmış olabilir, onu temizle
      jest.advanceTimersByTime(5 * 60 * 1000);
      await Promise.resolve();
      mockPoolQuery.mockClear();

      stopCleanupJob();

      // 25 saat (cleanup interval = 24 saat)
      jest.advanceTimersByTime(25 * 60 * 60 * 1000);
      await Promise.resolve();

      expect(mockPoolQuery).not.toHaveBeenCalled();
    });
  });

  // ── Shutdown sırası: stop → start → stop ──────────────────────────────────

  describe('Restart senaryosu', () => {
    it('stop → start → stop döngüsü hata atmaz', () => {
      startAutoModerationJob(mockIo);
      stopAutoModerationJob();
      startAutoModerationJob(mockIo);
      expect(() => stopAutoModerationJob()).not.toThrow();
    });
  });
});
