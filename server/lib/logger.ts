import pino from 'pino';

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

const pinoLogger = pino({
  level,
  base: {
    service: 'bridge-server',
    env: process.env.NODE_ENV || 'development',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

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
