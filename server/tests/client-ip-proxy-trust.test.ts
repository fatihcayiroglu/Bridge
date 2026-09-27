// server/tests/client-ip-proxy-trust.test.ts
//
// İSTEMCİ IP ÇÖZÜMLEME — PROXY GÜVENİ VE X-FORWARDED-FOR SAHTECİLİĞİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (P1)
// ════════════════════════════════════════════════════════════════════════════
// Bridge'te iki ayrı `getClientIp` vardı ve aynı girdide farklı yanıt
// veriyorlardı:
//
//   rateLimit.ts : idx = hops.length - N
//   ipBan.ts     : idx = hops.length - N - 1      ← BİR EKSİK
//
// Ölçüldü (TRUSTED_PROXY_COUNT=1, saldırgan kendi XFF'ini gönderiyor,
// proxy gerçek IP'yi sona ekliyor):
//
//   X-Forwarded-For: 1.2.3.4, 203.0.113.9
//     rateLimit → 203.0.113.9   DOĞRU
//     ipBan     → 1.2.3.4       SALDIRGAN KONTROLÜNDE
//
// Otomatik ban `rateLimit` tarafında DOĞRU IP ile KAYDEDİLİYOR
// (rateLimit.ts:350), ama `ipBan` middleware'i SAHTELENEBİLİR IP ile
// KONTROL ediyordu (ipBan.ts:183). Yani yasaklı bir istemci HERHANGİ bir
// X-Forwarded-For başlığı göndererek yasağı ATLATIYORDU — arama tamamen
// başka bir anahtara bakıyordu.
//
// Aynı sahtelenebilir değer `ipReputation.ts` ve üç admin rotasındaki
// denetim kaydı aktör IP'si için de kullanılıyordu.
//
// DÜZELTME: tek kanonik sahip (`lib/clientIp.ts`), açık güven modeli ve
// KAPALI DEVRE varsayılan (TRUSTED_PROXY_COUNT=0 → XFF'e hiç güvenme).

import { getClientIp, trustedProxyCount, auditProxyConfig } from '../lib/clientIp';
import { getClientIp as ipBanResolver } from '../middleware/ipBan';

const GERCEK = '203.0.113.9';     // proxy'nin ekledigi gercek istemci
const SAHTE  = '1.2.3.4';         // saldirganin yazdigi deger

function req(xff?: string | string[], socket = GERCEK) {
  return {
    ip: '127.0.0.1',
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    socket: { remoteAddress: socket },
  };
}

let saved: string | undefined;
beforeEach(() => { saved = process.env.TRUSTED_PROXY_COUNT; });
afterEach(() => {
  if (saved === undefined) delete process.env.TRUSTED_PROXY_COUNT;
  else process.env.TRUSTED_PROXY_COUNT = saved;
});
const setN = (n: string) => { process.env.TRUSTED_PROXY_COUNT = n; };

// ════════════════════════════════════════════════════════════════════════════
// SÖMÜRÜ — gerileme kilidi
// ════════════════════════════════════════════════════════════════════════════
describe('X-Forwarded-For sahteciliği', () => {
  it('SÖMÜRÜ: saldırganın yazdığı hop KAZANMAZ', () => {
    setN('1');
    expect(getClientIp(req(`${SAHTE}, ${GERCEK}`))).toBe(GERCEK);
  });

  it('birden çok sahte hop da KAZANMAZ', () => {
    setN('1');
    expect(getClientIp(req(`${SAHTE}, 5.6.7.8, ${GERCEK}`))).toBe(GERCEK);
  });

  it('loopback sahteciliği (klasik atlatma denemesi) KAZANMAZ', () => {
    // `X-Forwarded-For: 127.0.0.1` ile ic-ag/localhost gorunmeye calismak.
    setN('1');
    expect(getClientIp(req(`127.0.0.1, ${GERCEK}`))).toBe(GERCEK);
  });

  it('İKİ modül artık AYNI cevabı verir (asimetri kapandı)', () => {
    // Kusurun ozu buydu: ban KAYDI ile ban KONTROLU farkli anahtar uretiyordu.
    setN('1');
    const r = req(`${SAHTE}, ${GERCEK}`);
    expect({ kanonik: getClientIp(r), ipBan: ipBanResolver(r) })
      .toEqual({ kanonik: GERCEK, ipBan: GERCEK });
  });

  it('YASAK ATLATMA senaryosu: kayıt ve kontrol anahtarı ÖRTÜŞÜR', () => {
    setN('1');
    const temiz     = req(GERCEK);                      // ban burada olusur
    const sahteciyi = req(`${SAHTE}, ${GERCEK}`);       // saldirgan XFF ekler
    // Iki istekte de ayni anahtar cikmali, yoksa yasak atlatilir.
    expect(getClientIp(sahteciyi)).toBe(getClientIp(temiz));
  });
});

// ════════════════════════════════════════════════════════════════════════════
// GÜVEN MODELİ
// ════════════════════════════════════════════════════════════════════════════
describe('güven modeli', () => {
  it('VARSAYILAN kapalı devre: XFF’e hiç güvenilmez', () => {
    delete process.env.TRUSTED_PROXY_COUNT;
    expect(trustedProxyCount()).toBe(0);
    expect(getClientIp(req(`${SAHTE}, ${GERCEK}`))).toBe(GERCEK); // soket adresi
  });

  it('N=0 açıkça verilirse de XFF yok sayılır', () => {
    setN('0');
    expect(getClientIp(req(SAHTE))).toBe(GERCEK);
  });

  it('N=2 zincirinde gerçek istemci doğru seçilir', () => {
    // istemci → p1 → p2 → uygulama  ⇒  XFF: "istemci, p1"
    setN('2');
    expect(getClientIp(req(`${GERCEK}, 10.0.0.1`))).toBe(GERCEK);
  });

  it('N=2 iken saldırgan ön ek eklerse yine gerçek istemci seçilir', () => {
    setN('2');
    expect(getClientIp(req(`${SAHTE}, ${GERCEK}, 10.0.0.1`))).toBe(GERCEK);
  });

  it('BEKLENENDEN AZ hop varsa sokete düşülür — hops[0]’a DEĞİL', () => {
    // Eski kod burada tam da saldirganin yazdigi ilk hop'a dusuyordu.
    setN('3');
    expect(getClientIp(req(SAHTE))).toBe(GERCEK);
  });

  it('geçersiz TRUSTED_PROXY_COUNT güvenli tarafa (0) düşer', () => {
    for (const bad of ['abc', '-1', '', ' ']) {
      process.env.TRUSTED_PROXY_COUNT = bad;
      expect({ bad, n: trustedProxyCount() }).toEqual({ bad, n: 0 });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — meşru dağıtım ÇALIŞMAYA devam eder
// ════════════════════════════════════════════════════════════════════════════
describe('meşru proxy dağıtımı', () => {
  it('tek proxy arkasında GERÇEK istemci IP’si döner', () => {
    // Bu olmadan yukaridaki tum testler "her zaman soket adresi don" gibi
    // asiri genis bir yamada da yesil kalirdi.
    setN('1');
    expect(getClientIp(req(GERCEK, '10.0.0.1'))).toBe(GERCEK);
  });

  it('iki FARKLI istemci FARKLI anahtar üretir (izolasyon korunur)', () => {
    setN('1');
    const a = getClientIp(req('198.51.100.1', '10.0.0.1'));
    const b = getClientIp(req('198.51.100.2', '10.0.0.1'));
    expect({ ayni: a === b }).toEqual({ ayni: false });
  });

  it('IPv4-mapped IPv6 normalize edilir', () => {
    setN('1');
    expect(getClientIp(req(`::ffff:${GERCEK}`))).toBe(GERCEK);
  });

  it('dizi biçimli XFF başlığı da işlenir', () => {
    setN('1');
    expect(getClientIp(req([SAHTE, GERCEK]))).toBe(GERCEK);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEĞİŞMEZ — saldırganın yazdığı hiçbir değer sonuç OLAMAZ
// ════════════════════════════════════════════════════════════════════════════
describe('DEĞİŞMEZ: saldırgan ön ekleri asla seçilmez', () => {
  it('rastgele üretilen 200 sahte zincirin HİÇBİRİ kazanmaz', () => {
    setN('1');
    const ihlal: string[] = [];
    for (let i = 0; i < 200; i++) {
      // Saldirgan istedigi kadar, istedigi degerde hop yazabilir.
      const n = 1 + (i % 5);
      const sahteler = Array.from({ length: n }, (_, k) => `9.9.${i % 256}.${k}`);
      const xff = [...sahteler, GERCEK].join(', ');
      const sonuc = getClientIp(req(xff));
      if (sonuc !== GERCEK) ihlal.push(`${xff} → ${sonuc}`);
    }
    expect({ ihlal }).toEqual({ ihlal: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// BAŞLANGIÇ YAPILANDIRMA DOĞRULAMASI
// ════════════════════════════════════════════════════════════════════════════
describe('auditProxyConfig', () => {
  it('üretimde TANIMSIZ ayar için uyarı verir', () => {
    expect(auditProxyConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv).length)
      .toBeGreaterThan(0);
  });
  it('üretimde açık ayar varsa uyarı YOK', () => {
    expect(auditProxyConfig({ NODE_ENV: 'production', TRUSTED_PROXY_COUNT: '1' } as NodeJS.ProcessEnv))
      .toEqual([]);
  });
  it('geçersiz değer uyarı üretir', () => {
    expect(auditProxyConfig({ TRUSTED_PROXY_COUNT: 'abc' } as NodeJS.ProcessEnv).length)
      .toBeGreaterThan(0);
  });
  it('olağandışı yüksek hop sayısı uyarı üretir', () => {
    expect(auditProxyConfig({ TRUSTED_PROXY_COUNT: '9' } as NodeJS.ProcessEnv).length)
      .toBeGreaterThan(0);
  });
  it('üretim DIŞINDA tanımsız ayar uyarı üretmez', () => {
    expect(auditProxyConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toEqual([]);
  });
});
