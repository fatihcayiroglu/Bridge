// server/tests/canvas-redis-persistence.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// canvas — KUME MODUNDA CIZIM KALICILIGI (REDIS YOLU)
// ════════════════════════════════════════════════════════════════════════════
// `canvas-socket.test.ts` `REDIS_URL`i SILEREK kosar, yani yalnizca surec-ici
// yedegi (in-memory Map) olcer. Ama cok dugumlu bir kurulumda tahta durumu
// REDIS'TE yasar ve bu yol tamamen ayri bir uygulamadir: LPUSH/LTRIM/EXPIRE
import { recordOf } from './helpers/narrow';
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
// Lua betigi, `lRange` okumasi, `lRem` ile tek stroke silme, `setEx` ile meta.
//
// O yol test edilmemis olsaydi, tek dugumde calisan tahta kumede sessizce
// bozuk olabilirdi — ve bunu ancak kullanicilar birbirinin cizimini
// goremeyince fark ederdik.
//
// Olculen sozlesmeler:
//
// · SIRALAMA. Redis listesi LPUSH ile en yeniyi basa koyar; okuma bunu
//   TERSINE cevirmelidir, yoksa tahta ters cizilir.
// · BOZUK SATIR. Listedeki ayristirilamayan bir kayit TUM tahtayi
//   dusurmemeli, yalnizca kendisi elenmelidir.
// · SAHIPLIK. Stroke silme YALNIZCA sahibinin kaydini kaldirir; baskasinin
//   cizimini silmek icin kullanilamaz.
// · ARIZA SESSIZ DEGILDIR. Redis yapilandirilmis ama erisilemezse hata
//   YUTULMAZ; islem basarisiz olur ve gunlugue yazilir.
process.env.NODE_ENV = 'test';

const previousRedisUrl = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://canvas-cluster.test:6379';

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

/** Redis istemcisinin canvas tarafindan kullanilan yuzeyi. */
// Ikizler `node-redis` istemcisinin CAGRILDIGI imzalariyla tiplenir.
// Parametresiz yazilinca `mock.calls[0]` BOS TUPLE oluyor ve her okuma
// `as [...]` donusumune zorluyordu — yani cagri kaydi hakkinda hicbir sey
// derleme zamaninda dogrulanmiyordu.
interface EvalOptions { keys: string[]; arguments: string[] }

const redisClient = {
  get:    jest.fn<Promise<string | null>, [key: string]>(async () => null),
  setEx:  jest.fn<Promise<string>, [key: string, seconds: number, value: string]>(async () => 'OK'),
  del:    jest.fn<Promise<number>, [key: string]>(async () => 1),
  lRange: jest.fn<Promise<string[]>, [key: string, start: number, stop: number]>(async () => []),
  lRem:   jest.fn<Promise<number>, [key: string, count: number, value: string]>(async () => 1),
  eval:   jest.fn<Promise<unknown>, [script: string, options: EvalOptions]>(async () => 1),
};

const redisAuthoritativeCommand = jest.fn(
  async (_operation: string, command: (client: unknown) => Promise<unknown>) => command(redisClient),
);

const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../lib/redisAdapter', () => ({
  cache: { withKeyLock: async (_key: string, fn: () => Promise<unknown>) => fn() },
  redisAuthoritativeCommand: (...args: unknown[]) =>
    (redisAuthoritativeCommand as unknown as (...a: unknown[]) => unknown)(...args),
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: logger,
  createLogger: () => logger,
}));

import { registerCanvasHandlers, canvasState } from '../socket/handlers/canvas';

const db = require('../db/loader');

type Handler = (payload?: unknown) => unknown;

function makeSocket(id: string = 'canvas-cluster-socket') {
  const handlers: Record<string, Handler> = {};
  const emitted: Array<{ event: string; data: unknown }> = [];
  const roomEmitted: Array<{ room: string; event: string; data: unknown }> = [];
  return {
    id,
    handlers, emitted, roomEmitted,
    rooms: new Set<string>(),
    on(event: string, handler: Handler) { handlers[event] = handler; },
    emit(event: string, data: unknown) { emitted.push({ event, data }); },
    join(room: string) { this.rooms.add(room); },
    leave(room: string) { this.rooms.delete(room); },
    to(room: string) {
      return { emit: (event: string, data: unknown) => { roomEmitted.push({ room, event, data }); } };
    },
    async trigger(event: string, payload?: unknown) { await handlers[event]?.(payload); },
  };
}

function makeIo() {
  const emitted: Array<{ room: string; event: string; data: unknown }> = [];
  return {
    emitted,
    in: () => ({ fetchSockets: async () => [] }),
    to: (room: string) => ({ emit: (event: string, data: unknown) => { emitted.push({ room, event, data }); } }),
  };
}

const USER = { _id: 'user-1', displayName: 'Alice' };
const CHANNEL = 'channel-1';

async function seed(): Promise<void> {
  if (!(await db.servers.findOne({ _id: 'server-1' }))) {
    await db.servers.insert({ _id: 'server-1', name: 'Canvas', ownerId: 'owner', createdAt: Date.now() });
  }
  await db.channels.insert({ _id: CHANNEL, serverId: 'server-1', name: 'general', type: 'text' });
  await db.members.insert({ _id: 'member-user-1', userId: USER._id, serverId: 'server-1' });
}

/** Katilmis, yetkili bir soket dondurur. */
async function joinedSocket() {
  const socket = makeSocket();
  const io = makeIo();
  registerCanvasHandlers(socket as never, io as never, USER);
  await socket.trigger('canvas:join', { channelId: CHANNEL });
  return { socket, io };
}

const stroke = (id: string, userId = USER._id) => JSON.stringify({
  id, tool: 'pen', color: '#ffffff', width: 2,
  points: [{ x: 1, y: 2 }], userId, displayName: 'Alice', ts: 1,
});

beforeEach(async () => {
  db._reset?.();
  canvasState.clear();
  for (const fn of Object.values(redisClient)) fn.mockClear();
  redisClient.get.mockResolvedValue(null);
  redisClient.lRange.mockResolvedValue([]);
  redisClient.eval.mockResolvedValue(1);
  redisClient.lRem.mockResolvedValue(1);
  redisClient.del.mockResolvedValue(1);
  redisClient.setEx.mockResolvedValue('OK');
  redisAuthoritativeCommand.mockClear();
  redisAuthoritativeCommand.mockImplementation(
    async (_operation: string, command: (client: unknown) => Promise<unknown>) => command(redisClient));
  for (const fn of Object.values(logger)) fn.mockClear();
  await seed();
});

afterAll(() => {
  canvasState.clear();
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

describe('joining reads the shared board out of Redis', () => {
  it('returns stored strokes newest-last and includes the metadata', async () => {
    // Redis listesi LPUSH ile doldurulur: bas = EN YENI.
    redisClient.lRange.mockResolvedValue([stroke('yeni'), stroke('eski')]);
    redisClient.get.mockResolvedValue(JSON.stringify({ clearedAt: 111, createdAt: 222 }));

    const { socket } = await joinedSocket();
    const state = requireEmitted(socket.emitted, 'canvas:state-sync');
    expect(state).toBeDefined();

    const payload = state!.data as { strokes: Array<{ id: string }>; clearedAt: number };
    // Ters cevrilmezse tahta YANLIS sirada cizilirdi.
    expect(payload.strokes.map(s => s.id)).toEqual(['eski', 'yeni']);
    expect(payload.clearedAt).toBe(111);
  });

  it('drops an unparseable row without losing the whole board', async () => {
    redisClient.lRange.mockResolvedValue([stroke('iyi'), 'bu-json-degil', stroke('digeri')]);
    const { socket } = await joinedSocket();

    const payload = requireEmitted(socket.emitted, 'canvas:state-sync')!.data as
      { strokes: Array<{ id: string }> };
    expect(payload.strokes.map(s => s.id)).toEqual(['digeri', 'iyi']);
  });

  it('serves a fresh board when Redis holds no metadata yet', async () => {
    redisClient.get.mockResolvedValue(null);
    const { socket } = await joinedSocket();
    const payload = requireEmitted(socket.emitted, 'canvas:state-sync')!.data as
      { strokes: unknown[]; clearedAt: number | null };
    expect(payload.strokes).toEqual([]);
    expect(payload.clearedAt).toBeNull();
  });

  it('reports a Redis outage instead of pretending the board is empty', async () => {
    redisClient.lRange.mockRejectedValue(new Error('redis down'));
    const { socket } = await joinedSocket();

    // Bos bir tahta gostermek, kullanicinin cizimini kaybettigini dusundururdu.
    expect(socket.emitted.some(e => e.event === 'canvas:state-sync')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canvas.loadStrokes.error' }), expect.any(String));
  });
});

describe('drawing writes through the bounded Lua script', () => {
  it('appends a sanitised stroke and broadcasts it', async () => {
    const { socket } = await joinedSocket();
    redisClient.eval.mockClear();

    await socket.trigger('canvas:draw', {
      channelId: CHANNEL,
      stroke: { id: 'abc', tool: 'pen', color: '#ff0000', width: 4, points: [{ x: 1, y: 2 }] },
    });

    expect(redisClient.eval).toHaveBeenCalledTimes(1);
    const [script, options] = redisClient.eval.mock.calls[0];
    // Liste SINIRLIDIR ve sure asimi vardir: sinirsiz bir tahta bellegi yer.
    expect(script).toContain('LTRIM');
    expect(script).toContain('EXPIRE');
    expect(options.keys[0]).toBe(`bridge:canvas:${CHANNEL}:strokes`);

    const persisted = JSON.parse(options.arguments[0]) as { userId: string; color: string };
    // Sahiplik SUNUCUDA damgalanir; istemci baskasinin adina cizemez.
    expect(persisted.userId).toBe(USER._id);
    expect(persisted.color).toBe('#ff0000');
    expect(socket.roomEmitted.some(e => e.event === 'canvas:draw')).toBe(true);
  });

  it('surfaces an append failure rather than silently dropping the stroke', async () => {
    const { socket } = await joinedSocket();
    redisClient.eval.mockRejectedValue(new Error('redis down'));
    socket.roomEmitted.length = 0;

    await socket.trigger('canvas:draw', {
      channelId: CHANNEL,
      stroke: { id: 'abc', tool: 'pen', color: '#ffffff', width: 2, points: [{ x: 0, y: 0 }] },
    });

    // Yayin YAPILMAZ: baskalarina gonderilip kalici olmayan bir cizim,
    // yeniden yuklemede kaybolur ve tahtalar AYRISIR.
    expect(socket.roomEmitted.some(e => e.event === 'canvas:draw')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canvas.appendStroke.error' }), expect.any(String));
  });
});

describe('undo removes only the caller’s own stroke', () => {
  it('removes the matching row and broadcasts the undo', async () => {
    const mine = stroke('mine');
    redisClient.lRange.mockResolvedValue([mine]);
    const { socket, io } = await joinedSocket();
    redisClient.lRem.mockClear();

    await socket.trigger('canvas:stroke-delete', { channelId: CHANNEL, strokeId: 'mine' });

    expect(redisClient.lRem).toHaveBeenCalledWith(
      `bridge:canvas:${CHANNEL}:strokes`, 1, mine);
    // Silme TUM odaya `io` uzerinden yayilir (gonderen dahil), cizim ise
    // `socket.to` ile yalnizca DIGERLERINE.
    expect(io.emitted.some(e => e.event === 'canvas:stroke-delete')).toBe(true);
  });

  it('refuses to remove a stroke drawn by somebody else', async () => {
    redisClient.lRange.mockResolvedValue([stroke('theirs', 'user-2')]);
    const { socket, io } = await joinedSocket();
    redisClient.lRem.mockClear();
    io.emitted.length = 0;

    await socket.trigger('canvas:stroke-delete', { channelId: CHANNEL, strokeId: 'theirs' });

    // Sahiplik eslesmedi: hicbir sey silinmez, hicbir sey yayilmaz.
    expect(redisClient.lRem).not.toHaveBeenCalled();
    expect(io.emitted.some(e => e.event === 'canvas:stroke-delete')).toBe(false);
  });

  it('ignores an unparseable row while searching for the target', async () => {
    redisClient.lRange.mockResolvedValue(['bozuk', stroke('mine')]);
    const { socket } = await joinedSocket();
    redisClient.lRem.mockClear();

    await socket.trigger('canvas:stroke-delete', { channelId: CHANNEL, strokeId: 'mine' });
    expect(redisClient.lRem).toHaveBeenCalled();
  });

  it('reports a Redis failure during undo', async () => {
    redisClient.lRange.mockResolvedValue([stroke('mine')]);
    const { socket } = await joinedSocket();
    redisClient.lRange.mockRejectedValue(new Error('redis down'));

    await socket.trigger('canvas:stroke-delete', { channelId: CHANNEL, strokeId: 'mine' });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canvas.removeStroke.error' }), expect.any(String));
  });
});

describe('clearing the board deletes the shared key and stamps metadata', () => {
  it('deletes the stroke list and records when it was cleared', async () => {
    const { socket } = await joinedSocket();
    redisClient.del.mockClear();
    redisClient.setEx.mockClear();

    await socket.trigger('canvas:clear', { channelId: CHANNEL });

    expect(redisClient.del).toHaveBeenCalledWith(`bridge:canvas:${CHANNEL}:strokes`);
    expect(redisClient.setEx).toHaveBeenCalledWith(
      `bridge:canvas:${CHANNEL}:meta`, expect.any(Number), expect.any(String));
    const meta = recordOf(JSON.parse(redisClient.setEx.mock.calls[0][2]), 'meta');
    expect(typeof meta.clearedAt).toBe('number');
  });

  it('reports a failed clear instead of claiming the board is empty', async () => {
    const { socket } = await joinedSocket();
    redisClient.del.mockRejectedValue(new Error('redis down'));
    socket.roomEmitted.length = 0;

    await socket.trigger('canvas:clear', { channelId: CHANNEL });

    expect(socket.roomEmitted.some(e => e.event === 'canvas:clear')).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canvas.clearStrokes.error' }), expect.any(String));
  });

  it('reports a metadata write failure', async () => {
    const { socket } = await joinedSocket();
    redisClient.setEx.mockRejectedValue(new Error('redis down'));

    await socket.trigger('canvas:clear', { channelId: CHANNEL });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canvas.saveMeta.error' }), expect.any(String));
  });

  it('reports a metadata read failure on join', async () => {
    redisClient.get.mockRejectedValue(new Error('redis down'));
    const { socket } = await joinedSocket();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'canvas.loadMeta.error' }), expect.any(String));
    expect(socket.emitted.some(e => e.event === 'canvas:state-sync')).toBe(false);
  });
});

describe('the Redis authority wrapper is always used', () => {
  it('labels every operation for operator diagnosis', async () => {
    redisClient.lRange.mockResolvedValue([]);
    await joinedSocket();
    const labels = redisAuthoritativeCommand.mock.calls.map(call => call[0]);
    // Etiketsiz bir komut, gunlukte hangi islemin dustugunu belirsiz birakirdi.
    expect(labels.every(label => String(label).startsWith('canvas '))).toBe(true);
    expect(labels).toEqual(expect.arrayContaining(['canvas load strokes', 'canvas load metadata']));
  });
});
