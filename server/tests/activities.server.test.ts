// server/tests/activities.server.test.ts
// Faz 12 — CANLI activity socket sözleşmesi regresyonu.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN YENİDEN YAZILDI
// ════════════════════════════════════════════════════════════════════════════
// Bu dosyanın önceki hâli üretimden HİÇBİR ŞEY import etmiyordu; 14 testi
// `validatePayload` / `createSession` / `serializeSession` gibi fonksiyonların
import { findEmitted, requireEmitted } from './helpers/socketDoubles';
// TEST DOSYASI İÇİNDEKİ yerel kopyalarını doğruluyordu. Dolayısıyla
// `registerActivityHandlers` hiç çalıştırılmıyor, hiçbir socket olayı
// kapsanmıyordu — 12/12 PASS yanıltıcı bir güven veriyordu.
//
// Buradaki testler GERÇEK üretim modülünü çalıştırır:
//   registerActivityHandlers → kayıtlı callback → gerçek dal → socket/io etkisi
//
// KAYNAKTAN DOĞRULANMIŞ SÖZLEŞME (socket/handlers/activities.ts):
//   registerActivityHandlers(socket, io, userId: string)
//   ALLOWED_ACTIVITY_IDS: watch-together, chess, draw-together, word-snack, trivia
//   _sessions: Map<channelId, session>  (modül seviyesi, in-memory)
//
//   activity:start (:63)
//     bilinmeyen id           → activity:error
//     kanalda oturum var      → activity:error (mevcut korunur)
//     resolvePermissions + hasPermission(PERMS.CONNECT) başarısız → activity:error
//     başarı                  → io.to(`channel:${id}`).emit('activity:started', …)
//
//   activity:join (:115)
//     oturum yok VEYA sessionId EŞLEŞMİYOR → activity:error
//     başarı → participants_updated (odaya) + activity:join_ok (sokete)
//
//   activity:leave (:143)
//     participants.size === 0 VEYA hostUserId === userId → oturum silinir +
//       activity:ended   ← host çıkışı ve son-kullanıcı AYNI DALDIR
//     aksi hâlde → activity:participants_updated
//
//   activity:list (:171) → activity:list_result (serialize edilmiş oturum | null)
//
// DURUM İZOLASYONU: `_sessions` modül seviyesindedir ve üretimde test için
// sıfırlama API'si YOKTUR (eklemek de yasaktır). Bu yüzden her test BENZERSİZ
// channelId kullanır; testler birbirinin durumunu göremez ve sıraya bağlı değildir.

'use strict';
process.env.NODE_ENV = 'test';

const mockValidate     = jest.fn(() => ({ valid: true }));
const mockResolvePerms = jest.fn();
const mockHasPerm      = jest.fn();
const mockFindChannel   = jest.fn();

jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...a: unknown[]) => mockValidate(...(a as [])),
  socketSchemas: { activityStart: {}, activityJoin: {}, activityChannelId: {} },
}));

jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...a: unknown[]) => mockResolvePerms(...(a as [])),
  hasPermission:      (...a: unknown[]) => mockHasPerm(...(a as [])),
  PERMS: { VIEW_CHANNELS: 0x400, CONNECT: 0x100 },
}));

jest.mock('../db/repositories', () => ({
  Channels: { findById: (...a: unknown[]) => mockFindChannel(...(a as [])) },
}));

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Alt aktiviteler bu sözleşmenin parçası değil; ağır bağımlılıkları izole edilir.
jest.mock('../socket/handlers/activities/draw-together', () => ({
  registerDrawTogetherHandlers: jest.fn(),
}));
jest.mock('../socket/handlers/activities/chess-arbiter', () => ({
  registerChessHandlers: jest.fn(),
}));

import { registerActivityHandlers } from '../socket/handlers/activities';

// ── Harness (dm-socket / messages-send desenine uyar) ────────────────────────

type Emitted = { ev: string; data: unknown; room?: string };

let _socketN = 0;
function makeSocket() {
  const handlers: Record<string, (p: unknown) => unknown> = {};
  const emitted: Emitted[] = [];
  const rooms = { has: jest.fn(() => true) };
  return {
    id: `activity-test-socket-${++_socketN}`,
    rooms,
    on(ev: string, fn: (p: unknown) => unknown) { handlers[ev] = fn; },
    emit(ev: string, data?: unknown) { emitted.push({ ev, data }); },
    join() {}, leave() {},
    _emitted: emitted,
    _handlers: handlers,
    async _trigger(ev: string, payload: unknown) { return handlers[ev]?.(payload); },
  };
}

function makeIo() {
  const emitted: Emitted[] = [];
  return {
    _emitted: emitted,
    to(room: string) {
      return { emit(ev: string, data: unknown) { emitted.push({ ev, data, room }); } };
    },
  };
}

let _n = 0;
/** Her test için benzersiz kanal — modül seviyesi `_sessions` sızıntısını önler. */
const uniqueChannel = () => `ch-act-${Date.now()}-${++_n}`;

const HOST  = 'user-host';
const OTHER = 'user-other';

function wire(userId: string, sharedIo?: ReturnType<typeof makeIo>) {
  const socket = makeSocket();
  const io     = sharedIo ?? makeIo();
  registerActivityHandlers(socket as never, io as never, userId);
  return { socket, io };
}

const errors  = (s: ReturnType<typeof makeSocket>) => s._emitted.filter(e => e.ev === 'activity:error');
const started = (io: ReturnType<typeof makeIo>)    => io._emitted.filter(e => e.ev === 'activity:started');

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockReturnValue({ valid: true });
  mockResolvePerms.mockResolvedValue(0xffffffff);
  mockHasPerm.mockReturnValue(true);       // VIEW_CHANNELS + CONNECT verilir
  mockFindChannel.mockResolvedValue({ serverId: 'srv-1' });
});

// ════════════════════════════════════════════════════════════════
// activity:start
// ════════════════════════════════════════════════════════════════

describe('activity:start', () => {
  it('BİLİNMEYEN aktivite id → activity:error, oturum ve yayın YOK', async () => {
    const ch = uniqueChannel();
    const { socket, io } = wire(HOST);

    await socket._trigger('activity:start', { activityId: 'yok-boyle', channelId: ch, serverId: 'srv-1' });

    expect(errors(socket)).toHaveLength(1);
    expect(started(io)).toHaveLength(0);
  });

  it('GEÇERLİ başlatma → kanal odasına activity:started, host katılımcılarda', async () => {
    const ch = uniqueChannel();
    const { socket, io } = wire(HOST);

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errors(socket)).toHaveLength(0);
    const ev = started(io)[0];
    expect(ev).toBeDefined();
    expect(ev!.room).toBe(`channel:${ch}`);          // doğru odaya yayın
    const data = ev!.data as { activityId: string; hostUserId: string; participants: string[]; sessionId: string };
    expect(data.activityId).toBe('chess');
    expect(data.hostUserId).toBe(HOST);
    expect(data.participants).toEqual([HOST]);
    expect(typeof data.sessionId).toBe('string');
  });

  it('AYNI kanalda ikinci başlatma → activity:error, mevcut oturum korunur', async () => {
    const ch = uniqueChannel();
    const { socket, io } = wire(HOST);
    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const firstSessionId = (started(io)[0]!.data as { sessionId: string }).sessionId;

    await socket._trigger('activity:start', { activityId: 'trivia', channelId: ch, serverId: 'srv-1' });

    expect(errors(socket)).toHaveLength(1);
    expect(started(io)).toHaveLength(1);             // yeni yayın yok

    // Mevcut oturum değişmedi
    await socket._trigger('activity:list', { channelId: ch });
    const listed = socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data as { sessionId: string; activityId: string };
    expect(listed.sessionId).toBe(firstSessionId);
    expect(listed.activityId).toBe('chess');
  });

  it('KANAL İZNİ YOKKEN → activity:error, oturum ve yayın YOK (güvenlik sınırı)', async () => {
    const ch = uniqueChannel();
    mockHasPerm.mockReturnValue(false);              // CONNECT reddedilir
    const { socket, io } = wire(HOST);

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errors(socket)).toHaveLength(1);
    expect(started(io)).toHaveLength(0);

    // Oturum gerçekten oluşmadı
    await socket._trigger('activity:list', { channelId: ch });
    expect(socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data).toBeNull();
  });

  it('socket gerçek voice room içinde değilse activity başlatamaz', async () => {
    const ch = uniqueChannel();
    const { socket, io } = wire(HOST);
    socket.rooms.has.mockReturnValue(false);

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errors(socket)).toHaveLength(1);
    expect(started(io)).toHaveLength(0);
    expect(mockResolvePerms).not.toHaveBeenCalled();
  });

  it('istemcinin serverId iddiası kanalın gerçek sunucusuyla eşleşmezse reddedilir', async () => {
    const ch = uniqueChannel();
    mockFindChannel.mockResolvedValue({ serverId: 'srv-real' });
    const { socket, io } = wire(HOST);

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-forged' });

    expect(errors(socket)).toHaveLength(1);
    expect(started(io)).toHaveLength(0);
    expect(mockResolvePerms).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// activity:join
// ════════════════════════════════════════════════════════════════

describe('activity:join', () => {
  it('OLMAYAN oturum → activity:error, join_ok ve participants_updated YOK', async () => {
    const ch = uniqueChannel();
    const { socket, io } = wire(OTHER);

    await socket._trigger('activity:join', { channelId: ch, sessionId: 'yok' });

    expect(errors(socket)).toHaveLength(1);
    expect(socket._emitted.filter(e => e.ev === 'activity:join_ok')).toHaveLength(0);
    expect(io._emitted.filter(e => e.ev === 'activity:participants_updated')).toHaveLength(0);
  });

  it('YANLIŞ sessionId → activity:error (oturum var ama eşleşmiyor)', async () => {
    const ch = uniqueChannel();
    const host = wire(HOST);
    await host.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    const joiner = wire(OTHER);
    await joiner.socket._trigger('activity:join', { channelId: ch, sessionId: 'hatali-id' });

    expect(errors(joiner.socket)).toHaveLength(1);
    expect(joiner.socket._emitted.filter(e => e.ev === 'activity:join_ok')).toHaveLength(0);
  });

  it('GEÇERLİ katılım → join_ok sokete, participants_updated odaya', async () => {
    const ch = uniqueChannel();
    const host = wire(HOST);
    await host.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const sid = (started(host.io)[0]!.data as { sessionId: string }).sessionId;

    const joiner = wire(OTHER);
    await joiner.socket._trigger('activity:join', { channelId: ch, sessionId: sid });

    const ok = requireEmitted(joiner.socket._emitted, 'activity:join_ok');
    expect(ok).toBeDefined();
    expect((ok!.data as { participants: string[] }).participants).toEqual(expect.arrayContaining([HOST, OTHER]));

    const upd = requireEmitted(joiner.io._emitted, 'activity:participants_updated');
    expect(upd).toBeDefined();
    expect(upd!.room).toBe(`channel:${ch}`);
    expect((upd!.data as { participants: string[] }).participants).toEqual(expect.arrayContaining([HOST, OTHER]));
  });

  it('join sırasında kanal izni artık yoksa sessionId doğru olsa bile katılım reddedilir', async () => {
    const ch = uniqueChannel();
    const host = wire(HOST);
    await host.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const sid = (started(host.io)[0]!.data as { sessionId: string }).sessionId;

    mockHasPerm.mockReturnValue(false);
    const joiner = wire(OTHER);
    await joiner.socket._trigger('activity:join', { channelId: ch, sessionId: sid });

    expect(errors(joiner.socket)).toHaveLength(1);
    expect(joiner.socket._emitted.filter(e => e.ev === 'activity:join_ok')).toHaveLength(0);
    expect(joiner.io._emitted.filter(e => e.ev === 'activity:participants_updated')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// activity:leave
// ════════════════════════════════════════════════════════════════

describe('activity:leave', () => {
  it('HOST çıkarsa oturum BİTER → activity:ended ve oturum kalmaz', async () => {
    const ch = uniqueChannel();
    const host = wire(HOST);
    await host.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    await host.socket._trigger('activity:leave', { channelId: ch });

    const ended = requireEmitted(host.io._emitted, 'activity:ended');
    expect(ended).toBeDefined();
    expect(ended!.room).toBe(`channel:${ch}`);

    await host.socket._trigger('activity:list', { channelId: ch });
    expect(host.socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data).toBeNull();
  });

  it('SON katılımcı çıkarsa oturum BİTER (aynı dal: size===0 || host)', async () => {
    // Kaynak (:154) her iki koşulu TEK dalda birleştirir; burada host olmayan
    // son katılımcı senaryosu ayrıca doğrulanır.
    const ch = uniqueChannel();
    const host = wire(HOST);
    await host.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const sid = (started(host.io)[0]!.data as { sessionId: string }).sessionId;

    const other = wire(OTHER);
    await other.socket._trigger('activity:join', { channelId: ch, sessionId: sid });

    await host.socket._trigger('activity:leave', { channelId: ch });   // host çıkar → biter

    await other.socket._trigger('activity:list', { channelId: ch });
    expect(other.socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data).toBeNull();
  });

  it('SIRADAN katılımcı çıkarsa oturum SÜRER → participants_updated, ended YOK', async () => {
    const ch = uniqueChannel();
    const host = wire(HOST);
    await host.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const sid = (started(host.io)[0]!.data as { sessionId: string }).sessionId;

    const other = wire(OTHER);
    await other.socket._trigger('activity:join', { channelId: ch, sessionId: sid });
    other.io._emitted.length = 0;

    await other.socket._trigger('activity:leave', { channelId: ch });

    expect(other.io._emitted.filter(e => e.ev === 'activity:ended')).toHaveLength(0);
    const upd = requireEmitted(other.io._emitted, 'activity:participants_updated');
    expect(upd).toBeDefined();
    expect((upd!.data as { participants: string[] }).participants).toEqual([HOST]);

    // Oturum hâlâ ayakta
    await host.socket._trigger('activity:list', { channelId: ch });
    expect(host.socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data).not.toBeNull();
  });

  it('aynı kullanıcının bir sekmesi ayrıldığında diğer sekmenin katılımını veya host oturumunu silmez', async () => {
    const ch = uniqueChannel();
    const io = makeIo();
    const firstTab = wire(HOST, io);
    const secondTab = wire(HOST, io);
    await firstTab.socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });
    const sid = (started(io)[0]!.data as { sessionId: string }).sessionId;
    await secondTab.socket._trigger('activity:join', { channelId: ch, sessionId: sid });
    io._emitted.length = 0;

    await firstTab.socket._trigger('disconnect', undefined);

    expect(io._emitted.some(event => event.ev === 'activity:ended')).toBe(false);
    await secondTab.socket._trigger('activity:list', { channelId: ch });
    const listed = secondTab.socket._emitted.filter(event => event.ev === 'activity:list_result').at(-1)?.data;
    expect(listed).toMatchObject({ sessionId: sid, hostUserId: HOST, participants: [HOST] });

    await secondTab.socket._trigger('disconnect', undefined);
    expect(io._emitted.some(event => event.ev === 'activity:ended')).toBe(true);
  });

  it('OLMAYAN kanalda leave güvenlidir (hata fırlatmaz, yayın yok)', async () => {
    const ch = uniqueChannel();
    const { socket, io } = wire(HOST);

    await expect(socket._trigger('activity:leave', { channelId: ch })).resolves.not.toThrow();
    expect(io._emitted).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════
// activity:list
// ════════════════════════════════════════════════════════════════

describe('activity:list', () => {
  it('oturum yokken NULL döner', async () => {
    const ch = uniqueChannel();
    const { socket } = wire(HOST);

    await socket._trigger('activity:list', { channelId: ch });

    const res = requireEmitted(socket._emitted, 'activity:list_result');
    expect(res).toBeDefined();
    expect(res!.data).toBeNull();
  });

  it('aktif oturumu SERIALIZE edilmiş döner', async () => {
    const ch = uniqueChannel();
    mockFindChannel.mockResolvedValue({ serverId: 'srv-9' });
    const { socket } = wire(HOST);
    await socket._trigger('activity:start', { activityId: 'trivia', channelId: ch, serverId: 'srv-9' });

    await socket._trigger('activity:list', { channelId: ch });

    const data = socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data as Record<string, unknown>;
    expect(data.activityId).toBe('trivia');
    expect(data.channelId).toBe(ch);
    expect(data.serverId).toBe('srv-9');
    expect(data.hostUserId).toBe(HOST);
    expect(Array.isArray(data.participants)).toBe(true);   // Set → dizi
  });

  it('aktif oturum gizli hale gelirse list state sızdırmaz', async () => {
    const ch = uniqueChannel();
    const { socket } = wire(HOST);
    await socket._trigger('activity:start', { activityId: 'trivia', channelId: ch, serverId: 'srv-1' });

    mockHasPerm.mockReturnValue(false);
    await socket._trigger('activity:list', { channelId: ch });

    expect(socket._emitted.filter(e => e.ev === 'activity:list_result').at(-1)!.data).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// Payload doğrulama sınırı
// ════════════════════════════════════════════════════════════════

describe('payload doğrulama', () => {
  it('geçersiz payload handler\'ı ERKEN durdurur', async () => {
    const ch = uniqueChannel();
    mockValidate.mockReturnValue({ valid: false });
    const { socket, io } = wire(HOST);

    await socket._trigger('activity:start', { activityId: 'chess', channelId: ch, serverId: 'srv-1' });

    expect(errors(socket)).toHaveLength(0);   // hata bile yayılmaz — erken return
    expect(started(io)).toHaveLength(0);
  });
});
