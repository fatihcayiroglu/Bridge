// server/tests/graceful-shutdown-live-sockets.test.ts
//
// Final21 Faz 19 — DÜZENLİ KAPANIŞ, BAĞLI İSTEMCİ VARKEN.
//
// Üretim imajında ölçüldü (tools/p19-prod-sim-p4b.sh): kapanış yalnızca `server.close()`
// çağırıyordu; tek bir bağlı Socket.IO istemcisi HTTP sunucusunun kapanmasını engelledi, süreç
// 10 sn sonra KOD 1 ile zorla çıktı ve istemci ancak süreç ölünce kopuşu gördü.
// Bu süit GERÇEK bir HTTP sunucusu, GERÇEK Socket.IO sunucusu ve GERÇEK bağlı istemciyle
// `createGracefulShutdown`un sözleşmesini ölçer.

import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import { Server as IOServer } from 'socket.io';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import { createGracefulShutdown } from '../lib/gracefulShutdown';

const log = { info: jest.fn(), warn: jest.fn() };

async function liveServer(): Promise<{ http: HttpServer; io: IOServer; url: string }> {
  const http = createServer((_req, res) => { res.end('ok'); });
  const io = new IOServer(http);
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
  return { http, io, url: `http://127.0.0.1:${(http.address() as AddressInfo).port}` };
}

async function connectedClient(url: string): Promise<ClientSocket> {
  const client = ioc(url, { transports: ['websocket'], reconnection: false });
  await new Promise<void>((resolve, reject) => { client.once('connect', () => resolve()); client.once('connect_error', reject); });
  return client;
}

beforeEach(() => { log.info.mockClear(); log.warn.mockClear(); });

describe('graceful shutdown with live Socket.IO clients', () => {
  it('exits 0 promptly, disconnects the client and stops accepting connections', async () => {
    const { io, url } = await liveServer();
    const client = await connectedClient(url);
    const disconnected = new Promise<string>((r) => client.once('disconnect', (reason) => r(reason)));
    const stopJobs = jest.fn();
    const exited = new Promise<{ code: number; ms: number }>((resolve) => {
      const t0 = Date.now();
      createGracefulShutdown({ io, stopJobs, log, timeoutMs: 5_000, exit: (code) => resolve({ code, ms: Date.now() - t0 }) })('SIGTERM');
    });

    const { code, ms } = await exited;
    expect(code).toBe(0);
    expect(ms).toBeLessThan(2_000);
    expect(stopJobs).toHaveBeenCalledTimes(1);
    expect(await disconnected).toBeTruthy();
    await expect(fetch(`${url}/`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
    expect(log.warn).not.toHaveBeenCalledWith('Graceful shutdown zaman aşımı — zorla çıkılıyor');
    client.close();
  });

  it('CONTROL: the previous sequence (HTTP server only) does NOT finish while a client is connected', async () => {
    const { http, io, url } = await liveServer();
    const client = await connectedClient(url);
    let closed = false;
    http.close(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 1_500));
    expect(closed).toBe(false);          // the defect: blocked by the live socket
    client.close();
    await io.close();
  });

  it('a second signal does not restart the shutdown', async () => {
    const { io } = await liveServer();
    const exit = jest.fn();
    const stopJobs = jest.fn();
    const shutdown = createGracefulShutdown({ io, stopJobs, log, exit, timeoutMs: 5_000 });
    shutdown('SIGTERM');
    shutdown('SIGINT');
    await new Promise((r) => setTimeout(r, 300));
    expect(stopJobs).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('keeps the forced-exit fallback (code 1) when closing hangs', async () => {
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      createGracefulShutdown({ io: { close: () => undefined }, stopJobs: () => undefined, log, exit, timeoutMs: 10_000 })('SIGTERM');
      jest.advanceTimersByTime(10_000);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the fallback defaults to 10 s when no timeout is configured', async () => {
    jest.useFakeTimers();
    try {
      const exit = jest.fn();
      createGracefulShutdown({ io: { close: () => undefined }, stopJobs: () => undefined, log, exit })('SIGTERM');
      jest.advanceTimersByTime(9_999);
      expect(exit).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('an HTTP server that was already closed is logged and still exits 0 (not the forced path)', async () => {
    const { http, io } = await liveServer();
    await new Promise<void>((r) => http.close(() => r()));
    const exit = jest.fn();
    await new Promise<void>((resolve) => {
      createGracefulShutdown({ io, stopJobs: () => undefined, log, timeoutMs: 5_000, exit: (code) => { exit(code); resolve(); } })('SIGTERM');
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(log.warn).toHaveBeenCalledWith({ err: expect.stringMatching(/not running/i) }, expect.any(String));
  });
});
