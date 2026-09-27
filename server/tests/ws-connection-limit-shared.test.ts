// server/tests/ws-connection-limit-shared.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// WS BAĞLANTI LİMİTİ — KÜME (REDIS) YOLU
// ════════════════════════════════════════════════════════════════════════════
// BULUNUŞ (Final21 Faz 17, mutasyon kampanyası): 16 mutasyondan biri HAYATTA KALDI —
//
//     socket/middleware/wsConnectionLimit.ts
//     "return next(new Error('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP'));"  →  silindi
//     → tests/ws-connection-limit.test.ts HÂLÂ GEÇTİ
//
// Sebep: bu dizge dosyada İKİ kez geçer. Mutasyon İLKİNİ, yani REDIS_CONFIGURED
// dalını bozuyordu; mevcut testlerin tamamı YEREL (tek düğüm) dalını ölçüyordu.
// Yani üretimde GERÇEKTEN çalışan yol — Redis'li çok düğümlü kurulum — hiç test
// edilmemişti: ne IP limiti, ne kimliksiz bağlantı limiti, ne Redis düştüğünde
// fail-closed davranışı, ne kullanıcı kotasının küme genelinde uygulanması.
//
// Limit bir DoS korumasıdır: kimliksiz bağlantı seli, kimlik doğrulaması
// gerektirmeden soket/bellek tüketir. Bu yüzden ölçülmesi gereken, reddin
// GERÇEKTEN olduğudur — "sayaç arttı" değil.
// `process.env` SÜREÇ GENELİNDEDİR: jest --runInBand tüm dosyaları tek süreçte koşar ve
// bu değişkeni okuyan ON'DAN fazla modül vardır (permCache, presenceCache, captcha, sfuRegistry,
// chess/draw store, twoFactorLoginChallenge...). Bırakılırsa SONRAKİ dosyalar Redis
// mock'u olmadan küme moduna geçer. Depodaki kural (activity-store-coverage.test.ts)
// aynen uygulanır: al, kullan, GERİ VER.
const ORIGINAL_REDIS_URL = process.env.REDIS_URL;
process.env.REDIS_URL = 'redis://127.0.0.1:6379';   // KÜME dalını seçer (modül yüklenirken okunur)

const luaEvalAuthoritative = jest.fn();
jest.mock('../lib/redisAdapter', () => ({
  cache: { luaEvalAuthoritative: (...args: unknown[]) => luaEvalAuthoritative(...args) },
  isRedisAvailable: () => true,
}));
jest.mock('../lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() }),
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

import { wsConnectionLimitMiddleware } from '../socket/middleware/wsConnectionLimit';

type FakeSocket = {
  id: string;
  handshake: { address: string; headers: Record<string, string>; auth: Record<string, unknown> };
  once: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  _bridgeMarkAuthenticated?: (userId: string) => boolean | Promise<boolean>;
  _bridgeReleaseConnectionLimit?: () => void | Promise<void>;
};

let n = 0;
function mkSocket(): FakeSocket {
  return {
    id: 'sock-' + (++n),
    handshake: { address: '203.0.113.9', headers: {}, auth: {} },
    once: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

/** Middleware'i çalıştırır ve `next(...)` çağrısını bekler (küme yolu asenkrondur). */
async function run(socket: FakeSocket): Promise<Error | undefined> {
  const io = { sockets: { sockets: new Map() } };
  return new Promise<Error | undefined>((resolve) => {
    wsConnectionLimitMiddleware(io as never)(socket as never, (err?: Error) => resolve(err));
  });
}

beforeEach(() => { luaEvalAuthoritative.mockReset(); n = 0; });
afterAll(() => {
  if (ORIGINAL_REDIS_URL === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = ORIGINAL_REDIS_URL;
});

describe('küme yolu — el sıkışma kotası', () => {
  it('IP toplam limiti aşıldığında bağlantı REDDEDİLİR', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ip', 10]);
    const err = await run(mkSocket());
    expect(err?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('KİMLİKSİZ bağlantı limiti aşıldığında bağlantı REDDEDİLİR', async () => {
    // Mutasyon kampanyasında hayatta kalan satır tam olarak budur.
    luaEvalAuthoritative.mockResolvedValueOnce(['unauth', 3]);
    const err = await run(mkSocket());
    expect(err?.message).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('kota uygunsa bağlantı geçer ve bırakma kancası kurulur', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);
    const socket = mkSocket();
    const err = await run(socket);

    expect(err).toBeUndefined();
    // Kanca olmadan, sonraki bir middleware el sıkışmayı reddettiğinde ayrılan
    // kota SIZAR ve o IP yavaşça kendini kilitler.
    expect(typeof socket._bridgeReleaseConnectionLimit).toBe('function');
    expect(typeof socket._bridgeMarkAuthenticated).toBe('function');
    expect(socket.once).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });

  it('el sıkışma kotası kiralık alınır — anahtar ve sınırlar Redis\'e GÖNDERİLİR', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);
    await run(mkSocket());

    const [, keys, argv] = luaEvalAuthoritative.mock.calls[0] as [string, string[], string[]];
    expect(keys[0]).toBe('bridge:ws-limit:ip-total:203.0.113.9');
    expect(keys[1]).toBe('bridge:ws-limit:ip-unauth:203.0.113.9');
    // Sınırlar sunucudan gelir; Lua tarafı kendi varsayılanını uydurmaz.
    expect(Number(argv[3])).toBeGreaterThan(0);       // MAX_WS_PER_IP
    expect(Number(argv[4])).toBeGreaterThan(0);       // MAX_UNAUTH_WS_PER_IP
    expect(Number(argv[4])).toBeLessThanOrEqual(Number(argv[3]));
  });
});

describe('küme yolu — otorite kaybı FAIL-CLOSED', () => {
  it('Redis erişilemezse bağlantı KABUL EDİLMEZ', async () => {
    // Fail-open olsaydı, Redis kesintisi limitin tamamen kalkması demek olurdu:
    // tam da bir saldırı anında koruma kaybolurdu.
    luaEvalAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    const err = await run(mkSocket());
    expect(err?.message).toBe('CONNECTION_LIMIT_UNAVAILABLE');
  });

  it('Redis anlamsız bir sonuç dönerse de bağlantı KABUL EDİLMEZ', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce('beklenmeyen');
    const err = await run(mkSocket());
    expect(err?.message).toBe('CONNECTION_LIMIT_UNAVAILABLE');
  });

  it('tanınmayan bir durum kodu sessizce GEÇİRİLMEZ', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['bilinmeyen', 1]);
    const err = await run(mkSocket());
    expect(err?.message).toBe('CONNECTION_LIMIT_UNAVAILABLE');
  });

  it('reddedilen el sıkışmanın kirası BIRAKILIR', async () => {
    luaEvalAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    luaEvalAuthoritative.mockResolvedValueOnce(1);     // RELEASE
    await run(mkSocket());
    // İkinci çağrı bırakmadır: kira bırakılmazsa sayaç kalıcı olarak şişer.
    expect(luaEvalAuthoritative).toHaveBeenCalledTimes(2);
  });
});

describe('küme yolu — kimlik doğrulandıktan sonraki kullanıcı kotası', () => {
  it('kullanıcı kotası aşıldığında yükseltme REDDEDİLİR ve kira bırakılır', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);          // handshake
    const socket = mkSocket();
    await run(socket);

    luaEvalAuthoritative.mockResolvedValueOnce(['user', 5]);        // promote → limit
    luaEvalAuthoritative.mockResolvedValueOnce(1);                  // release
    await expect(socket._bridgeMarkAuthenticated!('u1')).resolves.toBe(false);
  });

  it('kota uygunsa yükseltme kabul edilir ve aynı kullanıcı için tekrarlanmaz', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);          // handshake
    const socket = mkSocket();
    await run(socket);

    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);          // promote
    await expect(socket._bridgeMarkAuthenticated!('u1')).resolves.toBe(true);

    const callsAfterPromote = luaEvalAuthoritative.mock.calls.length;
    await expect(socket._bridgeMarkAuthenticated!('u1')).resolves.toBe(true);
    // İkinci çağrı Redis'e GİTMEZ: aynı kullanıcı için kota bir kez alınır.
    expect(luaEvalAuthoritative.mock.calls.length).toBe(callsAfterPromote);
  });

  it('aynı soket BAŞKA bir kullanıcıya yükseltilemez', async () => {
    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);
    const socket = mkSocket();
    await run(socket);

    luaEvalAuthoritative.mockResolvedValueOnce(['ok', 1]);
    await socket._bridgeMarkAuthenticated!('u1');
    await expect(socket._bridgeMarkAuthenticated!('u2')).resolves.toBe(false);
  });
});
