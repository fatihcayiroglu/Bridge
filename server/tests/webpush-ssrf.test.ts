// server/tests/webpush-ssrf.test.ts
//
// WEB PUSH ENDPOINT'İ ÜZERİNDEN SSRF
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK ZAYIFLIK
// ════════════════════════════════════════════════════════════════════════════
// Sunucunun giden istekleri `lib/fetch.ts` (`fetchT`) içindeki SSRF guard'ından
// geçer: protokol beyaz listesi, çıplak IP kontrolü, DNS ile çözülen TÜM
// adreslerin doğrulanması ve bağlantı anında yeniden doğrulama.
//
// ANCAK `web-push` kütüphanesi HTTP isteğini KENDİ İÇİNDE yapar. `fetchT`
// kullanılmaz, dispatcher devreye girmez. `endpoint` ise doğrudan
// KULLANICIDAN gelir:
//
//     POST /api/webpush/subscribe
//     { "endpoint": "https://169.254.169.254/latest/meta-data/", ... }
//     → POST /api/webpush/test        (saldırgan istediği an tetikler)
//
// Eski kontrol yalnızca uzunluğa, URL geçerliliğine ve `https:` şemasına
// bakıyordu — HEDEF ADRESE değil. Kimliği doğrulanmış herhangi bir kullanıcı
// sunucuyu iç ağa istek atmaya zorlayabiliyordu.
//
// SÖMÜRÜ SINIRLARI (dürüstlük için): yanıt gövdesi saldırgana DÖNMEZ (kör
// SSRF) ve `https:` şartı hedefin TLS konuşmasını gerektirir. Yine de
// bağlantı zamanlaması iç port taraması için güvenilir bir oracle'dır ve iç
// HTTPS servisleri (yönetim panelleri, k8s API, servis mesh) erişilebilir
// kalır. Bu yüzden kapatılmıştır.
//
// ── İKİ KATMANLI SAVUNMA ──────────────────────────────────────────────────
// 1. KAYIT anında (`routes/webpush.ts`) → net 400, kötü satır hiç yazılmaz.
// 2. GÖNDERİM anında (`lib/pushSender.ts`) → çünkü (a) bu düzeltmeden ÖNCE
//    yazılmış satırlar doğrulanmamıştır, (b) DNS kayıt ile kullanım arasında
//    yeniden bağlanabilir (rebinding).

import dns from 'dns/promises';
import { assertUrlIsPublic, assertUrlIsPublicSync, SSRFError } from '../lib/ssrfGuard';

/** Hedefin reddedilip reddedilmediğini boolean'a indirger. */
async function isBlocked(url: string): Promise<boolean> {
  try {
    await assertUrlIsPublic(url);
    return false;
  } catch (err) {
    return err instanceof SSRFError;
  }
}

describe('push endpoint SSRF guard — iç ağ hedefleri', () => {
  // Gerçek saldırı yükleri: bulut metadata, loopback, RFC1918, link-local,
  // IPv6 loopback ve IPv4-eşlemeli IPv6 kaçamağı.
  const HOSTILE = [
    'https://169.254.169.254/latest/meta-data/',      // AWS/GCP metadata
    'https://127.0.0.1/admin',                        // loopback
    'https://10.0.0.5/internal',                      // RFC1918
    'https://192.168.1.1/router',
    'https://172.16.0.10/service',
    'https://[::1]/admin',                            // IPv6 loopback
    'https://[::ffff:127.0.0.1]/admin',               // IPv4-mapped IPv6
    'https://0.0.0.0/',                               // "any" adresi
  ];

  it('REDDEDER: https://localhost/admin — DNS sonucu deterministik loopback', async () => {
    // `localhost` cozumlemesini OS/DNS zamanlamasina birakmak bu guvenlik
    // testini kirilgan yapar. Public/private karari hala production guard'a aittir.
    const r4 = jest.spyOn(dns, 'resolve4').mockResolvedValue(['127.0.0.1']);
    const r6 = jest.spyOn(dns, 'resolve6').mockResolvedValue(['::1']);
    const lk = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
    try {
      expect(await isBlocked('https://localhost/admin')).toBe(true);
    } finally {
      r4.mockRestore(); r6.mockRestore(); lk.mockRestore();
    }
  });

  it.each(HOSTILE)('REDDEDER: %s', async (url) => {
    // KANITLAR   : kullanıcı kontrolündeki endpoint iç ağa yönlendirilemez.
    // KANITLAMAZ : `web-push` kütüphanesinin iç davranışını (ona hiç ulaşılmaz).
    const blocked = await isBlocked(url);
    expect({ url, blocked }).toEqual({ url, blocked: true });
  });

  it('http/https DIŞI şemalar reddedilir', async () => {
    // `file:`, `gopher:` gibi şemalar klasik SSRF yükseltme yollarıdır.
    for (const url of ['file:///etc/passwd', 'gopher://127.0.0.1:6379/_INFO']) {
      const blocked = await isBlocked(url);
      expect({ url, blocked }).toEqual({ url, blocked: true });
    }
  });

  it('GÖNDERİM katmanı ÇÖZÜLEMEYEN hostu reddeder (fail-closed)', async () => {
    // `fetchT` DNS cozulemedinde bilerek gecirir (gecici DNS hatasi tum giden
    // istekleri kirmasin diye). Ama guard'in uygulanamadigi ucuncu taraf
    // cagrilarda "cozulemedi" = "dogrulanmadi"dir: kontrol aninda cozulmeyen
    // bir ad, cagri aninda cozulup hicbir denetimden gecmeden baglanabilir.
    //
    // ── NEDEN `.invalid` ────────────────────────────────────────────────
    // Bu test onceden `metadata.google.internal` kullaniyordu ve GERCEK DNS'e
    // bagimliydi. Ag kosullari degisince cozumleme 10 saniyeyi asti ve test
    // ZAMAN ASIMINDAN dustu — mantik dogru olmasina ragmen. Disariya bagimli
    // bir test kirilgandir.
    //
    // `.invalid` RFC 2606 ile AYRILMISTIR: cozumleyiciler yukari sormadan
    // aninda NXDOMAIN doner. Ayni sozlesme, belirlenimci sekilde olculur.
    const r4 = jest.spyOn(dns, 'resolve4').mockRejectedValue(new Error('NXDOMAIN'));
    const r6 = jest.spyOn(dns, 'resolve6').mockRejectedValue(new Error('NXDOMAIN'));
    const lk = jest.spyOn(dns, 'lookup').mockRejectedValue(new Error('ENOTFOUND'));
    try {
      expect(await isBlocked('https://bridge-nonexistent.invalid/endpoint')).toBe(true);
    } finally {
      r4.mockRestore(); r6.mockRestore(); lk.mockRestore();
    }
  });

  it('MEŞRU push sağlayıcısı ENGELLENMEZ', async () => {
    // Aşırı sıkı bir kural bildirimleri tamamen kırardı. Dış internete güvenmek
    // yerine FCM hostname'inin GENEL bir IP'ye çözülmesini deterministik ver;
    // public/private kararı hâlâ gerçek SSRF policy kodundadır.
    const r4 = jest.spyOn(dns, 'resolve4').mockResolvedValue(['142.250.72.234']);
    const r6 = jest.spyOn(dns, 'resolve6').mockResolvedValue([]);
    const lk = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '142.250.72.234', family: 4 }] as any);
    try {
      const ok = 'https://fcm.googleapis.com/fcm/send/abc123';
      expect(await isBlocked(ok)).toBe(false);
    } finally {
      r4.mockRestore(); r6.mockRestore(); lk.mockRestore();
    }
  });
});

describe('kaynak sözleşmesi — guard gerçekten bağlı', () => {
  // Mantık doğru olsa bile çağrı silinirse koruma çalışmaz. Bu iki kontrol
  // savunmanın HER İKİ katmanının da yerinde durduğunu doğrular.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

  it('KAYIT katmanı: /webpush/subscribe adresi doğruluyor', () => {
    const route = read('routes/webpush.ts');
    const policy = read('lib/webPushSubscriptionPolicy.ts');
    expect(route).toContain('validateWebPushSubscription(req.body)');
    expect(policy).toContain('assertUrlIsPublicSync(raw.endpoint)');
  });

  it('GÖNDERİM katmanı: sendWebPush adresi doğruluyor', () => {
    const src = read('lib/pushSender.ts');
    expect(src).toContain('assertUrlIsPublic(subscription.endpoint)');
    // Doğrulama, kütüphaneye teslimden ÖNCE olmalı. (Yorumlardaki geçişler
    // değil, GERÇEK çağrı hedef alınır.)
    expect(src.indexOf('assertUrlIsPublic(subscription.endpoint)'))
      .toBeLessThan(src.indexOf('_withRetry(() => wp.sendNotification'));
  });
});
