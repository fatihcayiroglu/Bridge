// server/tests/chess-socket.test.ts
// Sprint 85 fix: registerChessHandlers socket entegrasyon testleri.
// Unit testler (chess-arbiter.test.ts) _internal logic'i kapsar;
// bu dosya socket katmanını — chess:join → chess:move → chess:resign akışını — test eder.
//
// Sprint 86 fix: waitFor Promise<any> → Promise<unknown>; port cast kaldırıldı.

import { present } from './helpers/narrow';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { Server as IOServer } from 'socket.io';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { registerChessHandlers } from '../socket/handlers/activities/chess-arbiter';
import { chessStore } from '../socket/handlers/activities/chess-store';
import type { GameState } from '../socket/handlers/activities/chess-types';

// ── AKTIVITE YETKI DENETIMI — BU DOSYADA IZIN VER ──────────────────────────
// `chess:join` / `draw:join` artik kanal erisimi dogruluyor (capraz kiraci
// acik kapatildi: uyesi olmayan biri baska bir kanalda oyun/tuval acabiliyordu).
//
// Bu dosya SATRANC/CIZIM MANTIGINI sinar, yetkiyi degil. Bu yuzden yetki
// katmani burada acikca IZIN VERECEK sekilde sahtelenir.
//
// Yetkinin GERCEKTEN yerinde oldugunu kanitlayan yerler ayridir:
//   • tests/activity-tenancy.test.ts   — kaynak sozlesmesi + mutasyon
//   • e2e/_draw-tenancy.cjs            — canli sunucuda somuru + pozitif kontrol
jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  canViewChannel: jest.fn().mockResolvedValue(true),
}));
jest.mock('../db/repositories', () => ({
  ...jest.requireActual('../db/repositories'),
  Channels: { findById: jest.fn().mockResolvedValue({ _id: 'c', serverId: 's' }) },
}));

// ── Helpers ───────────────────────────────────────────────────

function waitFor(socket: ClientSocket, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function emitAndWait(
  emitter: ClientSocket,
  event: string,
  payload: unknown,
  listener: ClientSocket,
  responseEvent: string,
): Promise<unknown> {
  const response = waitFor(listener, responseEvent);

  // The production socket stack joins channel rooms outside the chess handler.
  // This isolated harness registers only chess, so mirror that room membership
  // before an arbiter broadcast targets `channel:${channelId}`.
  if (event === 'chess:join') {
    const channelId = (payload as { channelId?: unknown })?.channelId;
    if (typeof channelId !== 'string' || !channelId)
      throw new Error('chess:join requires a channelId');

    // `emitter.id` socket.io istemcisinde BAGLANANA KADAR `undefined`dir;
    // testin beklentisi baglantinin kurulmus olmasidir.
    const serverSocket = ioServer.sockets.sockets.get(present(emitter.id, 'istemci soket kimligi'));
    if (!serverSocket)
      throw new Error(`Missing server socket for ${emitter.id}`);

    await Promise.all([
      Promise.resolve(serverSocket.join(`channel:${channelId}`)),
      Promise.resolve(serverSocket.join(`voice:${channelId}`)),
    ]);
  }

  emitter.emit(event, payload);
  return response;
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
  clientA?.disconnect();
  clientB?.disconnect();
  ioServer.close(() => {
    if (httpServer.listening) httpServer.close(done);
    else done();
  });
});

afterEach(() => {
  chessStore._clearMemGames_TEST_ONLY();
});

// ── Testler ───────────────────────────────────────────────────

describe('chess:join', () => {
  it('ilk katılan beyaz olarak chess:joined alır', async () => {
    const joined = await emitAndWait(clientA, 'chess:join', { channelId: 'ch-join-1' }, clientA, 'chess:joined') as { color: string; state: GameState };
    expect(joined.color).toBe('w');
    expect(joined.state.whiteUserId).toBe('userA');
  });

  it('ikinci katılan siyah olur, chess:started tüm kanala yayılır', async () => {
    await emitAndWait(clientA, 'chess:join', { channelId: 'ch-join-2' }, clientA, 'chess:joined');

    const started = await emitAndWait(
      clientB,
      'chess:join',
      { channelId: 'ch-join-2' },
      clientA,
      'chess:started',
    ) as { state: GameState };

    expect(started.state.whiteUserId).toBe('userA');
    expect(started.state.blackUserId).toBe('userB');
  });

  it('tekrar bağlanan oyuncu chess:state alır', async () => {
    await emitAndWait(clientA, 'chess:join', { channelId: 'ch-join-3' }, clientA, 'chess:joined');

    // Tekrar join
    const state = await emitAndWait(clientA, 'chess:join', { channelId: 'ch-join-3' }, clientA, 'chess:state') as { color: string };
    expect(state.color).toBe('w');
  });
});

describe('chess:resign', () => {
  it('beyaz istifa ederse siyah kazanır, chess:game_over emit edilir', async () => {
    const ch = 'ch-resign-1';
    await emitAndWait(clientA, 'chess:join', { channelId: ch }, clientA, 'chess:joined');
    await emitAndWait(clientB, 'chess:join', { channelId: ch }, clientA, 'chess:started');

    const gameOverPromise = waitFor(clientA, 'chess:game_over');
    clientA.emit('chess:resign', { channelId: ch });
    const over = await gameOverPromise as { result: string; reason: string };

    expect(over.result).toBe('b');
    expect(over.reason).toMatch(/teslim/i);
  });

  it('aynı anda iki resign isteği tek game_over emit eder', async () => {
    const ch = 'ch-resign-race';
    await emitAndWait(clientA, 'chess:join', { channelId: ch }, clientA, 'chess:joined');
    await emitAndWait(clientB, 'chess:join', { channelId: ch }, clientA, 'chess:started');

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
    await emitAndWait(clientA, 'chess:join', { channelId: ch }, clientA, 'chess:joined');
    await emitAndWait(clientB, 'chess:join', { channelId: ch }, clientA, 'chess:started');

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
    await emitAndWait(clientA, 'chess:join', { channelId: ch }, clientA, 'chess:joined');
    await emitAndWait(clientB, 'chess:join', { channelId: ch }, clientA, 'chess:started');

    const invalidPromise = waitFor(clientA, 'chess:invalid');
    clientA.emit('chess:move', { channelId: ch, from: 'e2', to: 'e5' }); // 3 kare atlama
    const invalid = await invalidPromise as { reason: string };
    expect(invalid.reason).toBeTruthy();
  });

  it('sırası olmayan oyuncu hamle yapamaz', async () => {
    const ch = 'ch-move-turn';
    await emitAndWait(clientA, 'chess:join', { channelId: ch }, clientA, 'chess:joined');
    await emitAndWait(clientB, 'chess:join', { channelId: ch }, clientA, 'chess:started');

    // Siyah (clientB) ilk hamleyi yapmaya çalışır
    const invalidPromise = waitFor(clientB, 'chess:invalid');
    clientB.emit('chess:move', { channelId: ch, from: 'e7', to: 'e5' });
    const invalid = await invalidPromise as { reason: string };
    expect(invalid.reason).toMatch(/sıra/i);
  });

  it('geçerli hamle chess:move_applied yayınlar', async () => {
    const ch = 'ch-move-valid';
    await emitAndWait(clientA, 'chess:join', { channelId: ch }, clientA, 'chess:joined');
    await emitAndWait(clientB, 'chess:join', { channelId: ch }, clientA, 'chess:started');

    const moveAppliedPromise = waitFor(clientA, 'chess:move_applied');
    clientA.emit('chess:move', { channelId: ch, from: 'e2', to: 'e4' });
    const applied = await moveAppliedPromise as { move: { notation: string }; state: GameState };
    expect(applied.move.notation).toBe('e2e4');
    expect(applied.state.turn).toBe('b'); // sıra değişti
  });
});

describe('chess socket endgame and abuse-control branches', () => {
  async function joinVoiceRoom(client: ClientSocket, channelId: string) {
    const serverSocket = ioServer.sockets.sockets.get(present(client.id, 'istemci soket kimligi'));
    if (!serverSocket) throw new Error('missing server socket');
    await Promise.resolve(serverSocket.join(`channel:${channelId}`));
    await Promise.resolve(serverSocket.join(`voice:${channelId}`));
  }

  it('rejects moves against a missing or already-finished game without creating state', async () => {
    const ch='ch-no-game';
    const missing=waitFor(clientA,'chess:invalid');
    clientA.emit('chess:move',{channelId:ch,from:'e2',to:'e4'});
    expect((await missing as any).reason).toMatch(/mevcut değil|bitti/i);

    const finished: GameState = {
      board: (await import('../socket/handlers/activities/chess-arbiter'))._internal.newGame('userA','userB').board,
      turn:'w',castling:{wK:true,wQ:true,bK:true,bQ:true},enPassant:null,halfmove:0,moveHistory:[],gameOver:true,result:'w',whiteUserId:'userA',blackUserId:'userB',
    };
    await chessStore.set(ch,finished);
    const done=waitFor(clientA,'chess:invalid');
    clientA.emit('chess:move',{channelId:ch,from:'e2',to:'e4'});
    expect((await done as any).reason).toMatch(/mevcut değil|bitti/i);
  });

  it('rejects malformed algebraic coordinates before board access', async () => {
    const ch='ch-bad-square';
    await chessStore.set(ch,(await import('../socket/handlers/activities/chess-arbiter'))._internal.newGame('userA','userB'));
    for (const [from,to] of [['z9','e4'],['e2','z9'],['a0','a1']]) {
      const p=waitFor(clientA,'chess:invalid');
      clientA.emit('chess:move',{channelId:ch,from,to});
      expect((await p as any).reason).toMatch(/Geçersiz kare/i);
    }
  });

  it("Fool's mate is adjudicated as checkmate and removes authoritative game state", async () => {
    const ch='ch-fools-mate';
    await emitAndWait(clientA,'chess:join',{channelId:ch},clientA,'chess:joined');
    await emitAndWait(clientB,'chess:join',{channelId:ch},clientA,'chess:started');
    const play=async(client:ClientSocket,from:string,to:string)=>{
      const p=waitFor(clientA,'chess:move_applied'); client.emit('chess:move',{channelId:ch,from,to}); await p;
    };
    await play(clientA,'f2','f3');
    await play(clientB,'e7','e5');
    await play(clientA,'g2','g4');
    const over=waitFor(clientA,'chess:game_over');
    await play(clientB,'d8','h4');
    const payload=await over as any;
    expect(payload.result).toBe('b');
    expect(payload.reason).toMatch(/Şah mat/i);
    await expect(chessStore.get(ch)).resolves.toBeNull();
  });

  it('applies the fifty-move rule after the hundredth halfmove', async () => {
    const ch='ch-fifty';
    const { _internal }=await import('../socket/handlers/activities/chess-arbiter');
    const g=_internal.newGame('userA','userB');
    const board=Array.from({length:8},()=>Array(8).fill(null)) as any;
    board[7][4]='wK'; board[0][4]='bK'; board[7][1]='wN';
    Object.assign(g,{board,turn:'w',halfmove:99,castling:{wK:false,wQ:false,bK:false,bQ:false}});
    await chessStore.set(ch,g);
    await joinVoiceRoom(clientA, ch);
    const over=waitFor(clientA,'chess:game_over');
    clientA.emit('chess:move',{channelId:ch,from:'b1',to:'a3'});
    const payload=await over as any;
    expect(payload.result).toBe('draw'); expect(payload.reason).toMatch(/50 hamle/i);
  });

  it('black resignation awards white and valid draw offers identify their player', async () => {
    const ch='ch-black-resign';
    await emitAndWait(clientA,'chess:join',{channelId:ch},clientA,'chess:joined');
    await emitAndWait(clientB,'chess:join',{channelId:ch},clientA,'chess:started');
    const offered=waitFor(clientA,'chess:draw_offered');
    clientB.emit('chess:draw_offer',{channelId:ch});
    expect(await offered).toMatchObject({by:'userB'});
    const over=waitFor(clientA,'chess:game_over');
    clientB.emit('chess:resign',{channelId:ch});
    expect(await over).toMatchObject({result:'w'});
  });

  it('non-players cannot resign, forge draw offers, or accept draws', async () => {
    const ch='ch-spectator-abuse';
    const g=(await import('../socket/handlers/activities/chess-arbiter'))._internal.newGame('other-white','other-black');
    await chessStore.set(ch,g);
    const toEvents:string[]=[];
    const serverA=present(ioServer.sockets.sockets.get(present(clientA.id, 'istemci soket kimligi')), 'sunucu soketi');
    const originalTo=(ioServer as any).to.bind(ioServer);
    // Observable client listeners are enough; membership is not required for state mutation assertions.
    clientA.on('chess:game_over',()=>toEvents.push('over'));
    clientA.on('chess:draw_offered',()=>toEvents.push('offer'));
    clientA.emit('chess:resign',{channelId:ch});
    clientA.emit('chess:draw_offer',{channelId:ch});
    clientA.emit('chess:draw_accept',{channelId:ch});
    await new Promise(r=>setTimeout(r,75));
    expect(toEvents).toEqual([]);
    expect(await chessStore.get(ch)).not.toBeNull();
    clientA.removeAllListeners('chess:game_over'); clientA.removeAllListeners('chess:draw_offered');
    expect(serverA).toBeTruthy(); expect(originalTo).toBeTruthy();
  });

  it('contains coordination failures and reports a generic server error to the mover', async () => {
    const spy=jest.spyOn(chessStore,'withLock').mockRejectedValueOnce(new Error('coordination down'));
    const p=waitFor(clientA,'chess:invalid');
    clientA.emit('chess:move',{channelId:'ch-lock-error',from:'e2',to:'e4'});
    expect(await p).toMatchObject({reason:'Sunucu hatası.'});
    spy.mockRestore();
  });
});
