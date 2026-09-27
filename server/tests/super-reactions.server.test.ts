// server/tests/super-reactions.server.test.ts
// socket/handlers/super-reactions.ts — GERÇEK handler sözleşmesi.
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — SUPER-REACTIONS SOCKET COVERAGE GAP KAPATMA
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR: `registerSuperReactionHandlers` üretimde CANLI ama hiçbir test
// dosyası ona atıfta bulunmuyordu (kapsam 0). Bu dosya gerçek handler'ı
// çalıştırır: kayıtlı `super_reaction:add` callback'i alınır ve gerçek dallar
// yürütülür. Yalnız DB / socket / io / doğrulama sınırları mock'lanır.
//
// KAPSANAN CANLI GÜVENCELER:
//   • emoji doğrulama (uzunluk/tip) → super_reaction:error
//   • kullanıcı+mesaj başına COOLDOWN (5 sn) → super_reaction:error
//   • mesaj varlığı VE `msg.channelId === channelId` kapsam kontrolü
//   • izin: resolvePermissions + PERMS.ADD_REACTIONS
//   • message aggregate üzerindeki atomik Super Reaction sayacı
//   • kanal yayını `io.to('channel:<id>').emit('super_reaction:received', …)`
//   • hata izolasyonu: handler throw ETMEZ
//

const mockValidate = jest.fn(() => ({ valid: true }));
const mockResolvePerms = jest.fn();
const mockHasPermission = jest.fn();
const mockMessages = { findById: jest.fn(), incrementSuperReactionAtomic: jest.fn() };

jest.mock('../middleware/validate', () => ({
  validateSocketPayload: (...a: unknown[]) => mockValidate(...(a as [])),
  socketSchemas: { superReactionAdd: {} },
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../lib/permissions', () => ({
  resolvePermissions: (...a: unknown[]) => mockResolvePerms(...(a as [])),
  hasPermission: (...a: unknown[]) => mockHasPermission(...(a as [])),
  PERMS: { VIEW_CHANNELS: 1 << 0, ADD_REACTIONS: 1 << 12 },
}));
jest.mock('../db/repositories', () => ({ Messages: mockMessages }));

import { registerSuperReactionHandlers } from '../socket/handlers/super-reactions';

const CHANNEL = 'ch-1';
const SERVER = 'srv-1';
const USER = 'user-1';

type Handler = (payload: unknown) => Promise<void>;

function makeHarness(userId = USER) {
  const emitted: { event: string; payload: unknown }[] = [];
  const roomEmits: { room: string; event: string; payload: unknown }[] = [];
  let handler: Handler | undefined;

  const socket = {
    on: jest.fn((event: string, fn: Handler) => { if (event === 'super_reaction:add') handler = fn; }),
    emit: jest.fn((event: string, payload: unknown) => { emitted.push({ event, payload }); }),
  };
  const io = {
    to: jest.fn((room: string) => ({
      emit: (event: string, payload: unknown) => { roomEmits.push({ room, event, payload }); },
    })),
  };

  registerSuperReactionHandlers(socket as never, io as never, userId);

  return { socket, io, emitted, roomEmits, fire: (p: unknown) => handler!(p) };
}

/** Her testte benzersiz messageId — cooldown haritası modül düzeyinde yaşar. */
let msgSeq = 0;
function freshMessageId(): string { return `msg-${++msgSeq}-${Date.now()}`; }

function validPayload(overrides: Record<string, unknown> = {}) {
  return { messageId: freshMessageId(), channelId: CHANNEL, emoji: '🔥', ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidate.mockReturnValue({ valid: true });
  mockResolvePerms.mockResolvedValue((1 << 0) | (1 << 12));
  mockHasPermission.mockReturnValue(true);
  mockMessages.findById.mockImplementation(async () => ({ channelId: CHANNEL, serverId: SERVER }));
  mockMessages.incrementSuperReactionAtomic.mockResolvedValue(1);
});

describe('super_reaction:add — kayıt ve doğrulama', () => {
  test('handler super_reaction:add olayına kaydolur', () => {
    const h = makeHarness();

    expect(h.socket.on).toHaveBeenCalledWith('super_reaction:add', expect.any(Function));
  });

  test('şema doğrulaması başarısızsa hiçbir iş yapılmaz', async () => {
    mockValidate.mockReturnValue({ valid: false });
    const h = makeHarness();

    await h.fire(validPayload());

    expect(mockMessages.findById).not.toHaveBeenCalled();
    expect(h.emitted).toHaveLength(0);
  });

  test('eksik alanlar sessizce reddedilir', async () => {
    const h = makeHarness();

    await h.fire({ messageId: '', channelId: CHANNEL, emoji: '🔥' });

    expect(mockMessages.findById).not.toHaveBeenCalled();
  });

  test('GÜVENLİK: aşırı uzun emoji reddedilir', async () => {
    const h = makeHarness();

    await h.fire(validPayload({ emoji: 'x'.repeat(9) }));

    expect(h.emitted[0]).toEqual({ event: 'super_reaction:error', payload: { message: 'Geçersiz emoji.' } });
    expect(mockMessages.findById).not.toHaveBeenCalled();
  });
});

describe('super_reaction:add — mesaj kapsamı', () => {
  test('mesaj yoksa hata döner ve reaksiyon yazılmaz', async () => {
    mockMessages.findById.mockResolvedValue(null);
    const h = makeHarness();

    await h.fire(validPayload());

    expect(h.emitted[0].payload).toEqual({ message: 'Mesaj bulunamadı.' });
    expect(mockMessages.incrementSuperReactionAtomic).not.toHaveBeenCalled();
  });

  test('GÜVENLİK: mesaj BAŞKA kanala aitse reddedilir', async () => {
    // Kanal sahteciliğine karşı koruma: msg.channelId !== channelId.
    mockMessages.findById.mockResolvedValue({ channelId: 'other-channel', serverId: SERVER });
    const h = makeHarness();

    await h.fire(validPayload());

    expect(h.emitted[0].payload).toEqual({ message: 'Mesaj bulunamadı.' });
    expect(mockMessages.incrementSuperReactionAtomic).not.toHaveBeenCalled();
  });
});

describe('super_reaction:add — izin', () => {
  test('GÜVENLİK: ADD_REACTIONS izni yoksa reddedilir', async () => {
    mockHasPermission.mockReturnValue(false);
    const h = makeHarness();

    await h.fire(validPayload());

    expect(h.emitted[0].payload).toEqual({ message: 'Reaksiyon ekleme izniniz yok.' });
    expect(mockMessages.incrementSuperReactionAtomic).not.toHaveBeenCalled();
    expect(h.roomEmits).toHaveLength(0);
  });

  test('izin kanal kapsamıyla çözümlenir', async () => {
    const h = makeHarness();
    const payload = validPayload();

    await h.fire(payload);

    expect(mockResolvePerms).toHaveBeenCalledWith(USER, SERVER, CHANNEL);
  });

  test('GÜVENLİK: channel mesajında serverId yoksa fail-closed reddedilir', async () => {
    mockMessages.findById.mockResolvedValue({ channelId: CHANNEL });
    const h = makeHarness();

    await h.fire(validPayload());

    expect(mockResolvePerms).not.toHaveBeenCalled();
    expect(mockMessages.incrementSuperReactionAtomic).not.toHaveBeenCalled();
    expect(h.roomEmits).toHaveLength(0);
  });
});

describe('super_reaction:add — cooldown', () => {
  test('aynı kullanıcı+mesaj için hızlı ikinci istek reddedilir', async () => {
    const h = makeHarness();
    const payload = validPayload();

    await h.fire(payload);
    expect(h.roomEmits).toHaveLength(1);

    await h.fire(payload);   // aynı messageId → cooldown

    expect(h.emitted.at(-1)?.payload).toEqual({ message: 'Çok hızlısınız. Biraz bekleyin.' });
    expect(h.roomEmits).toHaveLength(1);   // ikinci yayın YOK
  });

  test('FARKLI mesaj cooldown’a takılmaz', async () => {
    const h = makeHarness();

    await h.fire(validPayload());
    await h.fire(validPayload());   // farklı messageId

    expect(h.roomEmits).toHaveLength(2);
  });
});

describe('super_reaction:add — mutasyon ve yayın', () => {
  test('canonical message aggregate atomik sayacı kullanılır', async () => {
    mockMessages.incrementSuperReactionAtomic.mockResolvedValue(5);
    const h = makeHarness();
    const payload = validPayload({ emoji: '⚡' });

    await h.fire(payload);

    expect(mockMessages.incrementSuperReactionAtomic).toHaveBeenCalledWith(payload.messageId, '⚡');
    expect(h.roomEmits[0].payload).toEqual(expect.objectContaining({ count: 5 }));
  });

  test('atomik mutasyon mesajı bulamazsa yayın yapılmaz', async () => {
    mockMessages.incrementSuperReactionAtomic.mockResolvedValue(null);
    const h = makeHarness();

    await h.fire(validPayload());

    expect(h.emitted.at(-1)?.payload).toEqual({ message: 'Mesaj bulunamadı.' });
    expect(h.roomEmits).toHaveLength(0);
  });

  test('kanaldaki herkese super_reaction:received yayınlanır', async () => {
    const h = makeHarness();
    const payload = validPayload({ emoji: '🔥' });

    await h.fire(payload);

    expect(h.roomEmits).toHaveLength(1);
    expect(h.roomEmits[0].room).toBe(`channel:${CHANNEL}`);
    expect(h.roomEmits[0].event).toBe('super_reaction:received');
    expect(h.roomEmits[0].payload).toEqual(
      expect.objectContaining({ channelId: CHANNEL, emoji: '🔥', userId: USER, count: 1 }),
    );
  });

  test('yayın burstColor taşır', async () => {
    const h = makeHarness();

    await h.fire(validPayload());

    expect((h.roomEmits[0].payload as { burstColor?: string }).burstColor).toEqual(expect.any(String));
  });
});

describe('super_reaction:add — hata izolasyonu', () => {
  test('depo hatası handler’ı ÇÖKERTMEZ', async () => {
    mockMessages.findById.mockRejectedValue(new Error('db down'));
    const h = makeHarness();

    await expect(h.fire(validPayload())).resolves.toBeUndefined();
    expect(h.roomEmits).toHaveLength(0);
  });
});
