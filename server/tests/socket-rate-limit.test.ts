// server/tests/socket-rate-limit.test.ts
//
// SOKET HIZ SINIRLARI — IP BAZLI OTOMATİK BAN VE KULLANICI BAZLI KOTA
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// Hız sınırı grubunun FONKSİYON kapsaması %54.83 idi. Nedeni ölçüldü:
//
//   socket/ipRateLimit.ts      →  %29.16 ifade ·  %0    fonksiyon
//   socket/socketRateLimit.ts  →  %56.08 ifade ·  %16.66 fonksiyon
//
// (`federationRateLimit` ve `wsConnectionLimit` zaten %100 fonksiyon.)
//
// Bu iki modülün ADANMIŞ TESTİ HİÇ YOKTU — oysa ikisi de üretimde canlı
// güvenlik denetimidir:
//
//   `ipRateCheck`  kayan pencere + ihlal sayacı + EŞİKTE OTOMATİK IP BANI
//   `socketRateCheck` / `createRateLimitedSocket`
//                  kullanıcı başına olay kotası ve `socket.on` sarmalayıcısı
//
// ── DİKKAT: %100 DAL ORANI YANILTICIYDI ─────────────────────────────────────
// V8 yalnızca ÇALIŞAN kodun dallarını sayar. Fonksiyonların çoğu hiç
// çalışmadığı için dal oranı "%100" görünüyordu — kapsanan dal sayısı
// neredeyse sıfır olduğu hâlde.

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
  createLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

const _banIp  = jest.fn().mockResolvedValue(undefined);
const _getBan = jest.fn().mockResolvedValue(null);
jest.mock('../middleware/ipBan', () => ({
  banIp:  (...a: unknown[]) => _banIp(...a),
  getBan: (...a: unknown[]) => _getBan(...a),
  getClientIp: () => '127.0.0.1',
}));

import { ipRateCheck, IP_SOCKET_RL } from '../socket/ipRateLimit';
import {
  socketRateCheck, socketGlobalCheck, createRateLimitedSocket,
  SOCKET_RL, _socketRateStore,
} from '../socket/socketRateLimit';

beforeEach(() => {
  jest.clearAllMocks();
  _getBan.mockResolvedValue(null);
  _socketRateStore.clear();
});

/** Benzersiz kimlik — testler arasi durum sizmasini engeller. */
let _n = 0;
const yeniIp   = () => `198.51.100.${(++_n) % 250 + 1}`;
const yeniUser = () => `user-${++_n}-${Date.now()}`;

// ════════════════════════════════════════════════════════════════════════════
// IP BAZLI — kayan pencere
// ════════════════════════════════════════════════════════════════════════════
describe('ipRateCheck — kayan pencere', () => {
  const OLAY = Object.keys(IP_SOCKET_RL)[0]!;

  it('YAPILANDIRILMAMIŞ olay serbest geçer', () => {
    // Bilinmeyen olaya sinir uygulamak mesru trafigi kirardi.
    return expect(ipRateCheck(yeniIp(), 'tamamen-bilinmeyen-olay')).resolves.toBe(true);
  });

  it('sınırın ALTINDA geçer', async () => {
    const ip = yeniIp();
    const max = IP_SOCKET_RL[OLAY as keyof typeof IP_SOCKET_RL].max;
    const sonuclar: boolean[] = [];
    for (let i = 0; i < max; i++) sonuclar.push(await ipRateCheck(ip, OLAY));
    expect({ hepsiGecti: sonuclar.every(Boolean) }).toEqual({ hepsiGecti: true });
  });

  it('sınırı AŞINCA engellenir', async () => {
    const ip = yeniIp();
    const max = IP_SOCKET_RL[OLAY as keyof typeof IP_SOCKET_RL].max;
    for (let i = 0; i < max; i++) await ipRateCheck(ip, OLAY);
    expect(await ipRateCheck(ip, OLAY)).toBe(false);
  });

  it('FARKLI IP’ler birbirini ETKİLEMEZ', async () => {
    // Kiracı izolasyonunun ag katmanindaki karsiligi.
    const a = yeniIp(), b = yeniIp();
    const max = IP_SOCKET_RL[OLAY as keyof typeof IP_SOCKET_RL].max;
    for (let i = 0; i <= max; i++) await ipRateCheck(a, OLAY);
    expect(await ipRateCheck(b, OLAY)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// IP BAZLI — otomatik ban
// ════════════════════════════════════════════════════════════════════════════
describe('ipRateCheck — otomatik ban', () => {
  const OLAY = Object.keys(IP_SOCKET_RL)[0]!;
  const max = IP_SOCKET_RL[OLAY as keyof typeof IP_SOCKET_RL].max;

  /** Siniri N kez ASAR — her asim bir ihlal sayilir. */
  async function ihlalUret(ip: string, kez: number) {
    for (let k = 0; k < kez; k++) {
      for (let i = 0; i <= max; i++) await ipRateCheck(ip, OLAY);
      // Pencereyi temizlemek icin store'u sifirla ki her tur yeni ihlal olsun
      _socketRateStore.clear();
    }
  }

  it('EŞİĞE ulaşınca otomatik ban UYGULANIR', async () => {
    const ip = yeniIp();
    await ihlalUret(ip, 6);          // esik (varsayilan 5) asilacak kadar
    expect(_banIp).toHaveBeenCalled();
    const cagri = _banIp.mock.calls[0];
    expect({ ip: cagri[0], sistem: (cagri[1] as { adminId?: string })?.adminId })
      .toEqual({ ip, sistem: 'system' });
  });

  it('ban SÜRELİDİR — kalıcı değil', async () => {
    // Kalici otomatik ban, paylasilan NAT arkasindaki mesru kullanicilari
    // kalici olarak disarida birakirdi.
    const ip = yeniIp();
    await ihlalUret(ip, 6);
    const opts = _banIp.mock.calls[0]?.[1] as { durationMs?: number };
    expect({ sureli: typeof opts?.durationMs === 'number' && opts.durationMs > 0 })
      .toEqual({ sureli: true });
  });

  it('ZATEN YASAKLIYSA yeniden ban UYGULANMAZ', async () => {
    _getBan.mockResolvedValue({ ip: 'x', reason: 'onceden', bannedAt: Date.now(), expiresAt: null, adminId: 'a' });
    const ip = yeniIp();
    await ihlalUret(ip, 6);
    expect(_banIp).not.toHaveBeenCalled();
  });

  it('ban HATASI akışı BOZMAZ', async () => {
    // Ban altyapisi coktugunde hiz siniri yine de karar vermeli.
    _getBan.mockRejectedValue(new Error('redis yok'));
    const ip = yeniIp();
    await expect(ihlalUret(ip, 6)).resolves.toBeUndefined();
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('POZİTİF KONTROL: tek bir aşım ban TETİKLEMEZ', async () => {
    // Bu olmadan "ban calisiyor" testleri, HER asimda banlayan asiri agresif
    // bir uygulamada da yesil kalirdi.
    const ip = yeniIp();
    for (let i = 0; i <= max; i++) await ipRateCheck(ip, OLAY);
    expect(_banIp).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KULLANICI BAZLI
// ════════════════════════════════════════════════════════════════════════════
describe('socketRateCheck', () => {
  it('sınırın ALTINDA geçer', async () => {
    const u = yeniUser();
    expect(await socketRateCheck(u, '*')).toBe(true);
  });

  it('sınırı AŞINCA engellenir', async () => {
    const u = yeniUser();
    const max = SOCKET_RL['*']!.max;
    for (let i = 0; i < max; i++) await socketRateCheck(u, '*');
    expect(await socketRateCheck(u, '*')).toBe(false);
  });

  it('BİLİNMEYEN olay genel (*) kotasına düşer', async () => {
    // Yeni bir olay eklendiginde kotasiz kalmamalidir.
    const u = yeniUser();
    const max = SOCKET_RL['*']!.max;
    for (let i = 0; i < max; i++) await socketRateCheck(u, 'yepyeni-olay');
    expect(await socketRateCheck(u, 'yepyeni-olay')).toBe(false);
  });

  it('FARKLI kullanıcılar birbirini ETKİLEMEZ', async () => {
    const a = yeniUser(), b = yeniUser();
    const max = SOCKET_RL['*']!.max;
    for (let i = 0; i <= max; i++) await socketRateCheck(a, '*');
    expect(await socketRateCheck(b, '*')).toBe(true);
  });

  it('socketGlobalCheck genel kotayı kullanır', async () => {
    const u = yeniUser();
    const max = SOCKET_RL['*']!.max;
    for (let i = 0; i < max; i++) await socketGlobalCheck(u);
    expect(await socketGlobalCheck(u)).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PROXY SOKET
// ════════════════════════════════════════════════════════════════════════════
describe('createRateLimitedSocket', () => {
  function sahteSoket() {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    return {
      id: 'sock-1',
      emit: jest.fn(),
      on: jest.fn((ev: string, h: (...a: unknown[]) => unknown) => { handlers.set(ev, h); }),
      join: jest.fn(),
      _tetikle: async (ev: string, ...a: unknown[]) => handlers.get(ev)?.(...a),
    };
  }

  it('POZİTİF KONTROL: sınır altında handler ÇALIŞIR', async () => {
    // Bu olmadan tum testler "her seyi engelle" gibi bozuk bir uygulamada da
    // yesil kalirdi — ve urun hicbir soket olayini islemezdi.
    const s = sahteSoket();
    const calisti = jest.fn();
    const p = createRateLimitedSocket(s as never, yeniUser());
    p.on('bir-olay', calisti as never);
    await s._tetikle('bir-olay', { x: 1 });
    expect(calisti).toHaveBeenCalledWith({ x: 1 });
  });

  it('genel kota AŞILINCA handler ÇALIŞMAZ', async () => {
    const s = sahteSoket();
    const u = yeniUser();
    const max = SOCKET_RL['*']!.max;
    for (let i = 0; i <= max; i++) await socketRateCheck(u, '*');

    const calisti = jest.fn();
    const p = createRateLimitedSocket(s as never, u);
    p.on('bir-olay', calisti as never);
    await s._tetikle('bir-olay');
    expect(calisti).not.toHaveBeenCalled();
  });

  it('olay bazlı kota aşılınca istemciye UYARI gider', async () => {
    const olay = Object.keys(SOCKET_RL).find(k => k !== '*')!;
    const s = sahteSoket();
    const u = yeniUser();
    for (let i = 0; i <= SOCKET_RL[olay]!.max; i++) await socketRateCheck(u, olay);

    const calisti = jest.fn();
    const p = createRateLimitedSocket(s as never, u);
    p.on(olay, calisti as never);
    await s._tetikle(olay);

    expect(calisti).not.toHaveBeenCalled();
    expect(s.emit).toHaveBeenCalledWith('error:ratelimit', expect.objectContaining({ event: olay }));
  });

  it.each(['disconnect', 'disconnecting', 'error'])('%s cleanup handler is never suppressed by an exhausted quota', async (event) => {
    const s = sahteSoket();
    const u = yeniUser();
    for (let i = 0; i <= SOCKET_RL['*']!.max; i++) await socketRateCheck(u, '*');
    const cleanup = jest.fn();
    const p = createRateLimitedSocket(s as never, u);
    p.on(event, cleanup as never);
    await s._tetikle(event, 'reason');
    expect(cleanup).toHaveBeenCalledWith('reason');
  });

  it('`on` DIŞINDAKİ özellikler aynen geçer', async () => {
    // Proxy yalnizca `on`'u sarmalamali; digerlerini bozarsa soket iflas eder.
    const s = sahteSoket();
    const p = createRateLimitedSocket(s as never, yeniUser());
    (p as unknown as { join: (r: string) => void }).join('oda-1');
    expect({ id: (p as unknown as { id: string }).id, joinCagrildi: s.join.mock.calls.length })
      .toEqual({ id: 'sock-1', joinCagrildi: 1 });
  });
});
