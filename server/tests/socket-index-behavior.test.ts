process.env.NODE_ENV = 'test';

jest.useFakeTimers();

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockVerifyToken = jest.fn();
const mockInvalidateTokenCache = jest.fn();
const mockNormalizePresence = jest.fn((v: unknown) => v === 'hidden' ? 'hidden' : 'visible');
const mockSanitizeUser = jest.fn((u: any) => ({ _id: u._id, username: u.username, displayName: u.displayName }));
const mockUsersFindById = jest.fn();
const mockUsersUpdate = jest.fn();
const mockGetBan = jest.fn();
const mockGetClientIp = jest.fn((..._args: unknown[]) => '203.0.113.10');
const mockApplyAdapter = jest.fn();
const mockIpRateCheck = jest.fn();
const mockTrackSocket = jest.fn();
const mockSetupMemberships = jest.fn();
const mockHandleDisconnect = jest.fn();
const mockIsSFUReady = jest.fn();
const mockWsMiddleware = jest.fn((_s: any, next: any) => next());
const mockWsConnectionLimitMiddleware = jest.fn((..._args: unknown[]) => mockWsMiddleware);

const mockRegisterMessageHandlers = jest.fn();
const mockRegisterThreadSocketEvents = jest.fn();
const mockRegisterVoiceHandlers = jest.fn();
const mockRegisterMusicHandlers = jest.fn();
const mockRegisterDmHandlers = jest.fn();
const mockRegisterGroupDmHandlers = jest.fn();
const mockRegisterStageHandlers = jest.fn();
const mockBindStageMediaClusterControl = jest.fn();
const mockRegisterVideoGridHandlers = jest.fn();
const mockRegisterSFUHandlers = jest.fn();
const mockRegisterInfraHandlers = jest.fn();
const mockRegisterCanvasHandlers = jest.fn();
const mockRegisterDmReadHandlers = jest.fn();
const mockRegisterDiscoverHandlers = jest.fn();
const mockRegisterActivityHandlers = jest.fn();
const mockRegisterSuperReactionHandlers = jest.fn();
const mockRegisterClipHandlers = jest.fn();
const mockRegisterDrawTogetherHandlers = jest.fn();
const mockRegisterChannelE2EEHandlers = jest.fn();

const voiceRooms = new Map<string, any[]>();
const voiceActivity = new Map();
const socketRateStore = new Map();
const socketUsersRateProxy = (socket: any) => socket;

jest.mock('../lib/logger', () => mockLogger);
jest.mock('../middleware/auth', () => ({
  verifyToken: (...args: any[]) => mockVerifyToken(...args),
  _invalidateTokenCache: (...args: any[]) => mockInvalidateTokenCache(...args),
  // Faz 19: bağlantı sınırlayıcısı imzası doğrulanan jetondan kimlik alır. İkiz, JWT
  // ara katmanının `mockVerifyToken` sırasını TÜKETMEMEK için ayrı ve basittir.
  verifiedTokenSubject: (token: unknown) =>
    (typeof token === 'string' && token.startsWith('verified:') ? token.slice('verified:'.length) : null),
}));
jest.mock('../lib/userUtils', () => ({
  sanitizeUser: (user: unknown) => mockSanitizeUser(user),
  normalizePresenceVisibility: (value: unknown) => mockNormalizePresence(value),
  // socket/index.ts resolves the durable presence preference through this
  // helper before deciding the connected status. Omitting it made every
  // connection test throw instead of exercising the state machine.
  normalizePresenceStatus: (value: unknown) =>
    (value === 'online' || value === 'idle' || value === 'dnd' || value === 'offline' ? value : 'online'),
}));
jest.mock('../db/repositories', () => ({
  Users: {
    findById: (...args: any[]) => mockUsersFindById(...args),
    update: (...args: any[]) => mockUsersUpdate(...args),
  },
}));
jest.mock('../middleware/ipBan', () => ({
  getBan: (...args: any[]) => mockGetBan(...args),
  getClientIp: (...args: unknown[]) => mockGetClientIp(...args),
}));
jest.mock('../lib/redisAdapter', () => ({ applyAdapter: (...args: any[]) => mockApplyAdapter(...args) }));
jest.mock('../socket/ipRateLimit', () => ({
  ipRateCheckFor: (...args: any[]) => mockIpRateCheck(...args),
  IP_SOCKET_RL: { connect: { windowMs: 12_000 } },
}));
jest.mock('../socket/socketRateLimit', () => ({
  createRateLimitedSocket: (socket: any) => socketUsersRateProxy(socket),
  _socketRateStore: socketRateStore,
}));
jest.mock('../socket/middleware/wsConnectionLimit', () => ({
  wsConnectionLimitMiddleware: (...args: unknown[]) => mockWsConnectionLimitMiddleware(...args),
}));
jest.mock('../lib/presenceCache', () => ({ trackSocket: (...args: any[]) => mockTrackSocket(...args), startPresenceReaper: jest.fn(), getMembershipsCached: jest.fn(async () => []) }));

jest.mock('../socket/handlers/messages', () => ({
  registerMessageHandlers: (...a: any[]) => mockRegisterMessageHandlers(...a),
  registerThreadSocketEvents: (...a: any[]) => mockRegisterThreadSocketEvents(...a),
}));
jest.mock('../socket/handlers/voice', () => ({
  registerVoiceHandlers: (...a: any[]) => mockRegisterVoiceHandlers(...a),
  leaveVoice: jest.fn(),
  voiceRooms,
  voiceActivity,
}));
jest.mock('../socket/handlers/music', () => ({ registerMusicHandlers: (...a: any[]) => mockRegisterMusicHandlers(...a) }));
jest.mock('../socket/handlers/dm', () => ({
  registerDmHandlers: (...a: any[]) => mockRegisterDmHandlers(...a),
  registerGroupDmHandlers: (...a: any[]) => mockRegisterGroupDmHandlers(...a),
}));
jest.mock('../socket/handlers/stage', () => ({
  registerStageHandlers: (...a: any[]) => mockRegisterStageHandlers(...a),
  // setupSocket() binds the cross-node stage media control channel before
  // any middleware. Leaving it out of this mock made the whole suite throw
  // `bindStageMediaClusterControl is not a function` on every test.
  bindStageMediaClusterControl: (...a: any[]) => mockBindStageMediaClusterControl(...a),
}));
jest.mock('../socket/handlers/stage-video-grid', () => ({ registerVideoGridHandlers: (...a: any[]) => mockRegisterVideoGridHandlers(...a) }));
jest.mock('../socket/handlers/mediasoup/index', () => ({
  registerSFUHandlers: (...a: any[]) => mockRegisterSFUHandlers(...a),
  isSFUReady: (...a: any[]) => mockIsSFUReady(...a),
}));
jest.mock('../socket/handlers/infra', () => ({
  registerInfraHandlers: (...a: any[]) => mockRegisterInfraHandlers(...a),
  handleDisconnect: (...a: any[]) => mockHandleDisconnect(...a),
}));
jest.mock('../socket/handlers/canvas', () => ({ registerCanvasHandlers: (...a: any[]) => mockRegisterCanvasHandlers(...a) }));
jest.mock('../socket/handlers/dm-read', () => ({ registerDmReadHandlers: (...a: any[]) => mockRegisterDmReadHandlers(...a) }));
jest.mock('../socket/handlers/discover', () => ({
  registerDiscoverHandlers: (...a: any[]) => mockRegisterDiscoverHandlers(...a),
  pushMemberCount: jest.fn(),
}));
jest.mock('../socket/handlers/activities', () => ({ registerActivityHandlers: (...a: any[]) => mockRegisterActivityHandlers(...a) }));
jest.mock('../socket/handlers/super-reactions', () => ({ registerSuperReactionHandlers: (...a: any[]) => mockRegisterSuperReactionHandlers(...a) }));
jest.mock('../socket/handlers/clips', () => ({ registerClipHandlers: (...a: any[]) => mockRegisterClipHandlers(...a) }));
jest.mock('../socket/handlers/activities/draw-together', () => ({ registerDrawTogetherHandlers: (...a: any[]) => mockRegisterDrawTogetherHandlers(...a) }));
jest.mock('../socket/handlers/channelE2EEHandlers', () => ({ registerChannelE2EEHandlers: (...a: any[]) => mockRegisterChannelE2EEHandlers(...a) }));
jest.mock('../socket/handlers/members', () => ({ setupMemberships: (...a: any[]) => mockSetupMemberships(...a) }));

interface FakeSocket {
  id: string;
  handshake: any;
  conn: any;
  userId?: string;
  username?: string;
  tokenV?: number;
  _clientIp?: string;
  _bridgeMarkAuthenticated?: jest.Mock;
  _bridgeReleaseConnectionLimit?: jest.Mock;
  join: jest.Mock;
  emit: jest.Mock;
  on: jest.Mock;
  disconnect: jest.Mock;
  removeAllListeners: jest.Mock;
  handlers: Map<string, Function>;
}

function makeSocket(): FakeSocket {
  const handlers = new Map<string, Function>();
  return {
    id: 'sock-1',
    handshake: { address: '10.0.0.4', headers: {}, auth: { token: 'jwt' } },
    conn: { remoteAddress: '10.0.0.5' },
    _bridgeMarkAuthenticated: jest.fn().mockResolvedValue(true),
    _bridgeReleaseConnectionLimit: jest.fn().mockResolvedValue(undefined),
    join: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event: string, fn: Function) => { handlers.set(event, fn); }),
    disconnect: jest.fn(),
    removeAllListeners: jest.fn(),
    handlers,
  };
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

async function invokeMiddleware(fn: Function, socket: any) {
  return await new Promise<any>((resolve) => fn(socket, (err?: any) => resolve(err ?? null)));
}

describe('socket/index production connection state machine', () => {
  beforeEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
    voiceRooms.clear();
    socketRateStore.clear();
    mockApplyAdapter.mockResolvedValue(true);
    mockGetBan.mockResolvedValue(null);
    mockIpRateCheck.mockResolvedValue(true);
    mockVerifyToken.mockReturnValue({ id: 'u1', username: 'alice', v: 3 });
    mockUsersFindById.mockResolvedValue({
      _id: 'u1', username: 'alice', displayName: 'Alice', tokenVersion: 3,
      presenceVisibility: 'visible', avatarColor: null, avatarUrl: null,
    });
    mockUsersUpdate.mockResolvedValue(undefined);
    mockTrackSocket.mockResolvedValue(undefined);
    mockSetupMemberships.mockResolvedValue({
      memberships: [{ serverId: 's1' }],
      refreshMemberships: jest.fn(),
    });
    mockIsSFUReady.mockReturnValue(false);
    mockHandleDisconnect.mockResolvedValue(undefined);
    mockNormalizePresence.mockImplementation((v: unknown) => v === 'hidden' ? 'hidden' : 'visible');
  });

  async function setup() {
    jest.resetModules();
    // Mocks survive resetModules; requiring here gives each test fresh module-level Maps/timers.
    const mod = require('../socket/index') as typeof import('../socket/index');
    const harness = makeIo();
    mod.setupSocket(harness.io as any);
    await Promise.resolve();
    return { mod, ...harness };
  }

  test('registers WS/IP/rate/JWT middleware and exposes io', async () => {
    const { mod, io, middleware } = await setup();
    expect(middleware).toHaveLength(4);
    expect(mockWsConnectionLimitMiddleware).toHaveBeenCalledWith(io);
    expect(mod.getIo()).toBe(io);
    expect(mockApplyAdapter).not.toHaveBeenCalled(); // startup infra owns adapter readiness
  });

  test('socket registration does not race or duplicate startup-owned Redis adapter setup', async () => {
    await setup();
    expect(mockApplyAdapter).not.toHaveBeenCalled();
  });

  test('IP ban middleware rejects active and permanent bans with metadata', async () => {
    const { middleware } = await setup();
    const socket = makeSocket();
    mockGetBan.mockResolvedValueOnce({ reason: 'abuse', expiresAt: Date.now() + 5500 });
    const err = await invokeMiddleware(middleware[1], socket);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('IP banned');
    expect(err.data.reason).toBe('abuse');
    expect(err.data.remainingSeconds).toBeGreaterThan(0);
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);

    mockGetBan.mockResolvedValueOnce({ reason: 'perm', expiresAt: null });
    const permanent = await invokeMiddleware(middleware[1], makeSocket());
    expect(permanent.data.remainingSeconds).toBeNull();
  });

  test('IP ban backend failure is logged and fails closed while preserving resolved client IP', async () => {
    const { middleware } = await setup();
    const socket = makeSocket();
    mockGetBan.mockRejectedValueOnce(new Error('ban db down'));
    const err = await invokeMiddleware(middleware[1], socket);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('IP access control unavailable');
    expect(socket._clientIp).toBe('203.0.113.10');
    expect(mockLogger.error).toHaveBeenCalledWith('[Socket] IP ban kontrolü hatası:', 'ban db down');
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
  });

  test('connect rate limiter uses cached IP and returns retry metadata when blocked', async () => {
    const { middleware } = await setup();
    const socket = makeSocket();
    socket._clientIp = '198.51.100.8';
    mockIpRateCheck.mockResolvedValueOnce(false);
    const blocked = await invokeMiddleware(middleware[2], socket);
    // Jetonsuz bağlantı anonimdir: IP kotası (davranış değişmedi).
    expect(mockIpRateCheck).toHaveBeenCalledWith('198.51.100.8', 'connect', null);
    expect(blocked.message).toBe('Too many connections');
    expect(blocked.data.retryAfter).toBe(12);
    expect(socket._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);

    mockIpRateCheck.mockResolvedValueOnce(true);
    expect(await invokeMiddleware(middleware[2], makeSocket())).toBeNull();

    // Faz 19: imzası doğrulanan jeton taşıyan bağlantı KENDİ kotasından düşer; aynı NAT
    // arkasındaki komşularının bağlantı bütçesini tüketmez.
    const signedIn = makeSocket();
    signedIn._clientIp = '198.51.100.9';
    signedIn.handshake.auth = { token: 'verified:user-42' };
    mockIpRateCheck.mockResolvedValueOnce(true);
    expect(await invokeMiddleware(middleware[2], signedIn)).toBeNull();
    expect(mockIpRateCheck).toHaveBeenLastCalledWith('198.51.100.9', 'connect', 'user-42');
  });

  test('JWT middleware rejects invalid/missing user/revoked token/DB error and accepts current token', async () => {
    const { middleware } = await setup();
    const jwtMw = middleware[3];

    mockVerifyToken.mockReturnValueOnce(null);
    expect((await invokeMiddleware(jwtMw, makeSocket())).message).toBe('Unauthorized');

    mockVerifyToken.mockReturnValueOnce({ id: 'u1', username: 'alice', v: 3 });
    mockUsersFindById.mockResolvedValueOnce(null);
    expect((await invokeMiddleware(jwtMw, makeSocket())).message).toBe('Unauthorized');

    mockVerifyToken.mockReturnValueOnce({ id: 'u1', username: 'alice', v: 2 });
    mockUsersFindById.mockResolvedValueOnce({ _id: 'u1', tokenVersion: 3 });
    expect((await invokeMiddleware(jwtMw, makeSocket())).message).toBe('Token revoked');

    mockVerifyToken.mockReturnValueOnce({ id: 'u1', username: 'alice', v: 3 });
    mockUsersFindById.mockRejectedValueOnce(new Error('db'));
    expect((await invokeMiddleware(jwtMw, makeSocket())).message).toBe('Auth check failed');

    mockVerifyToken.mockReturnValueOnce({ id: 'u1', username: 'alice' });
    mockUsersFindById.mockResolvedValueOnce({ _id: 'u1', tokenVersion: 0 });
    const socket = makeSocket();
    expect(await invokeMiddleware(jwtMw, socket)).toBeNull();
    expect(socket.userId).toBe('u1');
    expect(socket.username).toBe('alice');
    expect(socket.tokenV).toBe(0);
    expect(socket._bridgeMarkAuthenticated).toHaveBeenCalledWith('u1');
  });

  test('handshake auth failures release the connection-limit reservation and user-quota false is enforced', async () => {
    const { middleware } = await setup();
    const jwtMw = middleware[3];

    const invalid = makeSocket();
    mockVerifyToken.mockReturnValueOnce(null);
    expect((await invokeMiddleware(jwtMw, invalid)).message).toBe('Unauthorized');
    expect(invalid._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);

    const quota = makeSocket();
    quota._bridgeMarkAuthenticated!.mockResolvedValueOnce(false);
    mockVerifyToken.mockReturnValueOnce({ id: 'u1', username: 'alice', v: 3 });
    mockUsersFindById.mockResolvedValueOnce({ _id: 'u1', tokenVersion: 3 });
    expect((await invokeMiddleware(jwtMw, quota)).message).toBe('TOO_MANY_CONNECTIONS_FROM_USER');
    expect(quota._bridgeReleaseConnectionLimit).toHaveBeenCalledTimes(1);
  });

  test('connection rejects missing identity, DB failure and deleted user', async () => {
    const { connection } = await setup();

    const noId = makeSocket();
    await connection(noId);
    expect(noId.disconnect).toHaveBeenCalledWith(true);

    const dbFail = makeSocket(); dbFail.userId = 'u1';
    mockUsersFindById.mockRejectedValueOnce(new Error('db down'));
    await connection(dbFail);
    expect(dbFail.disconnect).toHaveBeenCalledWith(true);
    expect(mockLogger.error).toHaveBeenCalledWith('[Socket] DB hatası:', 'db down');

    const missing = makeSocket(); missing.userId = 'u1';
    mockUsersFindById.mockResolvedValueOnce(null);
    await connection(missing);
    expect(missing.disconnect).toHaveBeenCalledWith(true);
  });

  test('successful hidden-presence connection joins personal room, registers handlers, then emits ready', async () => {
    const { io, connection } = await setup();
    const socket = makeSocket();
    socket.userId = 'u1'; socket.tokenV = 3;
    mockUsersFindById.mockResolvedValueOnce({
      _id: 'u1', username: 'alice', displayName: null, tokenVersion: 3,
      presenceVisibility: 'corrupt-value', avatarColor: null, avatarUrl: null,
    });
    mockNormalizePresence.mockReturnValueOnce('hidden');
    mockUsersUpdate.mockRejectedValueOnce(new Error('status write optional'));
    mockIsSFUReady.mockReturnValue(true);

    await connection(socket);

    expect(socket.join).toHaveBeenCalledWith('user:u1');
    expect(mockTrackSocket).toHaveBeenCalledWith('u1', 'sock-1', false);
    expect(mockUsersUpdate).toHaveBeenCalledWith('u1', { status: 'offline' });
    // Faz 16: durum yayını oda LİSTESİYLE yapılır. Oda başına ayrı yayın yapan
    // döngü, ortak sunucu sayısı kadar KOPYA gönderiyordu; liste verildiğinde
    // Socket.IO alıcıyı tekilleştirir. Kapsam aynı, kopya tek.
    expect(io.to).toHaveBeenCalledWith(['server:s1']);
    expect(mockRegisterMessageHandlers).toHaveBeenCalled();
    expect(mockRegisterChannelE2EEHandlers).toHaveBeenCalled();
    expect(mockRegisterVoiceHandlers).toHaveBeenCalled();
    expect(mockRegisterDmHandlers).toHaveBeenCalled();
    expect(mockRegisterStageHandlers).toHaveBeenCalled();
    expect(mockBindStageMediaClusterControl).toHaveBeenCalledWith(io);
    expect(mockRegisterCanvasHandlers).toHaveBeenCalled();
    expect(mockRegisterActivityHandlers).toHaveBeenCalledWith(socket, io, 'u1');
    expect(mockRegisterDrawTogetherHandlers).toHaveBeenCalledWith(socket, io, expect.objectContaining({ _id: 'u1', displayName: 'alice', avatarColor: '#2d9cdb' }));
    expect(mockRegisterSFUHandlers).toHaveBeenCalled();
    expect(mockRegisterInfraHandlers).toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('userAuthenticated', 'u1');

    const joinRoom = socket.handlers.get('user:join-room')!;
    joinRoom('other');
    joinRoom('u1');
    expect(socket.join).toHaveBeenCalledTimes(2);
  });

  test('visible connection skips SFU when unavailable and broadcasts online', async () => {
    const { io, connection } = await setup();
    const socket = makeSocket(); socket.userId = 'u1'; socket.tokenV = 3;
    await connection(socket);
    expect(mockTrackSocket).toHaveBeenCalledWith('u1', 'sock-1', true);
    expect(mockUsersUpdate).toHaveBeenCalledWith('u1', { status: 'online' });
    expect(mockRegisterSFUHandlers).not.toHaveBeenCalled();
    expect(io.to('server:s1').emit).toHaveBeenCalledWith('user:status', { userId: 'u1', status: 'online' });
  });

  test('periodic token check fails closed when auth DB revalidation fails', async () => {
    const { connection } = await setup();
    const socket = makeSocket(); socket.userId = 'u1'; socket.tokenV = 3;
    await connection(socket);

    mockUsersFindById.mockRejectedValueOnce(new Error('temporary'));
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(socket.emit).toHaveBeenCalledWith('auth:revoked', { reason: 'auth_check_failed' });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('periodic token check disconnects when token generation changes', async () => {
    const { connection } = await setup();
    const socket = makeSocket(); socket.userId = 'u1'; socket.tokenV = 3;
    await connection(socket);
    mockUsersFindById.mockResolvedValueOnce({ _id: 'u1', tokenVersion: 4 });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(socket.emit).toHaveBeenCalledWith('auth:revoked', { reason: 'token_revoked' });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('periodic token check disconnects when user disappears', async () => {
    const { connection } = await setup();
    const socket = makeSocket(); socket.userId = 'u1'; socket.tokenV = 3;
    await connection(socket);
    mockUsersFindById.mockResolvedValueOnce(null);
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('disconnect delegates cleanup and debug logging in non-production', async () => {
    const { connection } = await setup();
    const socket = makeSocket(); socket.userId = 'u1'; socket.tokenV = 3;
    await connection(socket);
    const disconnect = socket.handlers.get('disconnect')!;
    await disconnect('client namespace disconnect');
    expect(socket.removeAllListeners).toHaveBeenCalled();
    expect(mockHandleDisconnect).toHaveBeenCalledWith(socket, expect.any(Object), expect.objectContaining({ io: expect.any(Object) }));
    expect(mockLogger.debug).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1', reason: 'client namespace disconnect', event: 'socket.disconnect' }), expect.any(String));
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
