// server/tests/ws-connection-limit-local-accounting.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// WS BAĞLANTI LİMİTİ — TEK DÜĞÜM MUHASEBESİ
// ════════════════════════════════════════════════════════════════════════════
//
// Bu middleware kimlik doğrulamadan ÖNCE çalışır ve iki kotayı korur: IP başına
// toplam ve IP başına KİMLİKSİZ bağlantı. Ölçülmemiş dalların riskleri:
//
//   · SAYAÇ KAYMASI — hızlı yol O(1) bir sayaçtır; kayarsa meşru kullanıcı
//     kalıcı olarak dışarıda kalır. Bu yüzden REDDETMEDEN önce gerçek durum
//     doğrulanır — ama doğrulama O(N)'dir ve IP başına EN FAZLA saniyede bir
//     yapılır; aksi hâlde reddetme yolu DoS yükselticiye dönerdi.
//   · KİRA SIZINTISI — el sıkışma tamamlanmazsa ayrılan kota SÜRESİ DOLUNCA
//     geri verilmelidir; verilmezse IP kotası kalıcı olarak tükenir.
//   · GEÇ KİMLİK — kira süresi dolduktan sonra gelen kimlik doğrulama kabul
//     EDİLMEZ; aksi hâlde bağlantı hem kimliksiz hem kimlikli muhasebeden
//     kaçardı.
//   · OTURUM DEVRALMA — kullanıcı sekme limitini aşınca EN ESKİ soket düşer,
//     yenisi değil.

process.env.NODE_ENV = 'test';
process.env.MAX_WS_PER_IP = '3';
process.env.MAX_UNAUTH_WS_PER_IP = '2';
process.env.MAX_WS_PER_USER = '2';
delete process.env.REDIS_URL;

// IP çözümleyicisi soketin KENDİ adresinden türetir; sabit bir değer
// döndürmek "farklı IP'ler birbirini etkilemez" iddiasını ölçümsüz bırakırdı.
jest.mock('../lib/clientIp', () => ({
  getClientIp: (input: { socket?: { remoteAddress?: string } }) => String(input?.socket?.remoteAddress ?? ''),
}));
jest.mock('../lib/redisAdapter', () => ({
  cache: { luaEvalAuthoritative: jest.fn() },
  isRedisAvailable: () => false,
}));
jest.mock('../lib/logger', () => {
  const sink = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { __esModule: true, default: sink, createLogger: () => sink };
});

import type { Server } from 'socket.io';
import { wsConnectionLimitMiddleware } from '../socket/middleware/wsConnectionLimit';

// ── Test ikizleri ───────────────────────────────────────────────────────────
type LimitedSocket = {
  id: string;
  userId?: string;
  handshake: { headers: Record<string, string>; address: string; time?: number };
  emitted: Array<{ event: string; payload: unknown }>;
  disconnected: boolean;
  emit(event: string, payload?: unknown): boolean;
  disconnect(close?: boolean): void;
  once(event: string, handler: () => void): void;
  fireDisconnect(): void;
  _bridgeReleaseConnectionLimit?: () => void;
  _bridgeMarkAuthenticated?: (userId: string) => boolean;
};

const sockets = new Map<string, LimitedSocket>();
let socketSeq = 0;

function makeSocket(over: Partial<LimitedSocket> = {}): LimitedSocket {
  const id = over.id ?? `sock-${(socketSeq += 1)}`;
  const disconnectHandlers: Array<() => void> = [];
  const socket: LimitedSocket = {
    id,
    handshake: { headers: {}, address: '203.0.113.7', time: socketSeq },
    emitted: [],
    disconnected: false,
    emit(event, payload) { socket.emitted.push({ event, payload }); return true; },
    disconnect() { socket.disconnected = true; socket.fireDisconnect(); },
    once(event, handler) { if (event === 'disconnect') disconnectHandlers.push(handler); },
    fireDisconnect() { for (const handler of disconnectHandlers.splice(0)) handler(); },
    ...over,
  };
  return socket;
}

/** `io` yalnızca kayıtlı soket haritası için kullanılır. */
function makeIo(): Server {
  return { sockets: { sockets } } as unknown as Server;
}

type Middleware = (socket: LimitedSocket, next: (err?: Error) => void) => void;

function connect(middleware: Middleware, socket: LimitedSocket): Error | undefined {
  let error: Error | undefined;
  middleware(socket, (err) => { error = err; });
  if (!error) sockets.set(socket.id, socket);
  return error;
}

let middleware: Middleware;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  sockets.clear();
  socketSeq = 0;
  middleware = wsConnectionLimitMiddleware(makeIo()) as unknown as Middleware;
});

afterEach(() => { jest.useRealTimers(); });

// ════════════════════════════════════════════════════════════════════════════
describe('IP kotaları', () => {
  it('kota içindeki bağlantılar kabul edilir', async () => {
    const first = makeSocket();
    expect(connect(middleware, first)).toBeUndefined();
    expect(typeof first._bridgeReleaseConnectionLimit).toBe('function');
    expect(typeof first._bridgeMarkAuthenticated).toBe('function');
  });

  it('KİMLİKSİZ kota aşılınca ayrı bir kodla reddedilir', async () => {
    connect(middleware, makeSocket());
    connect(middleware, makeSocket());

    const error = connect(middleware, makeSocket());

    expect(error?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('kimlik doğrulanan bağlantılar KİMLİKSİZ kotayı serbest bırakır', async () => {
    const a = makeSocket(); const b = makeSocket();
    connect(middleware, a);
    connect(middleware, b);
    a._bridgeMarkAuthenticated!('u1');
    b._bridgeMarkAuthenticated!('u2');

    expect(connect(middleware, makeSocket())).toBeUndefined();
  });

  it('TOPLAM IP kotası kimlik doğrulanmış bağlantılar için de geçerlidir', async () => {
    const a = makeSocket(); const b = makeSocket(); const c = makeSocket();
    connect(middleware, a); a._bridgeMarkAuthenticated!('u1');
    connect(middleware, b); b._bridgeMarkAuthenticated!('u2');
    connect(middleware, c); c._bridgeMarkAuthenticated!('u3');

    const error = connect(middleware, makeSocket());

    expect(error?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('sayaç KAYMIŞSA doğrulama meşru kullanıcıyı kurtarır', async () => {
    const a = makeSocket(); const b = makeSocket();
    connect(middleware, a); a._bridgeMarkAuthenticated!('u1');
    connect(middleware, b); b._bridgeMarkAuthenticated!('u2');
    const c = makeSocket();
    connect(middleware, c); c._bridgeMarkAuthenticated!('u3');
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');

    // Soketler gerçekte kapandı ama sayaç geride kaldı (kayma senaryosu).
    sockets.clear();
    // Doğrulama aralığı dolduktan sonra gerçek durum yeniden taranır.
    const realNow = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(realNow + 5_000);
    try {
      expect(connect(middleware, makeSocket())).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('doğrulama taraması IP başına SANİYEDE BİR ile sınırlıdır', async () => {
    const a = makeSocket(); const b = makeSocket();
    connect(middleware, a); a._bridgeMarkAuthenticated!('u1');
    connect(middleware, b); b._bridgeMarkAuthenticated!('u2');
    const c = makeSocket();
    connect(middleware, c); c._bridgeMarkAuthenticated!('u3');

    // Gerçek durum boş olsa bile, aralık dolmadan tarama yapılmaz: sayaç
    // otoritedir ve reddetme sürer. (Aksi hâlde her deneme O(N) tarama olurdu.)
    sockets.clear();
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('farklı IP’ler birbirinin kotasını tüketmez', async () => {
    connect(middleware, makeSocket());
    connect(middleware, makeSocket());
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');

    const other = makeSocket();
    other.handshake.address = '198.51.100.5';
    expect(connect(middleware, other)).toBeUndefined();
  });

  it('mevcut soketlerden TOHUMLAMA yapılır (yeniden başlatma sonrası)', async () => {
    // Sayaçlar boşken IP'de zaten iki kimliksiz soket varsa kota dolu sayılır.
    sockets.set('onceki-1', makeSocket({ id: 'onceki-1' }));
    sockets.set('onceki-2', makeSocket({ id: 'onceki-2' }));

    const error = connect(middleware, makeSocket());

    expect(error?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('tohumlamada kimlikli soketler yalnız TOPLAM kotayı doldurur', async () => {
    sockets.set('a', makeSocket({ id: 'a', userId: 'u1' }));
    sockets.set('b', makeSocket({ id: 'b', userId: 'u2' }));
    sockets.set('c', makeSocket({ id: 'c', userId: 'u3' }));

    const error = connect(middleware, makeSocket());

    expect(error?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kira ve serbest bırakma', () => {
  it('EL SIKIŞMA tamamlanmazsa ayrılan kota süre dolunca geri verilir', async () => {
    jest.useFakeTimers();
    middleware = wsConnectionLimitMiddleware(makeIo()) as unknown as Middleware;

    const a = makeSocket(); const b = makeSocket();
    connect(middleware, a);
    connect(middleware, b);
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');

    jest.advanceTimersByTime(20_000);
    // Soketler gerçekten düştüyse kota serbest kalır.
    sockets.delete(a.id);
    sockets.delete(b.id);

    expect(connect(middleware, makeSocket())).toBeUndefined();
  });

  it('kira dolsa bile soketler HÂLÂ bağlıysa kota GERÇEKTEN yeniden kurulur', async () => {
    jest.useFakeTimers();
    middleware = wsConnectionLimitMiddleware(makeIo()) as unknown as Middleware;

    connect(middleware, makeSocket());
    connect(middleware, makeSocket());
    jest.advanceTimersByTime(20_000);

    // Kira geri verildi ama soketler kayıtta duruyor: sayaç gerçek durumdan
    // yeniden tohumlanır ve kota bir DELİĞE dönüşmez.
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('kimlik doğrulandıysa kira zamanlayıcısı kotayı GERİ ALMAZ', async () => {
    jest.useFakeTimers();
    middleware = wsConnectionLimitMiddleware(makeIo()) as unknown as Middleware;

    const a = makeSocket(); const b = makeSocket(); const c = makeSocket();
    connect(middleware, a); a._bridgeMarkAuthenticated!('u1');
    connect(middleware, b); b._bridgeMarkAuthenticated!('u2');
    connect(middleware, c); c._bridgeMarkAuthenticated!('u3');

    jest.advanceTimersByTime(20_000);

    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('kira SÜRESİ DOLDUKTAN sonra gelen kimlik doğrulama KABUL EDİLMEZ', async () => {
    jest.useFakeTimers();
    middleware = wsConnectionLimitMiddleware(makeIo()) as unknown as Middleware;
    const socket = makeSocket();
    connect(middleware, socket);

    jest.advanceTimersByTime(20_000);

    expect(socket._bridgeMarkAuthenticated!('u1')).toBe(false);
  });

  it('bağlantı kopunca kota geri verilir ve İKİNCİ kez düşülmez', async () => {
    const a = makeSocket(); const b = makeSocket();
    connect(middleware, a);
    connect(middleware, b);
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');

    a.fireDisconnect();
    a.fireDisconnect();          // yinelenen olay kotayı ŞİŞİRMEZ
    a._bridgeReleaseConnectionLimit!();

    expect(connect(middleware, makeSocket())).toBeUndefined();
    expect(connect(middleware, makeSocket())?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('boş kullanıcı kimliğiyle kimlik doğrulama reddedilir', async () => {
    const socket = makeSocket();
    connect(middleware, socket);

    expect(socket._bridgeMarkAuthenticated!('')).toBe(false);
  });

  it('aynı kimlikle ikinci çağrı KABUL, farklı kimlikle RED döner', async () => {
    const socket = makeSocket();
    connect(middleware, socket);

    expect(socket._bridgeMarkAuthenticated!('u1')).toBe(true);
    expect(socket._bridgeMarkAuthenticated!('u1')).toBe(true);
    expect(socket._bridgeMarkAuthenticated!('baskasi')).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kullanıcı başına sekme limiti', () => {
  it('limit aşılınca EN ESKİ soket düşürülür', async () => {
    const first = makeSocket({ id: 'sock-eski' });
    first.handshake.time = 100;
    connect(middleware, first);
    first.userId = 'u1';
    first._bridgeMarkAuthenticated!('u1');

    const second = makeSocket({ id: 'sock-orta' });
    second.handshake.time = 200;
    connect(middleware, second);
    second.userId = 'u1';
    second._bridgeMarkAuthenticated!('u1');

    const third = makeSocket({ id: 'sock-yeni' });
    third.handshake.time = 300;
    connect(middleware, third);
    third.userId = 'u1';
    third._bridgeMarkAuthenticated!('u1');

    expect(first.disconnected).toBe(true);
    expect(first.emitted[0]).toEqual({ event: 'error', payload: { code: 'SESSION_REPLACED', message: 'Yeni bir sekme/cihazdan bağlandınız' } });
    expect(third.disconnected).toBe(false);
  });

  it('zaman damgası olmayan soketler çökme üretmez', async () => {
    const first = makeSocket({ id: 'sock-a' });
    delete first.handshake.time;
    connect(middleware, first);
    first.userId = 'u1';
    first._bridgeMarkAuthenticated!('u1');

    const second = makeSocket({ id: 'sock-b' });
    delete second.handshake.time;
    connect(middleware, second);
    second.userId = 'u1';
    second._bridgeMarkAuthenticated!('u1');

    const third = makeSocket({ id: 'sock-c' });
    connect(middleware, third);
    third.userId = 'u1';

    expect(() => third._bridgeMarkAuthenticated!('u1')).not.toThrow();
  });

  it('kayıt haritasında BULUNAMAYAN eski soketler düşürülmeye çalışılmaz', async () => {
    const first = makeSocket({ id: 'sock-a' });
    connect(middleware, first);
    first.userId = 'u1';
    first._bridgeMarkAuthenticated!('u1');
    const second = makeSocket({ id: 'sock-b' });
    connect(middleware, second);
    second.userId = 'u1';
    second._bridgeMarkAuthenticated!('u1');

    // Eski soketler kayıttan düşmüş olsun (başka bir düğüme taşınma / yarış).
    sockets.delete('sock-a');
    sockets.delete('sock-b');

    const third = makeSocket({ id: 'sock-c' });
    connect(middleware, third);
    third.userId = 'u1';

    expect(third._bridgeMarkAuthenticated!('u1')).toBe(true);
    expect(first.disconnected).toBe(false);
  });

  it('kullanıcı kümesi MEVCUT soketlerden tohumlanır', async () => {
    // Önceki soketler BAŞKA bir IP'den bağlı: IP kotası yeni bağlantıyı
    // engellemez ama KULLANICI kotası yine de uygulanır.
    const first = makeSocket({ id: 'onceki-1', userId: 'u1' });
    const second = makeSocket({ id: 'onceki-2', userId: 'u1' });
    first.handshake.address = '198.51.100.20';
    second.handshake.address = '198.51.100.21';
    sockets.set('onceki-1', first);
    sockets.set('onceki-2', second);

    const socket = makeSocket({ id: 'yeni' });
    connect(middleware, socket);
    socket._bridgeMarkAuthenticated!('u1');

    expect(first.disconnected).toBe(true);
  });

  it('kullanıcının son soketi kapanınca küme TEMİZLENİR', async () => {
    const socket = makeSocket();
    connect(middleware, socket);
    socket._bridgeMarkAuthenticated!('u1');

    socket.fireDisconnect();

    // Küme temizlendiği için yeni bağlantı tohumlamayı yeniden yapar.
    const next = makeSocket();
    connect(middleware, next);
    expect(next._bridgeMarkAuthenticated!('u1')).toBe(true);
  });
});
