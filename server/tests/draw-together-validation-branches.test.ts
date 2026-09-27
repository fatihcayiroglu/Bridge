// server/tests/draw-together-validation-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// DRAW TOGETHER — GİRDİ DOĞRULAMA, ODA SINIRI VE OTURUM SAHİPLİĞİ
// ════════════════════════════════════════════════════════════════════════════
//
// `draw-together-boundaries.test.ts` kiracı sınırını (kimin katılabildiğini)
// ölçer. Bu dosya, katıldıktan SONRAKİ yüksek frekanslı yolların ölçülmemiş
import { ServerDouble, findEmitted, requireEmitted, requireEmittedData } from './helpers/socketDoubles';
// karar dallarını kapatır:
//
//   · ODA ≠ İSTEMCİ İDDİASI — stroke/undo/clear/tool/cursor olayları soketin
//     GERÇEKTEN o tuvalin odasında olmasını ister; oda üyeliği sunucu tarafı
//     durumdur ve uydurulamaz.
//   · PAYLAŞILAN DURUM KİRLENMESİ — her stroke güncellemesi, ortak duruma ve
//     diğer istemcilere ulaşmadan ÖNCE doğrulanır (nokta sayısı, koordinat
//     büyüklüğü, renk biçimi, kalınlık, saydamlık, metin uzunluğu).
//   · BELLEK SINIRI — oturum başına stroke sayısı sabittir; taşan en eski
//     kayıt düşer, oturum sınırsız büyümez.
//   · GERİ ALMA — yalnız KENDİ son çizimini geri alabilirsin.
//   · TEMİZLEME — yalnız host; host ayrılırsa sahiplik devredilir.

process.env.NODE_ENV = 'test';
delete process.env.REDIS_URL;

const findChannel = jest.fn();
const canViewChannel = jest.fn();

jest.mock('../db/repositories', () => ({
  Channels: { findById: (...args: unknown[]) => findChannel(...args) },
}));
jest.mock('../lib/permissions', () => ({
  canViewChannel: (...args: unknown[]) => canViewChannel(...args),
}));
jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => false,
  cache: {
    withKeyLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
    getAuthoritative: jest.fn(), setAuthoritative: jest.fn(), delAuthoritative: jest.fn(),
  },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import type { Server as IOServer, Socket } from 'socket.io';
import { drawSessions } from '../socket/handlers/activities/draw-store';
import { registerDrawTogetherHandlers } from '../socket/handlers/activities/draw-together';

// ── Test ikizleri ───────────────────────────────────────────────────────────
type Emission = { room?: string; event: string; data: unknown };

interface FakeSocket {
  id: string;
  rooms: Set<string>;
  self: Emission[];
  broadcast: Emission[];
  trigger(event: string, payload?: unknown): Promise<void>;
  asSocket: Socket;
}

function makeSocket(id: string, voiceChannels: string[] = []): FakeSocket {
  const handlers = new Map<string, (payload?: unknown) => Promise<void>>();
  const self: Emission[] = [];
  const broadcast: Emission[] = [];
  const rooms = new Set<string>(voiceChannels.map(channelId => `voice:${channelId}`));
  const shape = {
    id,
    rooms,
    on(event: string, fn: (payload?: unknown) => Promise<void>) { handlers.set(event, fn); },
    join(room: string) { rooms.add(room); },
    leave(room: string) { rooms.delete(room); },
    emit(event: string, data: unknown) { self.push({ event, data }); return true; },
    to(room: string) {
      return { emit(event: string, data: unknown) { broadcast.push({ room, event, data }); return true; } };
    },
  };
  return {
    id, rooms, self, broadcast,
    async trigger(event, payload) { await handlers.get(event)?.(payload); },
    // `Socket` yüzlerce üye taşır; handler yalnız bu dar yüzeyi kullanır.
    asSocket: shape as unknown as Socket,
  };
}

const ioEmissions: Emission[] = [];
const io = {
  to(room: string) {
    return { emit(event: string, data: unknown) { ioEmissions.push({ room, event, data }); return true; } };
  },
} satisfies ServerDouble as unknown as IOServer;

const CH = 'canvas-1';
const SESSION = 'session-1';
const user = { _id: 'user-me', displayName: 'Ben', avatarColor: '#123456' };

const stroke = (over: Record<string, unknown> = {}) => ({
  channelId: CH, id: 'stroke-1', tool: 'pen', color: '#ff0000',
  size: 4, opacity: 1, points: [{ x: 1, y: 2 }], ...over,
});

async function joinedSocket(id = 'sock-1', who = user): Promise<FakeSocket> {
  const socket = makeSocket(id, [CH]);
  registerDrawTogetherHandlers(socket.asSocket, io, who);
  await socket.trigger('draw:join', { channelId: CH, sessionId: SESSION });
  socket.self.length = 0;
  socket.broadcast.length = 0;
  ioEmissions.length = 0;
  return socket;
}

const errorText = (socket: FakeSocket): string => {
  const found = requireEmittedData(socket.self, 'draw:error');
  return found ? String((found as { message?: string }).message ?? '') : '';
};

beforeEach(() => {
  jest.clearAllMocks();
  drawSessions.clear();
  ioEmissions.length = 0;
  findChannel.mockResolvedValue({ _id: CH, serverId: 'srv-1' });
  canViewChannel.mockResolvedValue(true);
});

// ════════════════════════════════════════════════════════════════════════════
describe('oda sınırı — istemci iddiası yetki DEĞİLDİR', () => {
  it.each([
    'draw:stroke', 'draw:stroke-end', 'draw:undo', 'draw:clear', 'draw:tool', 'draw:cursor',
  ])('%s odada olmayan soketten kabul edilmez', async (event) => {
    const outsider = makeSocket('sock-yabanci', [CH]);
    registerDrawTogetherHandlers(outsider.asSocket, io, user);

    await outsider.trigger(event, { channelId: CH, strokeId: 'stroke-1', id: 'stroke-1', x: 1, y: 2, tool: 'pen', color: '#fff', size: 2 });

    expect(outsider.broadcast).toHaveLength(0);
    expect(ioEmissions).toHaveLength(0);
  });

  it.each([
    ['null', null],
    ['metin', 'gövde'],
    ['dizi', []],
  ])('draw:join şekilsiz yükte (%s) kanal SORMAZ', async (_label, payload) => {
    const socket = makeSocket('sock-1', [CH]);
    registerDrawTogetherHandlers(socket.asSocket, io, user);

    await socket.trigger('draw:join', payload);

    expect(findChannel).not.toHaveBeenCalled();
  });

  it('oturum kimliği ÇOK UZUN ise katılım denenmez', async () => {
    const socket = makeSocket('sock-1', [CH]);
    registerDrawTogetherHandlers(socket.asSocket, io, user);

    await socket.trigger('draw:join', { channelId: CH, sessionId: 's'.repeat(200) });

    expect(findChannel).not.toHaveBeenCalled();
  });

  it('kanal kimliği ÇOK UZUN ise katılım denenmez', async () => {
    const socket = makeSocket('sock-1', ['c'.repeat(200)]);
    registerDrawTogetherHandlers(socket.asSocket, io, user);

    await socket.trigger('draw:join', { channelId: 'c'.repeat(200), sessionId: SESSION });

    expect(findChannel).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('draw:stroke — girdi doğrulama', () => {
  it('şekilsiz yük yok sayılır', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', null);
    await socket.trigger('draw:stroke', 'metin');

    expect(socket.self).toHaveLength(0);
  });

  it.each([
    ['kimlik yok', {}],
    ['kimlik metin değil', { id: 42 }],
    ['kimlik çok uzun', { id: 's'.repeat(200) }],
  ])('%s ise AÇIK hata döner', async (_label, over) => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', { channelId: CH, ...over });

    expect(errorText(socket)).toBe('Geçersiz stroke.id');
    expect(socket.broadcast).toHaveLength(0);
  });

  it.each([
    ['bilinmeyen araç', { tool: 'lazer' }, 'Geçersiz tool: lazer'],
    ['renk yok', { color: undefined }, 'color gerekli'],
    ['renk metin değil', { color: 42 }, 'color gerekli'],
    ['renk biçimi bozuk', { color: 'kirmizi' }, 'Geçersiz color formatı'],
    ['renk çok uzun', { color: '#0123456789' }, 'Geçersiz color formatı'],
    ['kalınlık sayı değil', { size: '4' }, 'size: 1–100'],
    ['kalınlık sonsuz', { size: Number.POSITIVE_INFINITY }, 'size: 1–100'],
    ['kalınlık küçük', { size: 0 }, 'size: 1–100'],
    ['kalınlık büyük', { size: 101 }, 'size: 1–100'],
    ['saydamlık sayı değil', { opacity: '1' }, 'opacity: 0–1'],
    ['saydamlık negatif', { opacity: -0.1 }, 'opacity: 0–1'],
    ['saydamlık büyük', { opacity: 1.1 }, 'opacity: 0–1'],
    ['nokta yok', { points: undefined }, 'points gerekli'],
    ['nokta boş', { points: [] }, 'points gerekli'],
    ['nokta dizi değil', { points: 'x' }, 'points gerekli'],
    ['metin tür hatası', { text: 42 }, 'Geçersiz metin'],
  ])('%s reddedilir ve ortak duruma yazılmaz', async (_label, over, expected) => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', stroke(over));

    expect(errorText(socket)).toBe(expected);
    expect(socket.broadcast).toHaveLength(0);
  });

  it('ÇOK FAZLA nokta reddedilir', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', stroke({
      points: Array.from({ length: 501 }, (_, i) => ({ x: i, y: i })),
    }));

    expect(errorText(socket)).toBe('Çok fazla nokta');
  });

  it.each([
    ['koordinat sayı değil', [{ x: '1', y: 2 }]],
    ['koordinat sonsuz', [{ x: Number.POSITIVE_INFINITY, y: 0 }]],
    ['koordinat çok büyük', [{ x: 2_000_000, y: 0 }]],
    ['nokta nesne değil', ['x']],
    ['nokta null', [null]],
  ])('%s reddedilir', async (_label, points) => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', stroke({ points }));

    expect(errorText(socket)).toBe('Geçersiz nokta formatı');
  });

  it('METİN aracında uzun metin reddedilir', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', stroke({ tool: 'text', text: 'm'.repeat(201) }));

    expect(errorText(socket)).toBe('Metin çok uzun');
  });

  it('geçerli stroke ODAYA yayılır ve yazar SUNUCUDAN yazılır', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke', stroke({ userId: 'baskasi', displayName: 'Sahte' }));

    const emitted = requireEmitted(socket.broadcast, 'draw:stroke')!;
    expect(emitted.room).toBe(`draw:${CH}`);
    expect(emitted.data).toMatchObject({
      id: 'stroke-1', userId: user._id, displayName: user.displayName, complete: false,
    });
  });

  it('SONRAKİ nokta çerçeveleri yalnız nokta doğrulamasından geçer', async () => {
    const socket = await joinedSocket();
    await socket.trigger('draw:stroke', stroke());
    socket.broadcast.length = 0;

    await socket.trigger('draw:stroke', { channelId: CH, strokeId: 'stroke-1', points: [{ x: 3, y: 4 }] });

    const emitted = requireEmitted(socket.broadcast, 'draw:stroke')!;
    expect((emitted.data as { points: unknown[] }).points).toEqual([{ x: 3, y: 4 }]);
  });

  it('nokta çerçevesi de doğrulanır', async () => {
    const socket = await joinedSocket();
    await socket.trigger('draw:stroke', stroke());
    socket.self.length = 0;
    socket.broadcast.length = 0;

    await socket.trigger('draw:stroke', { channelId: CH, strokeId: 'stroke-1', points: [{ x: 5_000_000, y: 0 }] });

    expect(errorText(socket)).toBe('Geçersiz nokta formatı');
    expect(socket.broadcast).toHaveLength(0);
  });

  it('OTURUMA katılmamış soket ortak duruma yazamaz', async () => {
    const owner = await joinedSocket('sock-1');
    const intruder = makeSocket('sock-2', [CH]);
    intruder.rooms.add(`draw:${CH}`);   // odaya girmiş ama katılımcı değil
    registerDrawTogetherHandlers(intruder.asSocket, io, user);

    await intruder.trigger('draw:stroke', stroke({ id: 'stroke-2' }));

    expect(intruder.broadcast).toHaveLength(0);
    expect(owner.self).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('draw:stroke-end', () => {
  it.each([
    ['kimlik metin değil', 42],
    ['kimlik boş', ''],
    ['kimlik çok uzun', 's'.repeat(200)],
  ])('%s yok sayılır', async (_label, strokeId) => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke-end', { channelId: CH, strokeId });

    expect(socket.broadcast).toHaveLength(0);
  });

  it('AKTİF olmayan stroke bitirilemez', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:stroke-end', { channelId: CH, strokeId: 'baska-stroke' });

    expect(socket.broadcast).toHaveLength(0);
  });

  it('bitiş noktaları da DOĞRULANIR', async () => {
    const socket = await joinedSocket();
    await socket.trigger('draw:stroke', stroke());
    socket.self.length = 0;
    socket.broadcast.length = 0;

    await socket.trigger('draw:stroke-end', { channelId: CH, strokeId: 'stroke-1', points: [{ x: 'a', y: 1 }] });

    expect(errorText(socket)).toBe('Geçersiz nokta formatı');
    expect(socket.broadcast).toHaveLength(0);
  });

  it('geçerli bitiş kalıcı listeye yazılır ve yayılır', async () => {
    const socket = await joinedSocket();
    await socket.trigger('draw:stroke', stroke());
    socket.broadcast.length = 0;

    await socket.trigger('draw:stroke-end', { channelId: CH, strokeId: 'stroke-1', points: [{ x: 9, y: 9 }] });

    expect(findEmitted(socket.broadcast, 'draw:stroke-end')).toBeDefined();
    expect(drawSessions.get(CH)?.strokes).toHaveLength(1);
    expect(drawSessions.get(CH)?.strokes[0]?.complete).toBe(true);
  });

  it('nokta verilmeyen bitiş mevcut noktaları korur', async () => {
    const socket = await joinedSocket();
    await socket.trigger('draw:stroke', stroke({ points: [{ x: 7, y: 8 }] }));

    await socket.trigger('draw:stroke-end', { channelId: CH, strokeId: 'stroke-1' });

    expect(drawSessions.get(CH)?.strokes[0]?.points).toEqual([{ x: 7, y: 8 }]);
  });

  it('BELLEK SINIRI aşılınca en eski stroke düşer', async () => {
    const socket = await joinedSocket();
    const session = drawSessions.get(CH)!;
    session.strokes = Array.from({ length: 1000 }, (_, i) => ({
      id: `eski-${i}`, tool: 'pen', color: '#fff', size: 1, opacity: 1,
      points: [{ x: 0, y: 0 }], userId: user._id, displayName: 'Ben', ts: i, complete: true,
    }));

    await socket.trigger('draw:stroke', stroke({ id: 'yeni' }));
    await socket.trigger('draw:stroke-end', { channelId: CH, strokeId: 'yeni' });

    const strokes = drawSessions.get(CH)!.strokes;
    expect(strokes).toHaveLength(1000);
    expect(strokes[0]?.id).toBe('eski-1');
    expect(strokes.at(-1)?.id).toBe('yeni');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('draw:undo ve draw:clear', () => {
  it('geri alacak KENDİ çizimi yoksa hiçbir şey olmaz', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:undo', { channelId: CH });

    expect(ioEmissions).toHaveLength(0);
  });

  it('yalnız KENDİ son çizimi geri alınır', async () => {
    const socket = await joinedSocket();
    const session = drawSessions.get(CH)!;
    session.strokes = [
      { id: 'benim-1', tool: 'pen', color: '#fff', size: 1, opacity: 1, points: [{ x: 0, y: 0 }], userId: user._id, displayName: 'Ben', ts: 1, complete: true },
      { id: 'baskasinin', tool: 'pen', color: '#fff', size: 1, opacity: 1, points: [{ x: 0, y: 0 }], userId: 'baskasi', displayName: 'Öteki', ts: 2, complete: true },
    ];

    await socket.trigger('draw:undo', { channelId: CH });

    expect(ioEmissions[0]).toMatchObject({ event: 'draw:undo', data: { strokeId: 'benim-1' } });
    expect(drawSessions.get(CH)!.strokes.map(s => s.id)).toEqual(['baskasinin']);
  });

  it('HOST olmayan canvası temizleyemez', async () => {
    await joinedSocket('sock-host');
    const guest = makeSocket('sock-guest', [CH]);
    registerDrawTogetherHandlers(guest.asSocket, io, { ...user, _id: 'user-guest' });
    await guest.trigger('draw:join', { channelId: CH, sessionId: SESSION });
    guest.self.length = 0;
    ioEmissions.length = 0;

    await guest.trigger('draw:clear', { channelId: CH });

    expect(errorText(guest)).toBe('Canvas temizlemek için host yetkisi gerekli.');
    expect(ioEmissions).toHaveLength(0);
  });

  it('HOST canvası temizler', async () => {
    const host = await joinedSocket('sock-host');
    await host.trigger('draw:stroke', stroke());
    await host.trigger('draw:stroke-end', { channelId: CH, strokeId: 'stroke-1' });
    ioEmissions.length = 0;

    await host.trigger('draw:clear', { channelId: CH });

    expect(ioEmissions[0]?.event).toBe('draw:clear');
    expect(drawSessions.get(CH)!.strokes).toHaveLength(0);
  });

  it('OTURUMA katılmamış soket temizleyemez', async () => {
    await joinedSocket('sock-host');
    const intruder = makeSocket('sock-x', [CH]);
    intruder.rooms.add(`draw:${CH}`);
    registerDrawTogetherHandlers(intruder.asSocket, io, user);
    ioEmissions.length = 0;

    await intruder.trigger('draw:clear', { channelId: CH });

    expect(ioEmissions).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('draw:tool ve draw:cursor', () => {
  it('şekilsiz araç durumu yok sayılır', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:tool', null);
    await socket.trigger('draw:tool', 'metin');

    expect(socket.broadcast).toHaveLength(0);
  });

  it.each([
    ['araç yok', { tool: undefined }, 'Geçersiz tool: undefined'],
    ['araç bilinmiyor', { tool: 'lazer' }, 'Geçersiz tool: lazer'],
    ['renk yok', { color: undefined }, 'Geçersiz color formatı'],
    ['renk bozuk', { color: 'mavi' }, 'Geçersiz color formatı'],
    ['renk çok uzun', { color: '#0123456789' }, 'Geçersiz color formatı'],
    ['kalınlık sayı değil', { size: '3' }, 'size: 1–100'],
    ['kalınlık sınır dışı', { size: 200 }, 'size: 1–100'],
    ['saydamlık geçersiz', { opacity: 2 }, 'opacity: 0–1'],
    ['saydamlık sayı değil', { opacity: 'yarı' }, 'opacity: 0–1'],
  ])('araç durumu %s reddedilir', async (_label, over, expected) => {
    const socket = await joinedSocket();

    await socket.trigger('draw:tool', { channelId: CH, tool: 'pen', color: '#ff0000', size: 3, ...over });

    expect(errorText(socket)).toBe(expected);
    expect(socket.broadcast).toHaveLength(0);
  });

  it('geçerli araç durumu yayılır; saydamlık verilmezse alan EKLENMEZ', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:tool', { channelId: CH, tool: 'pen', color: '#ff0000', size: 3 });

    const emitted = requireEmitted(socket.broadcast, 'draw:tool')!;
    expect(emitted.data).toEqual({
      userId: user._id, displayName: user.displayName, tool: 'pen', color: '#ff0000', size: 3,
    });
  });

  it('saydamlık verilirse yayına EKLENİR', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:tool', { channelId: CH, tool: 'pen', color: '#ff0000', size: 3, opacity: 0.5 });

    expect(findEmitted(socket.broadcast, 'draw:tool')!.data).toMatchObject({ opacity: 0.5 });
  });

  it('şekilsiz imleç yükü ve geçersiz koordinat yok sayılır', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:cursor', null);
    await socket.trigger('draw:cursor', { channelId: CH, x: 'a', y: 1 });
    await socket.trigger('draw:cursor', { channelId: CH, x: 5_000_000, y: 1 });

    expect(socket.broadcast).toHaveLength(0);
  });

  it('imleç yayını KISITLANIR (ardışık olaylar boğulur)', async () => {
    const socket = await joinedSocket();

    await socket.trigger('draw:cursor', { channelId: CH, x: 1, y: 1 });
    await socket.trigger('draw:cursor', { channelId: CH, x: 2, y: 2 });

    expect(socket.broadcast.filter(e => e.event === 'draw:cursor')).toHaveLength(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('bağlantı kopması ve host devri', () => {
  it('SON katılımcı ayrılınca oturum SİLİNİR', async () => {
    const socket = await joinedSocket();

    await socket.trigger('disconnect');

    expect(drawSessions.has(CH)).toBe(false);
    expect(ioEmissions).toHaveLength(0);
  });

  it('HOST ayrılınca sahiplik DEVREDİLİR', async () => {
    const host = await joinedSocket('sock-host');
    const guest = makeSocket('sock-guest', [CH]);
    registerDrawTogetherHandlers(guest.asSocket, io, { ...user, _id: 'user-guest' });
    await guest.trigger('draw:join', { channelId: CH, sessionId: SESSION });
    ioEmissions.length = 0;

    await host.trigger('disconnect');

    expect(findEmitted(ioEmissions, 'draw:host-changed')?.data)
      .toMatchObject({ newHostSocketId: 'sock-guest', newHostUserId: 'user-guest' });
    expect(ioEmissions.some(e => e.event === 'draw:participant-left')).toBe(true);
    expect(drawSessions.get(CH)?.hostSocketId).toBe('sock-guest');
  });

  it('HOST OLMAYAN ayrılınca sahiplik devri YAYILMAZ', async () => {
    await joinedSocket('sock-host');
    const guest = makeSocket('sock-guest', [CH]);
    registerDrawTogetherHandlers(guest.asSocket, io, { ...user, _id: 'user-guest' });
    await guest.trigger('draw:join', { channelId: CH, sessionId: SESSION });
    ioEmissions.length = 0;

    await guest.trigger('disconnect');

    expect(ioEmissions.some(e => e.event === 'draw:host-changed')).toBe(false);
    expect(ioEmissions.some(e => e.event === 'draw:participant-left')).toBe(true);
  });

  it('katılmamış soketin kopması olay üretmez', async () => {
    const socket = makeSocket('sock-yalniz', [CH]);
    registerDrawTogetherHandlers(socket.asSocket, io, user);

    await socket.trigger('disconnect');

    expect(ioEmissions).toHaveLength(0);
  });
});
