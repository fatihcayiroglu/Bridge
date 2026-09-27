import logger from './logger';

type RevocableSocket = {
  emit(event: string, payload: unknown): unknown;
  disconnect(close?: boolean): unknown;
};

type SocketIoLike = {
  in(room: string): { fetchSockets(): Promise<RevocableSocket[]> };
};

/** Testable core: revoke all sockets currently joined to the canonical user room. */
export async function disconnectUserSockets(
  io: SocketIoLike | null | undefined,
  userId: string,
  reason: string,
): Promise<number> {
  if (!io || !userId) return 0;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const socket of sockets) {
    socket.emit('auth:revoked', { reason });
    socket.disconnect(true);
  }
  return sockets.length;
}

/**
 * Route-safe wrapper. Dynamic import avoids making auth routes a static owner
 * of the Socket.IO bootstrap while still enforcing immediate revocation.
 */
export async function disconnectLiveUserSessions(userId: string, reason: string): Promise<number> {
  try {
    const socketModule = await import('../socket');
    return await disconnectUserSockets(socketModule.getIo?.() as SocketIoLike | null, userId, reason);
  } catch (err) {
    logger.error({ event: 'session.socket_revocation_failed', userId, reason,
      err: err instanceof Error ? err.message : String(err) },
    'Server-side token revocation succeeded but live socket revocation failed');
    throw err;
  }
}
