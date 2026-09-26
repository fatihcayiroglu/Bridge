// server/tests/ws-limit-scaling.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KABUL YOLU SABIT MALIYETLI KALMALI  (O(N^2) firtina regresyonu)
// ════════════════════════════════════════════════════════════════════════════
// `wsConnectionLimitMiddleware` eskiden HER yeni baglantida bagli olan TUM
// soketleri kopyalayip her biri icin IP ayristiriyordu. Kabul basina maliyet
// O(N), N soketlik bir rampanin toplami O(N^2) idi.
//
// OLCULEN (scripts/ws-limit-scaling.cjs, gercek middleware):
//
//                     ONCE          SONRA
//   N=500  rampa      55.3 ms       4.8 ms
//   N=2000 tek kabul  826.56 us     8.14 us      (101x)
//
// Bu SENKRON is olay dongusundeydi: kitlesel yeniden baglanmada mesaj teslimi
// ve heartbeat duruyor, heartbeat kaciran istemciler yeniden baglaniyor ve
// firtina kendini besliyordu.
//
// ── NEDEN SURE DEGIL, ISLEM SAYISI OLCULUYOR ────────────────────────────────
// Duvar saati esikleri mesgul bir makinede FLAKE uretir ve insanlar onlari
// gevsetir; gevsedikce regresyonu yakalamaz olurlar. Bunun yerine soketin
// `handshake.headers` erisimi SAYILIR — `getClientIp` her cagrisinda oraya
// bakmak ZORUNDA oldugu icin bu sayac, taramanin geri gelip gelmedigini
// DETERMINISTIK olarak gosterir.

import { wsConnectionLimitMiddleware } from '../socket/middleware/wsConnectionLimit';
import type { Server } from 'socket.io';

interface SahteSoket {
  id: string;
  userId?: string;
  handshake: { auth: { token?: string }; headers: Record<string, string>; address: string; time: number };
  once(ev: string, fn: (...a: unknown[]) => void): void;
  emit(...a: unknown[]): void;
  disconnect(...a: unknown[]): void;
  _bridgeMarkAuthenticated?: (userId: string) => void;
  _dinleyiciler: Record<string, ((...a: unknown[]) => void)[]>;
}

/** `handshake.headers` erisimlerini sayan sahte soket. */
function sahteSoket(i: number, sayac: { n: number }, opts: { token?: boolean; userId?: string } = {}): SahteSoket {
  const dinleyiciler: Record<string, ((...a: unknown[]) => void)[]> = {};
  const hs = {
    auth: opts.token === false ? {} : { token: 'tok' + i },
    address: '127.0.0.1',
    time: 1000 + i,
    get headers(): Record<string, string> { sayac.n++; return {}; },
  };
  return {
    id: 's' + i,
    userId: opts.userId,
    handshake: hs as unknown as SahteSoket['handshake'],
    _dinleyiciler: dinleyiciler,
    once(ev, fn) { (dinleyiciler[ev] ||= []).push(fn); },
    emit() { /* yoksay */ },
    disconnect() { /* yoksay */ },
  };
}

function kur(N: number, sayac: { n: number }) {
  const harita = new Map<string, SahteSoket>();
  for (let i = 0; i < N; i++) {
    const s = sahteSoket(i, sayac);
    s.userId = 'u' + i;             // mevcut soketler kimlik dogrulanmis
    harita.set(s.id, s);
  }
  const io = { sockets: { sockets: harita } } as unknown as Server;
  return { io, harita };
}

const tetikle = (s: SahteSoket, ev: string, ...a: unknown[]) =>
  (s._dinleyiciler[ev] || []).forEach(f => f(...a));

describe('WS kabul yolu — sabit maliyet', () => {
  const ESKI = { ...process.env };
  beforeEach(() => {
    process.env.MAX_WS_PER_IP = '100000';
    process.env.MAX_UNAUTH_WS_PER_IP = '100000';
    process.env.MAX_WS_PER_USER = '100000';
    jest.resetModules();
  });
  afterEach(() => { process.env = { ...ESKI }; });

  it('N doluyken kabul maliyeti N ile BUYUMEZ', () => {
    // ASIL REGRESYON TESTI. Tarama geri gelirse bu sayac N ile buyur.
    //
    // NOT: limitler modul YUKLENIRKEN okunur. Bu yuzden env ayarlandiktan
    // SONRA taze require gerekir — aksi halde dosya basindaki statik import
    // varsayilan limiti (10) yakalar, her kabul limit yolunu tetikler ve
    // olculen sey kabul maliyeti degil REDDETME maliyeti olur.
    process.env.MAX_WS_PER_IP = '100000';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wsConnectionLimitMiddleware: mwF } = require('../socket/middleware/wsConnectionLimit');

    const sayac = { n: 0 };
    const N = 500;
    const { io, harita } = kur(N, sayac);
    const mw = mwF(io);

    // 1) TOHUMLAMA: ilk kabul bir kez gercek tarama yapar (tasarim geregi).
    const ilk = sahteSoket(9000, sayac);
    mw(ilk as never, () => { harita.set(ilk.id, ilk); });

    // 2) Tohumlama sonrasi 50 kabul OLC.
    sayac.n = 0;
    const KABUL = 50;
    for (let k = 0; k < KABUL; k++) {
      const s = sahteSoket(9100 + k, sayac);
      mw(s as never, () => { harita.set(s.id, s); });
    }

    // Her kabul YALNIZCA kendi IP'sini cozmeli: kabul basina ~1 erisim.
    // Tarama geri gelseydi bu sayi 50 * 500 = 25.000 civari olurdu.
    expect(sayac.n).toBeLessThan(KABUL * 5);
    expect(sayac.n).toBeLessThan(N);
  });

  it('ONCEDEN DOLU io haritasi dogru sayilir (tohumlama)', () => {
    // Sayaclar sifirdan baslasa ve gercek durumu tohumlamasaydi, hali hazirda
    // 10 baglantisi olan bir IP limitsizce yeni baglanti acabilirdi.
    process.env.MAX_WS_PER_IP = '10';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wsConnectionLimitMiddleware: mwF } = require('../socket/middleware/wsConnectionLimit');

    const sayac = { n: 0 };
    const { io } = kur(10, sayac);          // ZATEN 10 soket bagli
    const mw = mwF(io);

    let hata: Error | undefined;
    const s = sahteSoket(9999, sayac);
    mw(s as never, (e?: Error) => { hata = e; });
    expect(hata?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
  });

  it('AYRILAN baglanti yer acar (sayac azalir)', () => {
    process.env.MAX_WS_PER_IP = '3';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wsConnectionLimitMiddleware: mwF } = require('../socket/middleware/wsConnectionLimit');

    const sayac = { n: 0 };
    const harita = new Map<string, SahteSoket>();
    const io = { sockets: { sockets: harita } } as unknown as Server;
    const mw = mwF(io);

    const acilan: SahteSoket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = sahteSoket(i, sayac);
      mw(s as never, () => { harita.set(s.id, s); });
      acilan.push(s);
    }

    // 4. baglanti REDDEDILMELI
    let hata: Error | undefined;
    const dorduncu = sahteSoket(4, sayac);
    mw(dorduncu as never, (e?: Error) => { hata = e; });
    expect(hata?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');

    // Biri AYRILIR -> yer acilmali (sayac sizdirirsa IP kalici olarak bloke olurdu)
    harita.delete(acilan[0].id);
    tetikle(acilan[0], 'disconnect');

    let hata2: Error | undefined;
    const besinci = sahteSoket(5, sayac);
    mw(besinci as never, (e?: Error) => { hata2 = e; });
    expect(hata2).toBeUndefined();
  });

  it('sayac KAYARSA en gec dogrulama araliginda kendini onarir', () => {
    // ── IKI OZELLIK BIRDEN ────────────────────────────────────────────────
    // 1) Reddetme yolu DoS YUKSELTICI OLMAMALI: limitteki bir IP her deneme
    //    icin O(N) tarama yaptiramaz. Yani aralik icinde sayaca guvenilir.
    // 2) Ama kayma KALICI OLMAMALI: aralik dolunca gercek durum taranir ve
    //    mesru kullanici yeniden kabul edilir.
    process.env.MAX_WS_PER_IP = '2';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wsConnectionLimitMiddleware: mwF } = require('../socket/middleware/wsConnectionLimit');

    let simdi = 1_000_000;
    const saat = jest.spyOn(Date, 'now').mockImplementation(() => simdi);
    try {
      const sayac = { n: 0 };
      const harita = new Map<string, SahteSoket>();
      const io = { sockets: { sockets: harita } } as unknown as Server;
      const mw = mwF(io);

      const a = sahteSoket(1, sayac);
      mw(a as never, () => { harita.set(a.id, a); });
      const b = sahteSoket(2, sayac);
      mw(b as never, () => { harita.set(b.id, b); });

      // Soketler haritadan DUSTU ama 'disconnect' HIC tetiklenmedi -> sayac kaydi.
      harita.clear();

      // (1) Aralik ICINDE: sayaca guvenilir, tarama YAPILMAZ -> reddedilir.
      //     Bu, sel halinde O(N) is yaptirilmasini engelleyen davranistir.
      const taramaOncesi = sayac.n;
      let hata: Error | undefined;
      const c = sahteSoket(3, sayac);
      mw(c as never, (e?: Error) => { hata = e; });
      expect(hata?.message).toBe('TOO_MANY_CONNECTIONS_FROM_IP');
      // Yalnizca kendi IP'sini cozdu; tum soketleri TARAMADI.
      expect(sayac.n - taramaOncesi).toBeLessThan(5);

      // (2) Aralik DOLUNCA: gercek durum taranir, kayma onarilir, kabul edilir.
      simdi += 1500;
      let hata2: Error | undefined;
      const d = sahteSoket(4, sayac);
      mw(d as never, (e?: Error) => { hata2 = e; });
      expect(hata2).toBeUndefined();
    } finally {
      saat.mockRestore();
    }
  });

  it('kullanici basina tahliye YALNIZCA o kullanicinin soketlerine bakar', () => {
    process.env.MAX_WS_PER_USER = '2';
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { wsConnectionLimitMiddleware: mwF } = require('../socket/middleware/wsConnectionLimit');

    const sayac = { n: 0 };
    const harita = new Map<string, SahteSoket>();
    const io = { sockets: { sockets: harita } } as unknown as Server;
    const mw = mwF(io);

    const yapilan: SahteSoket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = sahteSoket(i, sayac);
      mw(s as never, () => { harita.set(s.id, s); });
      yapilan.push(s);
    }

    let tahliyeEdilen: string | null = null;
    yapilan.forEach(s => { s.disconnect = () => { tahliyeEdilen = s.id; }; });

    // Ucu de AYNI kullanici olarak SERVER tarafindan kimliklenir ->
    // 3. baglantida en eski tahliye. Client event'i authority degildir.
    for (const s of yapilan) {
      s.userId = 'ayni-kullanici';
      s._bridgeMarkAuthenticated?.('ayni-kullanici');
    }

    // EN ESKI (handshake.time en kucuk) tahliye edilmeli.
    expect(tahliyeEdilen).toBe('s0');
  });
});
