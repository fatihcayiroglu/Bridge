// client/js/core/logger.ts
// ─────────────────────────────────────────────────────────────
// Bridge istemci tarafı merkezi logger.
//
// Tasarım kararları:
//  1. Production'da (BRIDGE_ENV === 'production') yalnızca warn ve error
//     çıkışı yapılır. Log ve info çağrıları sessizce yutulur.
//  2. window.BRIDGE_DEBUG = true ile her ortamda debug çıkışı açılabilir.
//     Tarayıcı konsolunda: window.BRIDGE_DEBUG = true
//  3. Sentry entegrasyonu: error() çağrısı varsa window.errorBoundary.report()
//     aracılığıyla Sentry'ye de iletilir (çift raporlama yok — sadece
//     errorBoundary üzerinden geçen hatalar).
//  4. Prefix desteği: createLogger('WebRTC') → tüm çıktılar [WebRTC] önekiyle.
//  5. Bu modülde console kullanımı kasıtlı ve izinlidir — logger'ın kendisi
//     eslint-disable yorumuna gerek duymadan console'a yazar.
//  6. Seviye eşlemesi: debug→console.debug, log/info→console.log/info,
//     warn→console.warn, error→console.error (tarayıcı DevTools filtresiyle uyumlu).
// ─────────────────────────────────────────────────────────────

'use strict';

declare global {
  interface Window {
    BRIDGE_DEBUG?: boolean;
    BRIDGE_ENV?: string;
    errorBoundary: {
      report(error: unknown, context?: string): void;
      crash(error: unknown, context?: string): void;
      wrap<T extends unknown[], R>(fn: (...args: T) => R, context?: string): (...args: T) => R | undefined;
    };
  }
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function _isDebugEnabled(): boolean {
  return (
    typeof window !== 'undefined' &&
    (window.BRIDGE_DEBUG === true || window.BRIDGE_ENV !== 'production')
  );
}

function _shouldLog(level: LogLevel): boolean {
  if (level === 'error' || level === 'warn') return true;
  return _isDebugEnabled();
}

export interface BridgeLogger {
  debug(...args: unknown[]): void;
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

function _buildLogger(prefix: string): BridgeLogger {
  const tag = prefix ? `[${prefix}]` : '[Bridge]';

  return {
    debug(...args: unknown[]) {
      if (!_shouldLog('debug')) return;
      // eslint-disable-next-line no-console
      console.debug(tag, ...args);
    },
    log(...args: unknown[]) {
      if (!_shouldLog('info')) return;
      // eslint-disable-next-line no-console
      console.log(tag, ...args);
    },
    info(...args: unknown[]) {
      if (!_shouldLog('info')) return;
      // eslint-disable-next-line no-console
      console.info(tag, ...args);
    },
    warn(...args: unknown[]) {
      if (!_shouldLog('warn')) return;
      // eslint-disable-next-line no-console
      console.warn(tag, ...args);
    },
    error(first: unknown, ...rest: unknown[]) {
      if (!_shouldLog('error')) return;
      // eslint-disable-next-line no-console
      console.error(tag, first, ...rest);
      // Sentry entegrasyonu — sadece Error instance'ları iletilir
      if (
        first instanceof Error &&
        typeof window !== 'undefined' &&
        typeof window.errorBoundary?.report === 'function'
      ) {
        window.errorBoundary.report(first, prefix || 'client');
      }
    },
  };
}

/**
 * Prefixli logger oluşturur.
 *
 * @example
 *   import { createLogger } from './logger.ts';
 *   const log = createLogger('WebRTC');
 *   log.log('ICE config yüklendi');    // [WebRTC] ICE config yüklendi
 *   log.warn('Bağlantı kesildi');      // [WebRTC] Bağlantı kesildi
 *   log.error(new Error('Timeout'));   // [WebRTC] ... + Sentry raporu
 */
export function createLogger(prefix: string): BridgeLogger {
  return _buildLogger(prefix);
}

/** Prefixsiz varsayılan logger */
export const logger: BridgeLogger = _buildLogger('Bridge');
export default logger;
