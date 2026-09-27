// server/tests/chess-arbiter-guard-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SATRANÇ HAKEMİ — KATILMA YETKİSİ, BOZUK YÜK VE OYUN SONU DALLARI
// ════════════════════════════════════════════════════════════════════════════
//
// `chess-socket.test.ts` gerçek socket.io yığınıyla MUTLU yolu ölçer ve yetki
// katmanını bilerek açık bırakır. Burada tam tersi ölçülür: yetkinin KENDİSİ
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
// ve istemcinin gönderebileceği bozuk yükler. Riskler somuttur:
//
//   · KANAL SIZINTISI — üyesi olmadığı bir kanalda oyun açan biri, o kanalın
//     varlığını öğrenir ve meşru üyenin koltuğunu kapar (griefing).
//   · BOZUK KARE — "e", 12, boş dizge gibi girdiler tahta indeksine
//     dönüştürülürken `NaN` üretir; korunmazsa dizi dışına erişilir.
//   · OYUN SONU NEDENİ — mat, pat ve 50 hamle üç ayrı sonuçtur; yanlış eşleme
//     kullanıcıya kazandığı bir oyunu berabere gösterir.
//
// Gerçek socket.io yerine hafif bir sahte soket kullanılır: ölçülen şey
// hakemin KARARLARIDIR, taşıma katmanı değil.

process.env.NODE_ENV = 'test';

const canViewChannel = jest.fn();
const findChannelById = jest.fn();

jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  canViewChannel: (...args: unknown[]) => canViewChannel(...args),
}));
jest.mock('../db/repositories', () => ({
  ...jest.requireActual('../db/repositories'),
  Channels: { findById: (...args: unknown[]) => findChannelById(...args) },
}));
jest.mock('../lib/logger', () => {
  const logger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn(), trace: jest.fn(),
    child: () => logger,
  };
  return { __esModule: true, default: logger, logger, createLogger: () => logger };
});

import {
  _clearAllGames_TEST_ONLY,
  _internal,
  getChessGame,
  registerChessHandlers,
} from '../socket/handlers/activities/chess-arbiter';
import { chessStore } from '../socket/handlers/activities/chess-store';
import type { GameState } from '../socket/handlers/activities/chess-types';

type Emitted = { target: string; event: string; payload: unknown };

interface Harness {
  emit(event: string, payload?: unknown): Promise<void>;
  socketEmits: Emitted[];
  roomEmits: Emitted[];
  rooms: Set<string>;
}

/** Hakemi gerçek socket.io olmadan süren asgari sahte soket. */
function harness(userId: string): Harness {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void> | void>();
  const socketEmits: Emitted[] = [];
  const roomEmits: Emitted[] = [];
  const rooms = new Set<string>();
  const socket = {
    id: `sock-${userId}`,
    rooms,
    on: (event: string, handler: (...args: unknown[]) => Promise<void> | void) => { handlers.set(event, handler); },
    emit: (event: string, payload: unknown) => { socketEmits.push({ target: 'socket', event, payload }); },
    join: (room: string) => { rooms.add(room); },
  };
  const io = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => { roomEmits.push({ target: room, event, payload }); },
    }),
  };
  registerChessHandlers(socket as never, io as never, userId);
  return {
    async emit(event, payload) {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`kayıtlı olmayan olay: ${event}`);
      await handler(payload);
    },
    socketEmits, roomEmits, rooms,
  };
}

const CH = 'kanal-satranc';
const WHITE = 'oyuncu-beyaz';
const BLACK = 'oyuncu-siyah';
const STRANGER = 'yabanci';

function joinable(h: Harness): Harness {
  h.rooms.add(`voice:${CH}`);
  return h;
}

const empty = (): (string | null)[][] => Array.from({ length: 8 }, () => Array<string | null>(8).fill(null));

function gameWith(board: (string | null)[][], over: Partial<GameState> = {}): GameState {
  const base = _internal.newGame(WHITE, BLACK);
  return { ...base, board: board as never, ...over } as GameState;
}

beforeEach(() => {
  jest.clearAllMocks();
  _clearAllGames_TEST_ONLY();
  canViewChannel.mockResolvedValue(true);
  findChannelById.mockResolvedValue({ _id: CH, serverId: 'srv-1' });
});

describe('katılma yetkisi', () => {
  it('yük hiç gelmezse ya da kanal kimliği yoksa oyun oluşturulmaz', async () => {
    const h = joinable(harness(WHITE));

    await h.emit('chess:join', undefined);
    await h.emit('chess:join', {});

    expect(await getChessGame(CH)).toBeFalsy();
    expect(h.socketEmits).toEqual([]);
  });

  it('kanal kimliği metin değilse yetki denetimi kapalı kalır', async () => {
    const h = joinable(harness(WHITE));

    await h.emit('chess:join', { channelId: 12345 });

    expect(findChannelById).not.toHaveBeenCalled();
    expect(h.socketEmits).toEqual([]);
  });

  it('kanalın ses odasında olmayan istemci oyun açamaz', async () => {
    const h = harness(WHITE); // odaya KATILMADI

    await h.emit('chess:join', { channelId: CH });

    expect(findChannelById).not.toHaveBeenCalled();
    expect(await getChessGame(CH)).toBeFalsy();
  });

  it('kanal satırı yoksa ya da görülemiyorsa oyun açılmaz', async () => {
    findChannelById.mockResolvedValueOnce(null);
    const missing = joinable(harness(WHITE));
    await missing.emit('chess:join', { channelId: CH });
    expect(await getChessGame(CH)).toBeFalsy();

    canViewChannel.mockResolvedValueOnce(false);
    const forbidden = joinable(harness(STRANGER));
    await forbidden.emit('chess:join', { channelId: CH });
    expect(await getChessGame(CH)).toBeFalsy();
    // Sunucu kimligi KANALDAN okunur, istemcinin iddiasindan degil.
    expect(canViewChannel).toHaveBeenCalledWith(STRANGER, 'srv-1', CH);
  });

  it('yetki çözümü çökerse katılma reddedilir', async () => {
    canViewChannel.mockRejectedValueOnce(new Error('permission store down'));
    const h = joinable(harness(WHITE));

    await h.emit('chess:join', { channelId: CH });

    expect(await getChessGame(CH)).toBeFalsy();
  });
});

describe('koltuk atama ve izleyici durumu', () => {
  it('ilk katılan beyaz, ikinci katılan siyah olur', async () => {
    const white = joinable(harness(WHITE));
    await white.emit('chess:join', { channelId: CH });
    expect(white.socketEmits[0]).toMatchObject({ event: 'chess:joined', payload: { color: 'w' } });

    const black = joinable(harness(BLACK));
    await black.emit('chess:join', { channelId: CH });
    expect(black.roomEmits[0]).toMatchObject({ target: `channel:${CH}`, event: 'chess:started' });

    const game = await getChessGame(CH);
    expect(game).toMatchObject({ whiteUserId: WHITE, blackUserId: BLACK });
  });

  it('yeniden bağlanan oyuncu kendi rengini, izleyici ise null alır', async () => {
    const white = joinable(harness(WHITE));
    await white.emit('chess:join', { channelId: CH });
    const black = joinable(harness(BLACK));
    await black.emit('chess:join', { channelId: CH });

    const reconnect = joinable(harness(BLACK));
    await reconnect.emit('chess:join', { channelId: CH });
    expect(reconnect.socketEmits[0]).toMatchObject({ event: 'chess:state', payload: { color: 'b' } });

    const spectator = joinable(harness(STRANGER));
    await spectator.emit('chess:join', { channelId: CH });
    expect(spectator.socketEmits[0]).toMatchObject({ event: 'chess:state', payload: { color: null } });
  });
});

describe('hamle yükü doğrulaması', () => {
  async function seatedGame(): Promise<Harness> {
    const white = joinable(harness(WHITE));
    await white.emit('chess:join', { channelId: CH });
    const black = joinable(harness(BLACK));
    await black.emit('chess:join', { channelId: CH });
    white.socketEmits.length = 0;
    white.roomEmits.length = 0;
    return white;
  }

  it('eksik yük sessizce yok sayılır', async () => {
    const h = await seatedGame();

    await h.emit('chess:move', undefined);
    await h.emit('chess:move', { channelId: CH, from: 'e2' });
    await h.emit('chess:move', { channelId: CH, to: 'e4' });
    await h.emit('chess:move', { from: 'e2', to: 'e4' });

    expect(h.socketEmits).toEqual([]);
    expect(h.roomEmits).toEqual([]);
  });

  it('eksik/bozuk kare adları "Geçersiz kare" ile reddedilir', async () => {
    const h = await seatedGame();

    for (const [from, to] of [['e', 'e4'], ['e2', 'e'], ['z2', 'e4'], ['e9', 'e4']]) {
      await h.emit('chess:move', { channelId: CH, from, to });
    }

    expect(h.socketEmits.map(e => (e.payload as { reason: string }).reason))
      .toEqual(['Geçersiz kare.', 'Geçersiz kare.', 'Geçersiz kare.', 'Geçersiz kare.']);
    expect(h.roomEmits).toEqual([]);
  });

  it('sırası olmayan oyuncu hamle yapamaz', async () => {
    const white = joinable(harness(WHITE));
    await white.emit('chess:join', { channelId: CH });
    const black = joinable(harness(BLACK));
    await black.emit('chess:join', { channelId: CH });
    black.socketEmits.length = 0;

    await black.emit('chess:move', { channelId: CH, from: 'e7', to: 'e5' });

    expect(black.socketEmits[0]).toMatchObject({ event: 'chess:invalid', payload: { reason: 'Sıra sende değil.' } });
  });

  it('oyun yokken hamle "oyun mevcut değil" ile yanıtlanır', async () => {
    const h = joinable(harness(WHITE));

    await h.emit('chess:move', { channelId: CH, from: 'e2', to: 'e4' });

    expect(h.socketEmits[0]).toMatchObject({ payload: { reason: 'Oyun mevcut değil veya bitti.' } });
  });
});

describe('oyun sonu nedenleri', () => {
  async function seatWithBoard(board: (string | null)[][], over: Partial<GameState> = {}): Promise<Harness> {
    const h = joinable(harness(WHITE));
    await h.emit('chess:join', { channelId: CH });
    await chessStore.set(CH, gameWith(board, { whiteUserId: WHITE, blackUserId: BLACK, ...over }));
    h.socketEmits.length = 0;
    h.roomEmits.length = 0;
    return h;
  }

  it('mat sonucu "Şah mat" nedeniyle yayınlanır ve oyun silinir', async () => {
    // Beyaz vezir h5 ve kale a7 ile siyah şahı h8'de mat eder.
    const board = empty();
    board[0]![7] = 'bK';   // h8
    board[1]![0] = 'wR';   // a7
    board[7]![0] = 'wK';   // a1
    board[3]![7] = 'wQ';   // h5
    const h = await seatWithBoard(board, { turn: 'w' });

    await h.emit('chess:move', { channelId: CH, from: 'h5', to: 'h7' });

    const over = requireEmitted(h.roomEmits, 'chess:game_over');
    expect(over).toBeTruthy();
    expect(over!.payload).toMatchObject({ result: 'w', reason: 'Şah mat' });
    expect(await getChessGame(CH)).toBeFalsy();
  });

  it('pat sonucu berabere ve "Pat" nedeniyle biter', async () => {
    // Siyah şah a8; beyaz vezir c7 oynayınca siyahın yasal hamlesi kalmaz.
    const board = empty();
    board[0]![0] = 'bK';   // a8
    board[7]![7] = 'wK';   // h1
    board[5]![2] = 'wQ';   // c3
    const h = await seatWithBoard(board, { turn: 'w' });

    await h.emit('chess:move', { channelId: CH, from: 'c3', to: 'c7' });

    const over = requireEmitted(h.roomEmits, 'chess:game_over');
    expect(over!.payload).toMatchObject({ result: 'draw', reason: 'Pat' });
  });

  it('50 hamle kuralı berabere ve "50 hamle" nedeniyle biter', async () => {
    const board = empty();
    board[0]![0] = 'bK';   // a8
    board[7]![7] = 'wK';   // h1
    board[4]![4] = 'wR';   // e4
    const h = await seatWithBoard(board, { turn: 'w', halfmove: 99 });

    await h.emit('chess:move', { channelId: CH, from: 'e4', to: 'e5' });

    const over = requireEmitted(h.roomEmits, 'chess:game_over');
    expect(over!.payload).toMatchObject({ result: 'draw', reason: '50 hamle' });
  });

  it('terfi hamlesi gösterimde terfi harfini taşır', async () => {
    const board = empty();
    board[1]![0] = 'wP';   // a7
    board[7]![7] = 'wK';   // h1
    board[0]![7] = 'bK';   // h8
    const h = await seatWithBoard(board, { turn: 'w' });

    await h.emit('chess:move', { channelId: CH, from: 'a7', to: 'a8', promoteTo: 'Q' });

    const applied = requireEmitted(h.roomEmits, 'chess:move_applied');
    expect((applied!.payload as { move: { notation: string } }).move.notation).toBe('a7a8q');
  });

  it('terfisiz hamlede gösterim yalnız kareleri taşır', async () => {
    const board = empty();
    board[4]![4] = 'wR';
    board[7]![7] = 'wK';
    board[0]![0] = 'bK';
    const h = await seatWithBoard(board, { turn: 'w' });

    await h.emit('chess:move', { channelId: CH, from: 'e4', to: 'e6' });

    const applied = requireEmitted(h.roomEmits, 'chess:move_applied');
    expect((applied!.payload as { move: { notation: string } }).move.notation).toBe('e4e6');
  });
});

describe('teslim olma ve beraberlik', () => {
  async function twoSeats(): Promise<{ white: Harness; black: Harness }> {
    const white = joinable(harness(WHITE));
    await white.emit('chess:join', { channelId: CH });
    const black = joinable(harness(BLACK));
    await black.emit('chess:join', { channelId: CH });
    white.roomEmits.length = 0;
    black.roomEmits.length = 0;
    return { white, black };
  }

  it('kanal kimliği olmayan yükler her üç olayda da yok sayılır', async () => {
    const { white } = await twoSeats();

    for (const event of ['chess:resign', 'chess:draw_offer', 'chess:draw_accept']) {
      await white.emit(event, undefined);
      await white.emit(event, {});
    }

    expect(white.roomEmits).toEqual([]);
    expect(await getChessGame(CH)).toBeTruthy();
  });

  it('oyun yokken teslim/beraberlik olayları hiçbir şey yayınlamaz', async () => {
    const h = joinable(harness(WHITE));

    await h.emit('chess:resign', { channelId: 'bos-kanal' });
    await h.emit('chess:draw_offer', { channelId: 'bos-kanal' });
    await h.emit('chess:draw_accept', { channelId: 'bos-kanal' });

    expect(h.roomEmits).toEqual([]);
  });

  it('oyuncu olmayan biri oyunu bitiremez ve sahte teklif yayınlayamaz', async () => {
    await twoSeats();
    const stranger = joinable(harness(STRANGER));

    await stranger.emit('chess:resign', { channelId: CH });
    await stranger.emit('chess:draw_offer', { channelId: CH });
    await stranger.emit('chess:draw_accept', { channelId: CH });

    expect(stranger.roomEmits).toEqual([]);
    expect(await getChessGame(CH)).toBeTruthy();
  });

  it('siyah teslim olursa beyaz kazanır ve oyun silinir', async () => {
    const { black } = await twoSeats();

    await black.emit('chess:resign', { channelId: CH });

    expect(black.roomEmits[0]).toMatchObject({
      event: 'chess:game_over',
      payload: { result: 'w', reason: 'Siyah teslim oldu.' },
    });
    expect(await getChessGame(CH)).toBeFalsy();
  });

  it('beyaz teslim olursa siyah kazanır', async () => {
    const { white } = await twoSeats();

    await white.emit('chess:resign', { channelId: CH });

    expect(white.roomEmits[0]).toMatchObject({ payload: { result: 'b', reason: 'Beyaz teslim oldu.' } });
  });

  it('beraberlik teklifi ve kabulü yalnız oyunculardan gelir', async () => {
    const { white, black } = await twoSeats();

    await white.emit('chess:draw_offer', { channelId: CH });
    expect(white.roomEmits[0]).toMatchObject({ event: 'chess:draw_offered', payload: { by: WHITE } });

    await black.emit('chess:draw_accept', { channelId: CH });
    expect(black.roomEmits[0]).toMatchObject({
      event: 'chess:game_over',
      payload: { result: 'draw', reason: 'Anlaşmalı beraberlik.' },
    });
    expect(await getChessGame(CH)).toBeFalsy();
  });
});

describe('tahta mantığı iç dalları', () => {
  it('boş kare rengi boş dizedir', async () => {
    const board = empty();
    board[7]![4] = 'wK';
    board[0]![4] = 'bK';
    // Bos karede sah tehdidi hesaplanabilmeli; renk cozumu cokmemelidir.
    expect(_internal.isInCheck(board as never, 'w')).toBe(false);
  });

  it('piyon tehdidi köşegen olarak ve yalnız tahta içinde hesaplanır', async () => {
    // Siyah sah a3'te, beyaz piyon b2'de → kosegen tehdit, sah cekiyor.
    const board = empty();
    board[5]![0] = 'bK';   // a3
    board[6]![1] = 'wP';   // b2
    board[0]![7] = 'wK';   // h8
    expect(_internal.isInCheck(board as never, 'b')).toBe(true);

    // Ayni piyon, saha DUZ onunde duruyorsa tehdit DEGILDIR.
    const straight = empty();
    straight[5]![1] = 'bK'; // b3
    straight[6]![1] = 'wP'; // b2
    straight[0]![7] = 'wK';
    expect(_internal.isInCheck(straight as never, 'b')).toBe(false);

    // Sah en alt siradayken saldirgan piyon satiri tahta DISINA taşar;
    // tarama cokmeden "tehdit yok" demelidir.
    const edge = empty();
    edge[7]![3] = 'bK';    // d1
    edge[0]![7] = 'wK';    // h8
    expect(_internal.isInCheck(edge as never, 'b')).toBe(false);
  });

  it('önü kapalı piyon iki kare ilerleyemez', async () => {
    const board = empty();
    board[6]![4] = 'wP';   // e2
    board[5]![4] = 'bN';   // e3 — onu kapali
    board[7]![7] = 'wK';
    board[0]![0] = 'bK';
    const game = gameWith(board, { turn: 'w' });

    expect(_internal.getLegalMoves(game, 6, 4)).toEqual([]);
  });

  it('geçerken alma, alınan piyonu tahtadan kaldırır', async () => {
    const board = empty();
    board[3]![4] = 'wP';   // e5
    board[3]![3] = 'bP';   // d5 (iki kare ilerlemis)
    board[7]![7] = 'wK';
    board[0]![0] = 'bK';
    const game = gameWith(board, { turn: 'w', enPassant: [2, 3] as never });

    const result = _internal.applyMoveToBoard(game.board, game, 3, 4, 2, 3, undefined);

    expect(result.captured).toBe('bP');
    expect(result.board[3]![3]).toBeNull();
    expect(result.board[2]![3]).toBe('wP');
  });
});
