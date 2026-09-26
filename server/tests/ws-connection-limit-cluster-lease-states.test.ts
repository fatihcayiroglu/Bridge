// server/tests/ws-connection-limit-cluster-lease-states.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// wsConnectionLimit — PAYLASILAN KIRALAMANIN HER DURUMU FAIL-CLOSED'DIR
// ════════════════════════════════════════════════════════════════════════════
// Kume (cluster) modunda WS kotasi Redis'te YASAR. Middleware bir Lua betiginin
// dondurdugu duruma gore karar verir. O durum bir DIS SISTEMDEN gelir; bu
// yuzden her deger ayri ayri sinanmalidir:
//
//   'ip'      → IP toplam tavani doldu          → el sikisma REDDEDILIR
//   'unauth'  → kimliksiz baglanti tavani doldu → el sikisma REDDEDILIR
//   'user'    → kullanici basina tavan doldu    → yukseltme REDDEDILIR
//   'expired' → el sikisma kiralamasi dustu     → yukseltme REDDEDILIR
//   baskasi   → SOZLESME DISI                   → hata; sessizce KABUL YOK
//
// Son satir kritiktir: taninmayan bir durumu "sorun yok" saymak, Redis
// tarafindaki bir surum uyusmazliginda kotayi TAMAMEN devre disi birakirdi.
//
// Ayrica kiralama YENILEME dongusu olculur. Kiralama suresi dolar ve yenileme
// basarisiz olursa bu sunucu artik o baglantinin sahibi DEGILDIR: soket
// kapatilmalidir. Sessizce devam etmek, kotanin uzerinde hayalet baglantilar
// birakirdi.

describe('WebSocket connection limits — shared lease state machine', () => {
  const originalRedisUrl = process.env.REDIS_URL;
  const originalInstance = process.env.INSTANCE_ID;
  const luaEvalAuthoritative = jest.fn<Promise<unknown>, [string, string[], string[]]>();
  const logger = { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    process.env.REDIS_URL = 'redis://cluster.example:6379';
    process.env.INSTANCE_ID = 'node-a';
    luaEvalAuthoritative.mockReset();
    for (const fn of Object.values(logger)) fn.mockReset();
    jest.doMock('../lib/redisAdapter', () => ({ cache: { luaEvalAuthoritative } }));
    jest.doMock('../lib/logger', () => ({
      __esModule: true, createLogger: () => logger, default: logger,
    }));
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('../lib/redisAdapter');
    jest.dontMock('../lib/logger');
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    if (originalInstance === undefined) delete process.env.INSTANCE_ID;
    else process.env.INSTANCE_ID = originalInstance;
  });

  type FakeSocket = {
    id: string;
    handshake: { address: string; headers: Record<string, string>; auth: Record<string, string>; time: number };
    once: jest.Mock;
    emit: jest.Mock;
    disconnect: jest.Mock;
    userId?: string;
    _bridgeMarkAuthenticated?: (userId: string) => boolean | Promise<boolean>;
    _bridgeReleaseConnectionLimit?: () => void | Promise<void>;
    _onceHandlers: Map<string, (...args: unknown[]) => unknown>;
  };

  function makeSocket(id: string = 'sock-lease-1'): FakeSocket {
    const onceHandlers = new Map<string, (...args: unknown[]) => unknown>();
    return {
      id,
      handshake: { address: '203.0.113.44', headers: {}, auth: { token: 'candidate' }, time: 1 },
      once: jest.fn((event: string, handler: (...args: unknown[]) => unknown) => { onceHandlers.set(event, handler); }),
      emit: jest.fn(),
      disconnect: jest.fn(),
      _onceHandlers: onceHandlers,
    } as FakeSocket;
  }

  async function load() {
    return (await import('../socket/middleware/wsConnectionLimit')).wsConnectionLimitMiddleware;
  }

  async function admit(middleware: unknown, socket: FakeSocket): Promise<Error | null> {
    return await new Promise<Error | null>((resolve) => {
      (middleware as (io: unknown) => (s: unknown, n: (e?: Error) => void) => void)(
        { sockets: { sockets: new Map() } })(socket, (err?: Error) => resolve(err ?? null));
    });
  }

  /** Kabul edilmis, henuz kimlik dogrulanmamis bir soket dondurur. */
  async function admitted(id = 'sock-lease-1'): Promise<FakeSocket> {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1', '1']);
    const socket = makeSocket(id);
    await expect(admit(await load(), socket)).resolves.toBeNull();
    return socket;
  }

  // ── EL SIKISMA REDDI ──────────────────────────────────────────────────────
  test.each([
    ['ip',     'TOO_MANY_CONNECTIONS_FROM_IP',        'ws_limit_ip'],
    ['unauth', 'TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP', 'ws_limit_unauth_ip'],
  ])('rejects the handshake when Redis reports the %s quota is full', async (status, message, event) => {
    luaEvalAuthoritative.mockResolvedValueOnce([status, '11']);
    const socket = makeSocket();
    const err = await admit(await load(), socket);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(message);
    // Reddedilen el sikismada yetkilendirme kancasi HIC kurulmaz.
    expect(socket._bridgeMarkAuthenticated).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event }));
  });

  test('treats an unrecognised claim status as a failure, never as an allow', async () => {
    // Redis tarafinda surum uyusmazligi: sozlesme disi bir durum.
    luaEvalAuthoritative.mockResolvedValueOnce(['maybe', '1']);
    const socket = makeSocket();
    const err = await admit(await load(), socket);

    expect(err).toBeInstanceOf(Error);
    expect(socket._bridgeMarkAuthenticated).toBeUndefined();
  });

  test.each([
    ['a non-array reply', 'not-an-array'],
    ['a too-short reply', ['ok']],
    ['a non-integer count', ['ok', 'çok']],
    ['a negative count', ['ok', '-1']],
  ])('rejects the handshake on %s from Redis', async (_label, reply) => {
    luaEvalAuthoritative.mockResolvedValueOnce(reply);
    const socket = makeSocket();
    const err = await admit(await load(), socket);

    expect(err).toBeInstanceOf(Error);
    expect(socket._bridgeMarkAuthenticated).toBeUndefined();
  });

  // ── YUKSELTME REDDI ───────────────────────────────────────────────────────
  test('refuses promotion when the handshake lease already expired', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockResolvedValueOnce(['expired', '0']);   // PROMOTE
    luaEvalAuthoritative.mockResolvedValueOnce(1);                  // RELEASE

    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'ws_limit_handshake_expired' }));
  });

  test('ignores an empty user id instead of promoting an anonymous lease', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockClear();

    await expect(socket._bridgeMarkAuthenticated!('')).resolves.toBe(false);
    // Bos kimlik icin Redis'e HIC gidilmez; bos bir kullanici kovasi acilmaz.
    expect(luaEvalAuthoritative).not.toHaveBeenCalled();
  });

  test('refuses to promote a connection that has already been released', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockResolvedValueOnce(1);                  // RELEASE
    await socket._bridgeReleaseConnectionLimit!();
    luaEvalAuthoritative.mockClear();

    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(false);
    expect(luaEvalAuthoritative).not.toHaveBeenCalled();
  });

  test('is idempotent for the same user and refuses a second, different identity', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1']);
    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(true);
    luaEvalAuthoritative.mockClear();

    // Ayni kimlik: kiralama zaten bu kullanicinindir, tekrar istenmez.
    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(true);
    // FARKLI kimlik: tek soket iki kullaniciya ait olamaz — kota devri olurdu.
    await expect(socket._bridgeMarkAuthenticated!('user-other')).resolves.toBe(false);
    expect(luaEvalAuthoritative).not.toHaveBeenCalled();
  });

  test('propagates a Redis outage during promotion after releasing the reservation', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockRejectedValueOnce(new Error('redis down'));  // PROMOTE
    luaEvalAuthoritative.mockResolvedValueOnce(1);                        // RELEASE

    await expect(socket._bridgeMarkAuthenticated!('user-9')).rejects.toThrow('redis down');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ws_limit_promote_failed' }), expect.any(String));
  });

  // ── KIRALAMA YENILEME ─────────────────────────────────────────────────────
  test('closes the socket when the periodic lease refresh loses authority', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1']);       // PROMOTE
    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(true);

    // Yenileme 0 doner: bu dugum artik baglantinin sahibi DEGILDIR.
    luaEvalAuthoritative.mockResolvedValueOnce(0);                 // REFRESH
    luaEvalAuthoritative.mockResolvedValueOnce(1);                 // RELEASE
    await jest.advanceTimersByTimeAsync(30_000);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ws_limit_heartbeat_failed' }), expect.any(String));
    expect(socket.emit).toHaveBeenCalledWith('error',
      expect.objectContaining({ code: 'CONNECTION_LIMIT_UNAVAILABLE' }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  test('accepts the string form of a successful refresh and keeps the socket open', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1']);       // PROMOTE
    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(true);

    // Bazi Redis istemcileri sayilari dizge olarak dondurur; bu BASARIDIR.
    luaEvalAuthoritative.mockResolvedValueOnce('1');               // REFRESH
    await jest.advanceTimersByTimeAsync(30_000);

    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ws_limit_heartbeat_failed' }), expect.any(String));
  });

  test('stops the refresh loop and tolerates a second release', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', '1']);       // PROMOTE
    await expect(socket._bridgeMarkAuthenticated!('user-9')).resolves.toBe(true);

    luaEvalAuthoritative.mockResolvedValueOnce(1);                 // RELEASE
    await socket._bridgeReleaseConnectionLimit!();
    luaEvalAuthoritative.mockClear();

    // Ikinci serbest birakma (ornegin `disconnect`) HICBIR SEY yapmaz ve
    // kalp atisi durdugu icin zaman ilerlemesi de Redis'e gitmez.
    const disconnectHandler = socket._onceHandlers.get('disconnect')!;
    await disconnectHandler();
    await jest.advanceTimersByTimeAsync(90_000);
    expect(luaEvalAuthoritative).not.toHaveBeenCalled();
  });

  test('reports but survives a failed lease release', async () => {
    const socket = await admitted();
    luaEvalAuthoritative.mockRejectedValueOnce(new Error('redis gone'));   // RELEASE

    await expect(socket._bridgeReleaseConnectionLimit!()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ws_limit_release_failed' }), expect.any(String));
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
