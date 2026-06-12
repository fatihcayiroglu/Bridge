// server/lib/sentry.ts
// Sprint 110 — Sentry error tracking entegrasyonu
//
// Kullanım:
//   import { captureException, captureMessage, setSentryUser } from './sentry';
//
// Yapılandırma (.env):
//   SENTRY_DSN=https://xxx@sentry.io/yyy          # boş ise Sentry devre dışı
//   SENTRY_ENVIRONMENT=production                  # varsayılan: NODE_ENV
//   SENTRY_RELEASE=bridge@1.0.0                   # opsiyonel
//   SENTRY_TRACES_SAMPLE_RATE=0.1                 # 0-1, varsayılan 0.05
//
// Self-host notları:
//   - Sentry DSN'si olmayan kurulumlar için sessizce devre dışı kalır.
//   - Kişisel veri göndermez; userId hashlenerek gönderilir.

import * as crypto from 'crypto';

// ── Tip tanımları ──────────────────────────────────────────────────────────

interface SentryInstance {
  init: (opts: Record<string, unknown>) => void;
  captureException: (err: unknown, ctx?: Record<string, unknown>) => string;
  captureMessage: (msg: string, level?: string) => string;
  setUser: (user: { id: string } | null) => void;
  withScope: (cb: (scope: SentryScope) => void) => void;
  flush: (timeout?: number) => Promise<boolean>;
}

interface SentryScope {
  setExtra: (key: string, val: unknown) => void;
  setTag: (key: string, val: string) => void;
}

// ── Durum ─────────────────────────────────────────────────────────────────

let _sentry: SentryInstance | null = null;
let _enabled = false;

// ── Başlat ────────────────────────────────────────────────────────────────

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[sentry] SENTRY_DSN tanımlı değil — hata izleme devre dışı.');
    }
    return;
  }

  try {
    // Dynamic import — Sentry paketi opsiyonel bağımlılıktır
     
    const Sentry = require('@sentry/node') as SentryInstance;

    Sentry.init({
      dsn,
      environment:        process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
      release:            process.env.SENTRY_RELEASE,
      tracesSampleRate:   parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.05'),
      // Kişisel veri filtresi
      beforeSend(event: Record<string, unknown>) {
        // request.cookies ve auth header'larını temizle
        if (event.request && typeof event.request === 'object') {
          const req = event.request as Record<string, unknown>;
          if (req.cookies)                    delete req.cookies;
          if (req.headers && typeof req.headers === 'object') {
            const h = req.headers as Record<string, unknown>;
            delete h['authorization'];
            delete h['cookie'];
          }
        }
        return event;
      },
    });

    _sentry  = Sentry;
    _enabled = true;
    console.info('[sentry] Başlatıldı:', process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV);
  } catch (err) {
    console.warn('[sentry] @sentry/node paketi bulunamadı — devre dışı:', (err as Error).message);
  }
}

// ── Kullanıcı kimliği (hashlenerek) ───────────────────────────────────────

export function setSentryUser(userId: string | null): void {
  if (!_enabled || !_sentry) return;
  if (!userId) {
    _sentry.setUser(null);
    return;
  }
  // Ham userId gönderme — SHA-256 hash ile anonimleştir
  const hashed = crypto.createHash('sha256').update(userId).digest('hex').slice(0, 16);
  _sentry.setUser({ id: hashed });
}

// ── Hata yakalama ─────────────────────────────────────────────────────────

export function captureException(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (!_enabled || !_sentry) {
    if (process.env.NODE_ENV !== 'test') console.error('[sentry:captureException]', err);
    return;
  }
  _sentry.withScope((scope: SentryScope) => {
    if (context) {
      for (const [k, v] of Object.entries(context)) {
        if (typeof v === 'string') scope.setTag(k, v);
        else                       scope.setExtra(k, v);
      }
    }
    _sentry!.captureException(err);
  });
}

export function captureMessage(
  message: string,
  level: 'info' | 'warning' | 'error' = 'info',
): void {
  if (!_enabled || !_sentry) return;
  _sentry.captureMessage(message, level);
}

// ── Express hata middleware (kullanım: app.use(sentryErrorHandler)) ───────

export function sentryErrorHandler() {
  return (
    err: Error,
    _req: unknown,
    _res: unknown,
    next: (err: Error) => void,
  ): void => {
    captureException(err);
    next(err);
  };
}

// ── Graceful shutdown ─────────────────────────────────────────────────────

export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!_enabled || !_sentry) return;
  try { await _sentry.flush(timeoutMs); } catch { /* ignore */ }
}

export const sentryEnabled = (): boolean => _enabled;
