// server/tests/cloudflare-client-ip.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// CLOUDFLARE ARKASINDA GERÇEK İSTEMCİ IP'Sİ — P0
// ════════════════════════════════════════════════════════════════════════════
// Bridge'in TÜM kötüye kullanım savunması istemci kimliğine dayanır: hız
// sınırı, IP yasağı, ve v1.124'te eklenen paylaşılan-IP adaleti.
//
// Cloudflare arkasında bir tek hata bunların hepsini çökertir:
//
//   Bridge, Cloudflare POP IP'sini istemci sanarsa
//   → TÜM kullanıcılar TEK bir kimlik gibi görünür
//   → bir kişinin davranışı HERKESİ etkiler
//   → paylaşılan-IP adaleti anlamsızlaşır
//
// Bu yüzden bu dosya, İNTERNETE AÇILMADAN ÖNCE zorunlu olan iki şeyi
// kanıtlar:
//
//   1. Cloudflare → nginx → Bridge zincirinde GERÇEK istemci IP'si çözülür.
//   2. DOĞRUDAN origin'e giden bir saldırgan, başlık uydurarak kaynak IP'sini
//      SAHTELEYEMEZ.
//
// ── TOPOLOJİ ────────────────────────────────────────────────────────────────
// Cloudflare, istemcinin gönderdiği `X-Forwarded-For` değerini SİLMEZ; kendi
// gördüğü gerçek istemciyi zincire EKLER. nginx de kendi hop'unu ekler:
//
//   istemci uydurması yok :  "<client>"                → nginx → "<client>, <cf>"
//   istemci uydurdu       :  "<evil>"  → cf → "<evil>, <client>" → "<evil>, <client>, <cf>"
//
// Her iki durumda da gerçek istemci, SONDAN `TRUSTED_PROXY_COUNT` kadar
// geridedir. Cloudflare + nginx için bu değer **2**'dir.
process.env.NODE_ENV = 'test';

import { getClientIp, trustedProxyCount } from '../lib/clientIp';

const CF_EDGE = '172.68.10.5';        // Cloudflare POP
const REAL_CLIENT = '203.0.113.40';   // gerçek kullanıcı
const ATTACKER_FAKE = '10.9.9.9';     // saldırganın uydurduğu değer
const SOCKET_ADDR = '198.51.100.7';   // gerçek TCP eş adresi

interface FakeReq {
  headers: Record<string, string | string[] | undefined>;
  socket: { remoteAddress?: string };
}

function req(headers: Record<string, string | string[] | undefined>, remote = SOCKET_ADDR): FakeReq {
  return { headers, socket: { remoteAddress: remote } };
}

afterEach(() => { delete process.env.TRUSTED_PROXY_COUNT; });

describe('Cloudflare + nginx zinciri (TRUSTED_PROXY_COUNT=2)', () => {
  beforeEach(() => { process.env.TRUSTED_PROXY_COUNT = '2'; });

  it('gerçek istemci IP\'si çözülür — Cloudflare POP DEĞİL', () => {
    // cf istemciyi ekledi, nginx kendi hop'unu ekledi
    const ip = getClientIp(req({ 'x-forwarded-for': `${REAL_CLIENT}, ${CF_EDGE}` }) as never);

    expect(ip).toBe(REAL_CLIENT);
    // KRITIK: POP adresi istemci sanilirsa TUM kullanicilar tek kimlige coker.
    expect(ip).not.toBe(CF_EDGE);
  });

  it('istemci X-Forwarded-For UYDURSA bile gerçek IP çözülür', () => {
    // Cloudflare, istemcinin uydurdugu degeri SILMEZ; gercek istemciyi EKLER.
    const ip = getClientIp(req({
      'x-forwarded-for': `${ATTACKER_FAKE}, ${REAL_CLIENT}, ${CF_EDGE}`,
    }) as never);

    expect(ip).toBe(REAL_CLIENT);
    expect(ip).not.toBe(ATTACKER_FAKE);
  });

  it('birden fazla uydurma hop da kaynak IP\'yi ele geçiremez', () => {
    const ip = getClientIp(req({
      'x-forwarded-for': `1.1.1.1, 2.2.2.2, 3.3.3.3, ${REAL_CLIENT}, ${CF_EDGE}`,
    }) as never);
    expect(ip).toBe(REAL_CLIENT);
  });

  it('AYNI NAT arkasındaki farklı kullanıcılar FARKLI kimlik olarak görünür', () => {
    // Paylasilan-IP adaletinin on kosulu: kullanicilarin ayirt edilebilmesi.
    const a = getClientIp(req({ 'x-forwarded-for': `203.0.113.11, ${CF_EDGE}` }) as never);
    const b = getClientIp(req({ 'x-forwarded-for': `203.0.113.12, ${CF_EDGE}` }) as never);
    expect(a).not.toBe(b);
  });

  it('zincir beklenenden KISAysa sokete düşer, uydurmaya DEĞİL', () => {
    // Yalnizca bir hop var: beklenen iki proxy zinciri yok demektir. Guvenli
    // davranis, guvenilmeyen basliga degil GERCEK soket adresine dusmektir.
    const ip = getClientIp(req({ 'x-forwarded-for': ATTACKER_FAKE }) as never);
    expect(ip).toBe(SOCKET_ADDR);
    expect(ip).not.toBe(ATTACKER_FAKE);
  });
});

describe('DOĞRUDAN origin erişimi — hiçbir başlık güvenilmez', () => {
  it('TRUSTED_PROXY_COUNT tanımsızken XFF tamamen YOK SAYILIR', () => {
    // Varsayilan kapali devredir: proxy yapilandirilmadikca baslik hicbir
    // sekilde kimlik belirlemez.
    expect(trustedProxyCount()).toBe(0);

    const ip = getClientIp(req({ 'x-forwarded-for': `${ATTACKER_FAKE}, ${CF_EDGE}` }) as never);
    expect(ip).toBe(SOCKET_ADDR);
  });

  it('CF-Connecting-IP TEK BAŞINA kimlik BELİRLEMEZ', () => {
    // Bu baslik Cloudflare'e ozgudur ama DOGRUDAN origin'e giden bir saldirgan
    // da yazabilir. Bridge onu yetki kaynagi olarak KULLANMAZ; kimlik yalnizca
    // guvenilen proxy sinirindan gecen zincirden turetilir.
    const ip = getClientIp(req({ 'cf-connecting-ip': ATTACKER_FAKE }) as never);
    expect(ip).toBe(SOCKET_ADDR);
    expect(ip).not.toBe(ATTACKER_FAKE);
  });

  it('CF-Connecting-IP, proxy güvenilse BİLE XFF\'in yerine geçmez', () => {
    process.env.TRUSTED_PROXY_COUNT = '2';
    const ip = getClientIp(req({
      'cf-connecting-ip': ATTACKER_FAKE,
      'x-forwarded-for': `${REAL_CLIENT}, ${CF_EDGE}`,
    }) as never);

    // Kanonik zincir kazanir; tek basina bir baslik onu ezemez.
    expect(ip).toBe(REAL_CLIENT);
  });

  it('geçersiz TRUSTED_PROXY_COUNT değerleri 0 sayılır (kapalı devre)', () => {
    for (const bad of ['-1', 'abc', '0', '']) {
      process.env.TRUSTED_PROXY_COUNT = bad;
      expect(trustedProxyCount()).toBe(0);
      expect(getClientIp(req({ 'x-forwarded-for': ATTACKER_FAKE }) as never)).toBe(SOCKET_ADDR);
    }
  });
});

describe('yanlış yapılandırma tespiti', () => {
  it('TRUSTED_PROXY_COUNT=1 iken Cloudflare zinciri POP adresini verir', () => {
    // Bu, operatorun yapabilecegi EN TEHLIKELI hatadir: Cloudflare + nginx
    // varken 1 yazmak, POP adresini istemci sanmaya yol acar ve tum
    // kullanicilar tek kimlige coker. Test bunu BELGELER ki
    // CLOUDFLARE-PRODUCTION.md'deki "2 olmali" uyarisi kanita dayansin.
    process.env.TRUSTED_PROXY_COUNT = '1';
    const ip = getClientIp(req({ 'x-forwarded-for': `${REAL_CLIENT}, ${CF_EDGE}` }) as never);

    expect(ip).toBe(CF_EDGE);          // YANLIS kimlik — yapilandirma hatasi
    expect(ip).not.toBe(REAL_CLIENT);
  });

  it('TRUSTED_PROXY_COUNT=2 aynı istekte DOĞRU kimliği verir', () => {
    process.env.TRUSTED_PROXY_COUNT = '2';
    expect(getClientIp(req({ 'x-forwarded-for': `${REAL_CLIENT}, ${CF_EDGE}` }) as never))
      .toBe(REAL_CLIENT);
  });
});
