// server/tests/socket-index-bot-and-routing.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SOKET GİRİŞİ — BOT KİMLİĞİ, NODE YÖNLENDİRME VE İSTATİSTİK ANLIK GÖRÜNTÜSÜ
// ════════════════════════════════════════════════════════════════════════════
//
// `socket-index-behavior.test.ts` kullanıcı JWT durum makinesini ölçer. Bu
// dosya kalan üç yolu kapatır ve her biri gerçek bir üretim riski taşır:
//
//   · BOT SOKETİ — bot bağlantısı KOMUT kapsamlıdır: yalnız kendi özel
//     odasına katılır. Sunucu/kanal odalarına abone edilirse sunucu geneline
//     yetkili bir bot, ÖZEL kanal trafiğini de görürdü.
//   · NODE YÖNLENDİRME — SFU soketi belirli bir düğüm ister. Yanlış düğüme
//     düşen bağlantı sessizce kabul edilirse istemci sonsuz yönlendirme
//     döngüsüne girer; açık bir hata ile reddedilmelidir.
//   · REZERVASYON SIZINTISI — her ret yolunda bağlantı-limiti rezervasyonu
//     serbest bırakılmalıdır; bırakılmazsa kota, hiç kurulmamış bağlantılarla
//     dolar ve meşru kullanıcılar bağlanamaz.

process.env.NODE_ENV = 'test';

jest.useFakeTimers();

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockVerifyToken = jest.fn();
const mockUsersFindById = jest.fn();
const mockUsersUpdate = jest.fn();
const mockGetBan = jest.fn();
// Imza ACIKCA yazilir: @types/jest'te `Mock<T, Y>` icin Y varsayilani
// `any`dir (`any[]` DEGIL), yani bare `jest.fn()` REST parametresi
// tasimaz ve `mock(...args)` TS2556 verir.
const mockGetClientIp = jest.fn<string, unknown[]>(() => '203.0.113.10');
const mockApplyAdapter = jest.fn();
const mockIpRateCheck = jest.fn();
const mockTrackSocket = jest.fn();
const mockSetupMemberships = jest.fn();
const mockHandleDisconnect = jest.fn();
const mockIsSFUReady = jest.fn();
const mockResolveBotToken = jest.fn();
const mockWsMiddleware = jest.fn((_s: any, next: any) => next());

// Uretimde `voiceRooms` hem Map hem nesne gibi okunabilen bir Proxy'dir ve
// `getSocketStats()` NESNE yuzeyini (`Object.keys/values`) kullanir. Duz bir
// Map ikizi o yuzeyi tasimaz ve istatistikleri sessizce sifir gosterirdi.
const voiceStore = new Map<string, any[]>();
const voiceRooms = new Proxy(voiceStore as any, {
  get(target, prop, receiver) {
    if (typeof prop === 'string' && !(prop in target)) return voiceStore.get(prop);
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
  ownKeys() { return [...voiceStore.keys()]; },
  getOwnPropertyDescriptor(_target, prop) {
    if (typeof prop === 'string' && voiceStore.has(prop)) return { enumerable: true, configurable: true };
    return undefined;
  },
});
const voiceActivity = new Map();
const socketRateStore = new Map();

jest.mock('../lib/logger', () => mockLogger);
jest.mock('../middleware/auth', () => ({
  verifyToken: (...a: any[]) => mockVerifyToken(...a),
  _invalidateTokenCache: jest.fn(),
}));
jest.mock('../middleware/botAuth', () => ({ resolveBotToken: (...a: any[]) => mockResolveBotToken(...a) }));
jest.mock('../lib/userUtils', () => ({
  sanitizeUser: (u: any) => ({ _id: u._id, username: u.username, displayName: u.displayName }),
  normalizePresenceVisibility: (v: unknown) => (v === 'hidden' ? 'hidden' : 'visible'),
  normalizePresenceStatus: (v: unknown) =>
    (v === 'online' || v === 'idle' || v === 'dnd' || v === 'offline' ? v : 'online'),
}));
jest.mock('../db/repositories', () => ({
  Users: { findById: (...a: any[]) => mockUsersFindById(...a), update: (...a: any[]) => mockUsersUpdate(...a) },
}));
jest.mock('../middleware/ipBan', () => ({
  getBan: (...a: any[]) => mockGetBan(...a),
  getClientIp: (...a: any[]) => mockGetClientIp(...a),
}));
jest.mock('../lib/redisAdapter', () => ({ applyAdapter: (...a: any[]) => mockApplyAdapter(...a) }));
jest.mock('../socket/ipRateLimit', () => ({
  ipRateCheck: (...a: any[]) => mockIpRateCheck(...a),
  IP_SOCKET_RL: { connect: { windowMs: 12_000 } },
}));
jest.mock('../socket/socketRateLimit', () => ({
  createRateLimitedSocket: (socket: any) => socket,
  _socketRateStore: socketRateStore,
}));
jest.mock('../socket/middleware/wsConnectionLimit', () => ({
  wsConnectionLimitMiddleware: () => mockWsMiddleware,
}));
jest.mock('../lib/presenceCache', () => ({ trackSocket: (...a: any[]) => mockTrackSocket(...a) }));
jest.mock('../socket/handlers/messages', () => ({ registerMessageHandlers: jest.fn(), registerThreadSocketEvents: jest.fn() }));
jest.mock('../socket/handlers/voice', () => ({
  registerVoiceHandlers: jest.fn(), leaveVoice: jest.fn(), voiceRooms, voiceActivity,
}));
jest.mock('../socket/handlers/music', () => ({ registerMusicHandlers: jest.fn() }));
jest.mock('../socket/handlers/dm', () => ({ registerDmHandlers: jest.fn(), registerGroupDmHandlers: jest.fn() }));
jest.mock('../socket/handlers/stage', () => ({ registerStageHandlers: jest.fn(), bindStageMediaClusterControl: jest.fn() }));
jest.mock('../socket/handlers/stage-video-grid', () => ({ registerVideoGridHandlers: jest.fn() }));
jest.mock('../socket/handlers/mediasoup/index', () => ({
  registerSFUHandlers: jest.fn(), isSFUReady: (...a: any[]) => mockIsSFUReady(...a),
}));
jest.mock('../socket/handlers/infra', () => ({
  registerInfraHandlers: jest.fn(), handleDisconnect: (...a: any[]) => mockHandleDisconnect(...a),
}));
jest.mock('../socket/handlers/canvas', () => ({ registerCanvasHandlers: jest.fn() }));
jest.mock('../socket/handlers/dm-read', () => ({ registerDmReadHandlers: jest.fn() }));
jest.mock('../socket/handlers/discover', () => ({ registerDiscoverHandlers: jest.fn(), pushMemberCount: jest.fn() }));
jest.mock('../socket/handlers/activities', () => ({ registerActivityHandlers: jest.fn() }));
jest.mock('../socket/handlers/super-reactions', () => ({ registerSuperReactionHandlers: jest.fn() }));
jest.mock('../socket/handlers/clips', () => ({ registerClipHandlers: jest.fn() }));
jest.mock('../socket/handlers/activities/draw-together', () => ({ registerDrawTogetherHandlers: jest.fn() }));
jest.mock('../socket/handlers/channelE2EEHandlers', () => ({ registerChannelE2EEHandlers: jest.fn() }));
jest.mock('../socket/handlers/members', () => ({ setupMemberships: (...a: any[]) => mockSetupMemberships(...a) }));

function makeSocket(over: Record<string, any> = {}) {
  const handlers = new Map<string, Function>();
  return {
    id: 'sock-bot',
    handshake: { address: '10.0.0.4', headers: {}, auth: {}, query: {} },
    conn: { remoteAddress: '10.0.0.5' },
    _bridgeMarkAuthenticated: jest.fn().mockResolvedValue(true),
    _bridgeReleaseConnectionLimit: jest.fn().mockResolvedValue(undefined),
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event: string, fn: Function) => { handlers.set(event, fn); }),
    disconnect: jest.fn(),
    removeAllListeners: jest.fn(),
    handlers,
    ...over,
  } as any;
}

function makeIo() {
  const middleware: Function[] = [];
  let connection: Function | undefined;
  const emit = jest.fn();
  const io: any = {
    use: jest.fn((fn: Function) => middleware.push(fn)),
    on: jest.fn((event: string, fn: Function) => { if (event === 'connection') connection = fn; }),
    to: jest.fn(() => ({ emit })),
  };
  return { io, middleware, get connection() { return connection!; }, emit };
}

function invoke(fn: Function, socket: any): Promise<any> {
  return new Promise((resolve) => { void fn(socket, (err?: any) => resolve(err ?? null)); });
}

async function setup() {
  jest.resetModules();
  const mod = require('../socket/index') as typeof import('../socket/index');
  const harness = makeIo();
  mod.setupSocket(harness.io as never);
  await Promise.resolve();
  return { mod, ...harness };
}

/** Kimlik doğrulama ara katmanı (WS limiti, IP ban, IP hızı, ardından auth). */
const authMiddleware = (middleware: Function[]) => middleware[middleware.length - 1]!;

beforeEach(() => {
  jest.clearAllTimers();
  jest.clearAllMocks();
  voiceStore.clear();
  socketRateStore.clear();
  mockApplyAdapter.mockResolvedValue(true);
  mockGetBan.mockResolvedValue(null);
  mockIpRateCheck.mockResolvedValue(true);
  mockVerifyToken.mockReturnValue({ id: 'u1', username: 'alice', v: 3 });
  mockUsersFindById.mockResolvedValue({
    _id: 'u1', username: 'alice', displayName: 'Alice', tokenVersion: 3,
    presenceVisibility: 'visible',
  });
  mockUsersUpdate.mockResolvedValue(undefined);
  mockTrackSocket.mockResolvedValue(undefined);
  mockSetupMemberships.mockResolvedValue({ memberships: [], refreshMemberships: jest.fn() });
  mockIsSFUReady.mockReturnValue(false);
  mockHandleDisconnect.mockResolvedValue(undefined);
  mockResolveBotToken.mockResolvedValue(null);
});

describe('bot kimliği', () => {
  it('geçerli bot jetonu kabul edilir ve soket bot olarak işaretlenir', async () => {
    const { middleware } = await setup();
    mockResolveBotToken.mockResolvedValue({ _id: 'bot-1', serverId: 's1', username: 'yardimci' });
    const socket = makeSocket({ handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'brg_bot_abc' }, query: {} } });

    const err = await invoke(authMiddleware(middleware), socket);

    expect(err).toBeNull();
    expect(socket.isBot).toBe(true);
    expect(socket.botId).toBe('bot-1');
    expect(socket.botServerId).toBe('s1');
    expect(socket.username).toBe('yardimci');
    // Kullanici JWT yolu HIC calismaz.
    expect(mockVerifyToken).not.toHaveBeenCalled();
  });

  it('tanınmayan bot jetonu reddedilir ve rezervasyon serbest bırakılır', async () => {
    const { middleware } = await setup();
    mockResolveBotToken.mockResolvedValue(null);
    const socket = makeSocket({ handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'brg_bot_yok' }, query: {} } });

    const err = await invoke(authMiddleware(middleware), socket);

    expect((err as Error).message).toBe('Unauthorized');
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
    expect(socket.isBot).toBeUndefined();
  });

  it('bot jetonu çözümlemesi çökerse bağlantı fail-closed reddedilir', async () => {
    const { middleware } = await setup();
    mockResolveBotToken.mockRejectedValue(new Error('bot store offline'));
    const socket = makeSocket({ handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'brg_bot_abc' }, query: {} } });

    const err = await invoke(authMiddleware(middleware), socket);

    expect((err as Error).message).toBe('Auth check failed');
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
  });

  it('bot bağlantı kotası dolduğunda ret verilir', async () => {
    const { middleware } = await setup();
    mockResolveBotToken.mockResolvedValue({ _id: 'bot-1', serverId: 's1', username: 'yardimci' });
    const socket = makeSocket({
      handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'brg_bot_abc' }, query: {} },
      _bridgeMarkAuthenticated: jest.fn().mockResolvedValue(false),
    });

    const err = await invoke(authMiddleware(middleware), socket);

    expect((err as Error).message).toBe('TOO_MANY_CONNECTIONS_FROM_USER');
    expect(socket._bridgeMarkAuthenticated).toHaveBeenCalledWith('bot:bot-1');
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
  });

  it('bağlantı kotası yüzeyi olmayan dağıtımda bot yine kabul edilir', async () => {
    const { middleware } = await setup();
    mockResolveBotToken.mockResolvedValue({ _id: 'bot-1', serverId: 's1', username: 'yardimci' });
    const socket = makeSocket({
      handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'brg_bot_abc' }, query: {} },
      _bridgeMarkAuthenticated: undefined,
    });

    expect(await invoke(authMiddleware(middleware), socket)).toBeNull();
  });

  it('bot soketi YALNIZ kendi özel odasına katılır', async () => {
    const { connection } = await setup();
    const socket = makeSocket({ isBot: true, botId: 'bot-1', botServerId: 's1' });

    await connection(socket);

    expect(socket.join).toHaveBeenCalledTimes(1);
    expect(socket.join).toHaveBeenCalledWith('bot:bot-1');
    expect(socket.emit).toHaveBeenCalledWith('botAuthenticated', { botId: 'bot-1', serverId: 's1' });
    // Kullanici kurulum yolu HIC calismaz: sunucu/kanal odalarina abone olunmaz.
    expect(mockSetupMemberships).not.toHaveBeenCalled();
    expect(mockTrackSocket).not.toHaveBeenCalled();
  });

  it('eksik bot kimliği normal kullanıcı yoluna düşer', async () => {
    const { connection } = await setup();
    const socket = makeSocket({ isBot: true, botId: 'bot-1' });

    await connection(socket);

    // `botServerId` yoksa bot kisa yolu KULLANILMAZ; kimliksiz soket duser.
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});

describe('düğüm yönlendirme', () => {
  it('yanlış düğüme düşen SFU soketi açık bir hatayla reddedilir', async () => {
    const previous = process.env.INSTANCE_ID;
    process.env.INSTANCE_ID = 'node-a';
    try {
      const { middleware } = await setup();
      const socket = makeSocket({
        handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: { bridgeNode: 'node-b' } },
      });

      const err = await invoke(authMiddleware(middleware), socket);

      expect((err as Error).message).toBe('SFU route mismatch');
      expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
      expect(mockVerifyToken).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = previous;
    }
  });

  it('doğru düğüm istendiğinde bağlantı normal yoluna devam eder', async () => {
    const previous = process.env.INSTANCE_ID;
    process.env.INSTANCE_ID = 'node-a';
    try {
      const { middleware } = await setup();
      const socket = makeSocket({
        handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: { bridgeNode: 'node-a' } },
      });

      expect(await invoke(authMiddleware(middleware), socket)).toBeNull();
      expect(socket.userId).toBe('u1');
    } finally {
      if (previous === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = previous;
    }
  });

  it('dizi biçiminde gelen düğüm isteği ilk değerinden okunur', async () => {
    const previous = process.env.INSTANCE_ID;
    process.env.INSTANCE_ID = 'node-a';
    try {
      const { middleware } = await setup();
      const socket = makeSocket({
        handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: { bridgeNode: ['node-b', 'node-a'] } },
      });

      expect((await invoke(authMiddleware(middleware), socket) as Error).message).toBe('SFU route mismatch');
    } finally {
      if (previous === undefined) delete process.env.INSTANCE_ID; else process.env.INSTANCE_ID = previous;
    }
  });

  it('boş ya da metin olmayan düğüm isteği yok sayılır', async () => {
    const { middleware } = await setup();

    for (const bridgeNode of ['', 42, null, undefined]) {
      const socket = makeSocket({
        handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: { bridgeNode } },
      });
      expect(await invoke(authMiddleware(middleware), socket)).toBeNull();
    }
  });

  it('INSTANCE_ID tanımsızsa süreç kimliğinden türetilir', async () => {
    const previous = process.env.INSTANCE_ID;
    delete process.env.INSTANCE_ID;
    try {
      const { middleware } = await setup();
      const socket = makeSocket({
        handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: { bridgeNode: `node-${process.pid}` } },
      });

      expect(await invoke(authMiddleware(middleware), socket)).toBeNull();
    } finally {
      if (previous !== undefined) process.env.INSTANCE_ID = previous;
    }
  });
});

describe('bağlantı kotası hata metni', () => {
  it('kota katmanı hata fırlatırsa mesajı korunur', async () => {
    const { middleware } = await setup();
    const socket = makeSocket({
      _bridgeMarkAuthenticated: jest.fn().mockRejectedValue(new Error('quota backend down')),
      handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: {} },
    });

    const err = await invoke(authMiddleware(middleware), socket);

    expect((err as Error).message).toBe('quota backend down');
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
  });

  it('mesajsız arıza genel bir metne düşer', async () => {
    const { middleware } = await setup();
    const socket = makeSocket({
      _bridgeMarkAuthenticated: jest.fn().mockRejectedValue({ code: 'E_NO_MESSAGE' }),
      handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' }, query: {} },
    });

    const err = await invoke(authMiddleware(middleware), socket);

    expect((err as Error).message).toBe('Too many user connections');
  });
});

describe('istemci IP çözümü ve istatistikler', () => {
  it('taşıma katmanı uzak adresi yoksa el sıkışma adresine düşülür', async () => {
    const { middleware } = await setup();
    const socket = makeSocket({ conn: undefined });

    await invoke(middleware[1]!, socket);

    const [fakeReq] = mockGetClientIp.mock.calls[0]!;
    expect((fakeReq as { socket: { remoteAddress: string } }).socket.remoteAddress).toBe('10.0.0.4');
  });

  it('istatistik anlık görüntüsü ses odalarını ve katılımcıları sayar', async () => {
    const { mod } = await setup();
    voiceStore.set('c1', [{ socketId: 's1' }, { socketId: 's2' }]);
    voiceStore.set('c2', [{ socketId: 's3' }]);
    voiceStore.set('c3', []);

    const stats = mod.getSocketStats();

    expect(stats.voiceRooms).toBe(3);
    expect(stats.voicePeers).toBe(3);
    expect(stats.connectedSockets).toBe(0);
    expect(stats.activeTyping).toBe(0);
  });

  it('boş ses odaları süpürgeyle temizlenir', async () => {
    await setup();
    voiceStore.set('bos', []);
    voiceStore.set('dolu', [{ socketId: 's1' }]);

    jest.advanceTimersByTime(10 * 60_000);

    expect(voiceStore.has('bos')).toBe(false);
    expect(voiceStore.has('dolu')).toBe(true);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
