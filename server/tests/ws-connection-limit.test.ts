// server/tests/ws-connection-limit.test.ts
//
// WEBSOCKET BAĞLANTI LİMİTİ — DoS KORUMASI VE IP SAHTECİLİĞİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (P1 sınıfı — DÖRDÜNCÜ getClientIp kopyası)
// ════════════════════════════════════════════════════════════════════════════
// `socket/middleware/wsConnectionLimit.ts` KENDİ X-Forwarded-For yorumunu
// taşıyordu ve iki yönden hatalıydı:
//
//   1. VARSAYILAN GÜVEN — `TRUSTED_PROXY_COUNT ?? '1'`. Doğrudan internete
//      açık bir kurulumda bu, HER istemcinin kendi IP'sini uydurabilmesi
//      demekti.
//   2. GÜVENSİZ GERİ DÜŞÜŞ — beklenenden az hop varsa `hops[0]`a, yani tam
//      olarak saldırganın yazdığı değere düşüyordu.
//
// SONUÇ: `MAX_WS_PER_IP` (10) ve `MAX_UNAUTH_WS_PER_IP` (3) SAHTELENEBİLİR
// bir anahtara bağlıydı. Saldırgan her bağlantıda X-Forwarded-For değerini
// değiştirerek WS bağlantı limitini TAMAMEN atlayabilir, sınırsız soket
// açarak kaynak tüketimi yaratabilirdi.
//
// Aynı kusur sınıfı HTTP tarafında bu programda zaten kapatılmıştı; burası
// ATLANAN KARDEŞ YOLDU — bu projede defalarca tekrarlanan desen.
//
// Bu dosya ayrıca modülün İLK testidir: fonksiyon kapsaması %0 idi.

import { wsConnectionLimitMiddleware } from '../socket/middleware/wsConnectionLimit';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() }),
  default: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

type FakeSocket = {
  id: string;
  userId?: string;
  handshake: { address: string; headers: Record<string, string>; auth: Record<string, unknown>; time?: number };
  once: jest.Mock;
  emit: jest.Mock;
  disconnect: jest.Mock;
  _bridgeMarkAuthenticated?: (userId: string) => boolean | Promise<boolean>;
  _bridgeReleaseConnectionLimit?: () => void | Promise<void>;
};

let _n = 0;
function mkSocket(opts: { ip?: string; xff?: string; token?: string; userId?: string; time?: number } = {}): FakeSocket {
  return {
    id: 'sock-' + (++_n),
    userId: opts.userId,
    handshake: {
      address: opts.ip ?? '203.0.113.9',
      headers: opts.xff ? { 'x-forwarded-for': opts.xff } : {},
      auth: opts.token ? { token: opts.token } : {},
      time: opts.time ?? _n,
    },
    once: jest.fn(),
    emit: jest.fn(),
    disconnect: jest.fn(),
  };
}

function mkIo(sockets: FakeSocket[]) {
  return { sockets: { sockets: new Map(sockets.map(s => [s.id, s])) } };
}

/** Middleware'i calistirir; reddedildiyse hata mesajini dondurur. */
function run(io: ReturnType<typeof mkIo>, socket: FakeSocket): string | null {
  let err: Error | undefined;
  wsConnectionLimitMiddleware(io as never)(socket as never, (e?: Error) => { err = e; });
  return err ? err.message : null;
}

let savedN: string | undefined;
beforeEach(() => { savedN = process.env.TRUSTED_PROXY_COUNT; _n = 0; });
afterEach(() => {
  if (savedN === undefined) delete process.env.TRUSTED_PROXY_COUNT;
  else process.env.TRUSTED_PROXY_COUNT = savedN;
});

// ════════════════════════════════════════════════════════════════════════════
// SÖMÜRÜ — gerileme kilidi
// ════════════════════════════════════════════════════════════════════════════
describe('IP sahteciliği ile limit atlatma', () => {
  it('SÖMÜRÜ: X-Forwarded-For DÖNDÜRMEK limiti ATLATAMAZ', () => {
    // Duzeltmeden ONCE: her baglantida farkli bir XFF -> her biri "yeni IP"
    // sayilir ve limit HIC devreye girmezdi.
    delete process.env.TRUSTED_PROXY_COUNT;
    const mevcut = Array.from({ length: 10 }, (_, i) =>
      mkSocket({ ip: '203.0.113.9', xff: `9.9.9.${i}`, token: 't' }));
    const yeni = mkSocket({ ip: '203.0.113.9', xff: '9.9.9.99', token: 't' });
    expect(run(mkIo(mevcut), yeni)).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('SÖMÜRÜ: kimliksiz limitte de sahtecilik ATLATAMAZ', () => {
    delete process.env.TRUSTED_PROXY_COUNT;
    const mevcut = Array.from({ length: 3 }, (_, i) =>
      mkSocket({ ip: '203.0.113.9', xff: `8.8.8.${i}` }));
    const yeni = mkSocket({ ip: '203.0.113.9', xff: '8.8.8.99' });
    expect(run(mkIo(mevcut), yeni)).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('proxy GÜVENİLİYORSA proxy’nin eklediği hop kullanılır', () => {
    // Mesru dagitim: proxy gercek IP'yi SONA ekler.
    process.env.TRUSTED_PROXY_COUNT = '1';
    const mevcut = Array.from({ length: 10 }, () =>
      mkSocket({ ip: '10.0.0.1', xff: 'sahte, 198.51.100.5', token: 't' }));
    const yeni = mkSocket({ ip: '10.0.0.1', xff: 'baska-sahte, 198.51.100.5', token: 't' });
    // Hepsi AYNI gercek istemci (198.51.100.5) — limit uygulanmali.
    expect(run(mkIo(mevcut), yeni)).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LİMİTLER
// ════════════════════════════════════════════════════════════════════════════
describe('bağlantı limitleri', () => {
  it('IP başına üst sınır uygulanır', () => {
    const mevcut = Array.from({ length: 10 }, () => mkSocket({ token: 't' }));
    expect(run(mkIo(mevcut), mkSocket({ token: 't' }))).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('KİMLİKSİZ bağlantılar için daha SIKI sınır', () => {
    // 3 kimliksiz zaten var; 4.'su reddedilmeli (IP siniri 10 olsa bile).
    const mevcut = Array.from({ length: 3 }, () => mkSocket());
    expect(run(mkIo(mevcut), mkSocket())).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('doğrulanmamış token STRINGİ pre-auth limitini atlatamaz', () => {
    const mevcut = Array.from({ length: 3 }, () => mkSocket());
    expect(run(mkIo(mevcut), mkSocket({ token: 'tamamen-sahte' }))).toBe('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP');
  });

  it('FARKLI IP’ler birbirini ETKİLEMEZ', () => {
    // Bir IP'nin dolu olmasi baska bir kullaniciyi disarida birakmamali.
    const mevcut = Array.from({ length: 10 }, () => mkSocket({ ip: '203.0.113.9', token: 't' }));
    expect(run(mkIo(mevcut), mkSocket({ ip: '198.51.100.1', token: 't' }))).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL: meşru bağlantılar geçer', () => {
  it('boş sunucuda bağlantı KABUL edilir', () => {
    // Bu olmadan tum testler "her seyi reddet" gibi bozuk bir uygulamada da
    // yesil kalirdi — ve urun hic baglanamazdi.
    expect(run(mkIo([]), mkSocket({ token: 't' }))).toBeNull();
  });

  it('sınırın ALTINDA kimlikli bağlantı kabul edilir', () => {
    const mevcut = Array.from({ length: 5 }, (_, i) => mkSocket({ token: 't', userId: `u${i}` }));
    expect(run(mkIo(mevcut), mkSocket({ token: 't' }))).toBeNull();
  });

  it('sınırın ALTINDA kimliksiz bağlantı kabul edilir', () => {
    expect(run(mkIo([mkSocket()]), mkSocket())).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KULLANICI BAŞINA SINIR — en eski oturumu düşürme
// ════════════════════════════════════════════════════════════════════════════
describe('kullanıcı başına sınır', () => {
  it('kimlik geçişi yalnız SERVER-INTERNAL callback ile kaydedilir', () => {
    const s = mkSocket({ token: 't' });
    run(mkIo([]), s);
    expect(typeof s._bridgeMarkAuthenticated).toBe('function');
    expect(s.once).not.toHaveBeenCalledWith('userAuthenticated', expect.any(Function));
  });

  it('sınır aşılınca EN ESKİ oturum düşürülür', () => {
    const s = mkSocket({ token: 't' });
    const eskiler = Array.from({ length: 5 }, (_, i) =>
      mkSocket({ token: 't', userId: 'u1', time: 100 + i }));
    const io = mkIo([...eskiler, s]);
    run(io, s);
    // Kaydedilen kancayi tetikle.
    const kanca = s._bridgeMarkAuthenticated!;
    s.userId = 'u1';
    kanca('u1');

    const dusen = eskiler.filter(e => e.disconnect.mock.calls.length > 0);
    expect({ dusenSayisi: dusen.length, enEski: dusen[0]?.id }).toEqual({ dusenSayisi: 1, enEski: eskiler[0].id });
  });

  it('düşürülen oturuma SEBEP bildirilir', () => {
    const s = mkSocket({ token: 't' });
    const eskiler = Array.from({ length: 5 }, (_, i) =>
      mkSocket({ token: 't', userId: 'u1', time: 100 + i }));
    run(mkIo([...eskiler, s]), s);
    const kanca = s._bridgeMarkAuthenticated!;
    s.userId = 'u1';
    kanca('u1');
    const olay = eskiler[0].emit.mock.calls.find(c => c[0] === 'error');
    expect(olay?.[1]).toMatchObject({ code: 'SESSION_REPLACED' });
  });

  it('sınırın ALTINDA hiçbir oturum düşürülmez', () => {
    const s = mkSocket({ token: 't' });
    const eskiler = Array.from({ length: 2 }, () => mkSocket({ token: 't', userId: 'u1' }));
    run(mkIo([...eskiler, s]), s);
    const kanca = s._bridgeMarkAuthenticated!;
    s.userId = 'u1';
    kanca('u1');
    expect(eskiler.every(e => e.disconnect.mock.calls.length === 0)).toBe(true);
  });

  it('BAŞKA kullanıcının oturumu düşürülmez', () => {
    // Kiracı sinirlari: u2'nin sekmesi u1 yuzunden kapanmamali.
    const s = mkSocket({ token: 't' });
    const digerleri = Array.from({ length: 5 }, () => mkSocket({ token: 't', userId: 'u2' }));
    run(mkIo([...digerleri, s]), s);
    const kanca = s._bridgeMarkAuthenticated!;
    s.userId = 'u1';
    kanca('u1');
    expect(digerleri.every(e => e.disconnect.mock.calls.length === 0)).toBe(true);
  });

  it('boş userId kancayı TETİKLEMEZ', () => {
    const s = mkSocket({ token: 't' });
    const eskiler = Array.from({ length: 5 }, () => mkSocket({ token: 't', userId: 'u1' }));
    run(mkIo([...eskiler, s]), s);
    const kanca = s._bridgeMarkAuthenticated!;
    kanca('');
    expect(eskiler.every(e => e.disconnect.mock.calls.length === 0)).toBe(true);
  });

  it('sonraki handshake middleware reddederse local rezervasyon açıkça ve idempotent bırakılabilir', () => {
    const ilk = mkSocket({ token: 't' });
    const io = mkIo([ilk]);
    expect(run(io, ilk)).toBeNull();
    expect(typeof ilk._bridgeReleaseConnectionLimit).toBe('function');

    // Auth/IP-ban gibi daha sonraki bir middleware bağlantıyı reddettiğinde
    // Socket.IO disconnect olayı garanti değildir. Explicit release, local
    // pre-auth/IP kotasını hemen geri vermeli ve tekrar çağrı zararsız olmalı.
    ilk._bridgeReleaseConnectionLimit!();
    ilk._bridgeReleaseConnectionLimit!();

    const ikinci = mkSocket({ token: 't' });
    expect(run(io, ikinci)).toBeNull();
  });

});
