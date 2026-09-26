import logger from '../lib/logger';

interface EmittingSocket {
  emit(event: string, ...args: unknown[]): unknown;
}

/**
 * Isolate a Socket.IO listener from rejected async work.
 *
 * Socket.IO/EventEmitter does not await the promise returned by an async
 * listener. A repository/Redis/storage rejection can therefore become an
 * unhandled rejection unless every listener remembers its own try/catch.
 * Centralize that process-safety contract here.
 */
export function isolateSocketHandler<A extends unknown[]>(
  socket: EmittingSocket,
  event: string,
  handler: (...args: A) => unknown | Promise<unknown>,
): (...args: A) => Promise<void> {
  const report = (err: unknown, args: A): void => {
    const payload = args[0] as { ackId?: unknown; _tmpId?: unknown; clientNonce?: unknown } | undefined;
    const ackId = typeof payload?.ackId === 'string' ? payload.ackId : undefined;
    const tmpId = typeof payload?._tmpId === 'string' ? payload._tmpId : undefined;
    const clientNonce = typeof payload?.clientNonce === 'string' && payload.clientNonce.length <= 64
      ? payload.clientNonce : undefined;
    logger.error({ event: `socket.${event}.failed`, err }, `[socket] ${event} işlenemedi`);
    socket.emit('error:message', {
      event,
      message: 'İşlem tamamlanamadı. Lütfen tekrar dene.',
      ...(ackId ? { ackId } : {}),
      ...(tmpId ? { tmpId } : {}),
      ...(clientNonce ? { clientNonce } : {}),
    });
  };

  return (...args: A): Promise<void> => {
    try {
      return Promise.resolve(handler(...args)).then(() => undefined).catch((err: unknown) => report(err, args));
    } catch (err) {
      report(err, args);
      return Promise.resolve();
    }
  };
}
