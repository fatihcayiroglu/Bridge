// e2e/helpers/socket.ts — Socket.IO test yardımcıları
// Kullanım:
//   const alice = await openSocket(tokens.alice);
//   const event = await waitForEvent<VoiceUpdate>(bob, 'voice:room-update');
//   alice.disconnect();

import { io, Socket } from 'socket.io-client';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

/**
 * Kimlik doğrulamalı bir Socket.IO bağlantısı açar.
 * Bağlantı başarılı olana kadar bekler; hata olursa reject eder.
 */
export function openSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      auth:         { token },
      transports:   ['websocket'],
      reconnection: false,
      timeout:      8_000,
    });
    socket.once('connect',       () => resolve(socket));
    socket.once('connect_error', (err) => reject(err));
  });
}

/**
 * Belirtilen event gelene kadar bekler.
 * timeoutMs içinde gelmezse hata fırlatır.
 */
export function waitForEvent<T = unknown>(
  socket:    Socket,
  event:     string,
  timeoutMs  = 5_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timeout: "${event}" olayı ${timeoutMs}ms içinde gelmedi`)),
      timeoutMs,
    );
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Birden fazla socket'i tek seferde kapatır.
 */
export function closeSockets(...sockets: Socket[]): void {
  for (const s of sockets) {
    try { s.disconnect(); } catch { /* zaten kapalı */ }
  }
}
