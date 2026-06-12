// server/tests/chess-socket.test.ts
// Sprint 85 fix: registerChessHandlers socket entegrasyon testleri.
// Unit testler (chess-arbiter.test.ts) _internal logic'i kapsar;
// bu dosya socket katmanını — chess:join → chess:move → chess:resign akışını — test eder.
//
// Sprint 86 fix: waitFor Promise<any> → Promise<unknown>; port cast kaldırıldı.

import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Server as IOServer } from 'socket.io';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { registerChessHandlers } from '../socket/handlers/activities/chess-arbiter';
import { chessStore } from '../socket/handlers/activities/chess-store';
import type { GameState } from '../socket/handlers/activities/chess-types';

// ── Helpers ───────────────────────────────────────────────────

function waitFor(socket: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

// ── Setup ─────────────────────────────────────────────────────

let httpServer: ReturnType<typeof createServer>;
let ioServer: IOServer;
let clientA: ClientSocket;
let clientB: ClientSocket;
let port: number;

beforeAll((done) => {
  httpServer = createServer();
  ioServer   = new IOServer(httpServer);

  ioServer.on('connection', (socket) => {
    const userId = socket.handshake.auth.userId as string;
    registerChessHandlers(socket, ioServer, userId);
  });

  httpServer.listen(0, () => {
    port = (httpServer.address() as AddressInfo).port;

    clientA = ioc(`http://localhost:${port}`, { auth: { userId: 'userA' }, forceNew: true });
    clientB = ioc(`http://localhost:${port}`, { auth: { userId: 'userB' }, forceNew: true });

    let connected = 0;
    const onConnect = () => { if (++connected === 2) done(); };
    clientA.on('connect', onConnect);
    clientB.on('connect', onConnect);
  });
});

afterAll((done) => {
  clientA.disconnect();
  clientB.disconnect();
  ioServer.close(() => httpServer.close(done));
});

afterEach(() => {
  chessStore._clearMemGames_TEST_ONLY();
});

// ── Testler ───────────────────────────────────────────────────

describe('chess:join', () => {
  it('ilk katılan beyaz olarak chess:joined alır', async () => {
    clientA.emit('chess:join', { channelId: 'ch-join-1' });
    const joined = await waitFor(clientA, 'chess:joined') as { color: string; state: GameState };
    expect(joined.color).toBe('w');
    expect(joined.state.whiteUserId).toBe('userA');
  });

  it('ikinci katılan siyah olur, chess:started tüm kanala yayılır', async () => {
    clientA.emit('chess:join', { channelId: 'ch-join-2' });
    await waitFor(clientA, 'chess:joined');

    const startedPromise = waitFor(clientA, 'chess:started');
    clientB.emit('chess:join', { channelId: 'ch-join-2' });
    const started = await startedPromise as { state: GameState };

    expect(started.state.whiteUserId).toBe('userA');
    expect(started.state.blackUserId).toBe('userB');
  });

  it('tekrar bağlanan oyuncu chess:state alır', async () => {
    clientA.emit('chess:join', { channelId: 'ch-join-3' });
    await waitFor(clientA, 'chess:joined');

    // Tekrar join
    clientA.emit('chess:join', { channelId: 'ch-join-3' });
    const state = await waitFor(clientA, 'chess:state') as { color: string };
    expect(state.color).toBe('w');
  });
});

describe('chess:resign', () => {
  it('beyaz istifa ederse siyah kazanır, chess:game_over emit edilir', async () => {
    const ch = 'ch-resign-1';
    clientA.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:joined');
    clientB.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:started');

    const gameOverPromise = waitFor(clientA, 'chess:game_over');
    clientA.emit('chess:resign', { channelId: ch });
    const over = await gameOverPromise as { result: string; reason: string };

    expect(over.result).toBe('b');
    expect(over.reason).toMatch(/teslim/i);
  });

  it('aynı anda iki resign isteği tek game_over emit eder', async () => {
    const ch = 'ch-resign-race';
    clientA.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:joined');
    clientB.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:started');

    let count = 0;
    const countListener = () => count++;
    clientA.on('chess:game_over', countListener);

    // İki eş zamanlı resign
    clientA.emit('chess:resign', { channelId: ch });
    clientA.emit('chess:resign', { channelId: ch });

    await new Promise((r) => setTimeout(r, 200));
    expect(count).toBe(1);
    clientA.off('chess:game_over', countListener);
  });
});

describe('chess:draw_accept', () => {
  it('beraberlik kabul edilince draw sonucu gelir', async () => {
    const ch = 'ch-draw-1';
    clientA.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:joined');
    clientB.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:started');

    clientA.emit('chess:draw_offer', { channelId: ch });
    const gameOverPromise = waitFor(clientA, 'chess:game_over');
    clientB.emit('chess:draw_accept', { channelId: ch });
    const over = await gameOverPromise as { result: string };

    expect(over.result).toBe('draw');
  });
});

describe('chess:move', () => {
  it('geçersiz hamle chess:invalid döndürür', async () => {
    const ch = 'ch-move-invalid';
    clientA.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:joined');
    clientB.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:started');

    const invalidPromise = waitFor(clientA, 'chess:invalid');
    clientA.emit('chess:move', { channelId: ch, from: 'e2', to: 'e5' }); // 3 kare atlama
    const invalid = await invalidPromise as { reason: string };
    expect(invalid.reason).toBeTruthy();
  });

  it('sırası olmayan oyuncu hamle yapamaz', async () => {
    const ch = 'ch-move-turn';
    clientA.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:joined');
    clientB.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:started');

    // Siyah (clientB) ilk hamleyi yapmaya çalışır
    const invalidPromise = waitFor(clientB, 'chess:invalid');
    clientB.emit('chess:move', { channelId: ch, from: 'e7', to: 'e5' });
    const invalid = await invalidPromise as { reason: string };
    expect(invalid.reason).toMatch(/sıra/i);
  });

  it('geçerli hamle chess:move_applied yayınlar', async () => {
    const ch = 'ch-move-valid';
    clientA.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:joined');
    clientB.emit('chess:join', { channelId: ch });
    await waitFor(clientA, 'chess:started');

    const moveAppliedPromise = waitFor(clientA, 'chess:move_applied');
    clientA.emit('chess:move', { channelId: ch, from: 'e2', to: 'e4' });
    const applied = await moveAppliedPromise as { move: { notation: string }; state: GameState };
    expect(applied.move.notation).toBe('e2e4');
    expect(applied.state.turn).toBe('b'); // sıra değişti
  });
});
