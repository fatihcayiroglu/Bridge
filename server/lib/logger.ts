import pino from 'pino';
import { requestContextMixin } from './requestContext';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export interface BridgeLogger {
  trace(objOrMsg?: unknown, msg?: string, ...args: unknown[]): void;
  debug(objOrMsg?: unknown, msg?: string, ...args: unknown[]): void;
  info(objOrMsg?: unknown, msg?: string, ...args: unknown[]): void;
  warn(objOrMsg?: unknown, msg?: string, ...args: unknown[]): void;
  error(objOrMsg?: unknown, msg?: string, ...args: unknown[]): void;
  fatal(objOrMsg?: unknown, msg?: string, ...args: unknown[]): void;
  child(bindings: Record<string, unknown>): BridgeLogger;
}

const pinoOptions = {
  level,
  base: {
    service: 'bridge-server',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // ── KORELASYON OTOMATİKTİR ────────────────────────────────────────────────
  // `mixin`, her günlük satırına yürürlükteki istek bağlamını ekler. Bu
  // bilinçli olarak ÇAĞIRAN TARAFI DEĞİŞTİRMEZ: mevcut yüzlerce
  // `logger.warn({ event })` çağrısı, tek satır kod değişmeden korelasyon
  // kimliğini taşımaya başlar.
  //
  // Elle parametre geçirmek yüzlerce imzayı değiştirir ve ilk unutulan yerde
  // zinciri sessizce koparır — bir olay sırasında fark edilmesi en zor
  // eksiklik budur.
  mixin: requestContextMixin,
};

// Pino's default asynchronous SonicBoom destination installs an exit handler
// through `on-exit-leak-free`. That is correct for a long-lived server, but a
// Jest worker may evaluate this module in many isolated module registries. Each
// isolated registry installs its own copy of the handler and the shared test
// process eventually emits MaxListenersExceededWarning. Use a synchronous
// destination only inside tests; a real production/default process keeps the
// asynchronous destination and its normal flush-on-exit lifecycle.
//
// The PostgreSQL integration harness deliberately sets NODE_ENV=production to
// exercise the real database loader, so JEST_WORKER_ID is the authoritative
// test-process signal for that suite.
const isTestProcess = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
const pinoLogger = isTestProcess
  ? pino(pinoOptions, pino.destination({ dest: process.stdout.fd || 1, sync: true }))
  : pino(pinoOptions);

const logger: BridgeLogger = pinoLogger as unknown as BridgeLogger;

/**
 * Child logger factory — belirli bir modül/bileşen için bağlamsal logger döndürür.
 * Kullanım: const log = createLogger('myModule');
 *           log.info({ event: 'foo' }, 'Bar happened');
 */
export function createLogger(component: string): BridgeLogger {
  return logger.child({ component });
}

export default logger;
