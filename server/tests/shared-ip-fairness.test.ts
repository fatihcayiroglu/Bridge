// server/tests/shared-ip-fairness.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PAYLAŞILAN IP (NAT) ADALETİ — BİR KÖTÜ NİYETLİ TÜM OKULU BANLAMAMALI
// ════════════════════════════════════════════════════════════════════════════
// Okul, yurt, ofis ve CGNAT arkasındaki kullanıcılar TEK bir genel IP paylaşır.
// v1.123/v1.124'te bu risk ÜÇ kez bağımsız olarak gözlendi:
//
import { makeJwtUser } from './helpers/userDoubles';
import type { Request, Response, NextFunction } from 'express';
//   1. `MAX_WS_PER_IP=10` ile tek IP'den tam 10 soket bağlanabildi, 11. reddedildi.
//   2. Tek kullanıcının başarısız 2FA denemeleri TÜM IP'yi 600 sn banladı
//      (`ratelimit.auto_ban.applied — twoFactor 10x aşıldı`).
//   3. 200 sanal kullanıcılı yük testi IP'yi banlattı
//      (`global 29x aşıldı`) — sunucu 443 req/s'yi p50 5 ms ile taşırken.
//
// Bridge'in hız sınırlayıcısı ZATEN hesap-farkında bir model kullanır
// (`mode: 'combined'`): kimliği doğrulanmış istek HEM hesap kotasına HEM de
// IP toplamına (`max * RL_SHARED_IP_FACTOR`) sayılır. Bu dosya o modelin
// gerçekten adil davrandığını kilitler — ve asıl soruyu yanıtlar:
//
//   TEK bir kötüye kullanan, aynı IP'deki MASUM kullanıcıları düşürüyor mu?
//
// Güvenlik tarafı ASLA gevşetilmez: anonim seller ve gerçek taşkınlar hâlâ
// durdurulmalıdır. Testler her iki yönü de doğrular.
process.env.NODE_ENV = 'test';
// Bridge, `TRUSTED_PROXY_COUNT` ayarlanmadikca X-Forwarded-For basligini
// BILEREK yok sayar (lib/clientIp.ts) — guvenli varsayilan budur. Bu test
// farkli NAT IP'lerini temsil ettigi icin tek bir vekil hop'u tanimlanir;
// aksi halde TUM senaryolar 127.0.0.1 altinda ayni butceyi paylasirdi.
process.env.TRUSTED_PROXY_COUNT = '1';

import type { Server } from 'http';
import express from 'express';
import request from 'supertest';

import { rateLimit } from '../middleware/rateLimit';

// Her senaryo KENDI genel IP'sini kullanir. Tek bir IP paylasmak, testlerin
// birbirinin IP butcesini tuketmesine ve olcumun anlamsizlasmasina yol acar
// (ilk surumde tam olarak bu oldu: 20 kullanici x 4 istek = 80, tavan 100).
let natIpCounter = 0;
const freshNatIp = () => `203.0.113.${++natIpCounter}`;   // RFC 5737 test araligi

/** Kimlik doğrulanmış kullanıcıyı taklit eden minimal middleware. */
function fakeAuth(req: express.Request, _res: express.Response, next: express.NextFunction) {
  const uid = req.header('x-test-user');
  if (uid) req.user = makeJwtUser(uid);
  next();
}

let server: Server;

beforeAll(done => {
  const app = express();
  app.set('trust proxy', true);
  app.use(fakeAuth);
  // Kucuk kota: davranisi hizli ve deterministik gozlemlemek icin.
  app.use('/api', rateLimit(5, 60_000, 'natfair'));
  app.get('/api/ping', (_req: Request, res: Response) => { res.json({ ok: true }); });
  server = app.listen(0, done);
});

afterAll(done => { server.close(done); });

/** Tek kullanıcı adına N istek yapar; kaç tanesinin geçtiğini döner. */
async function burst(userId: string | null, n: number, ip: string): Promise<{ ok: number; limited: number }> {
  let ok = 0, limited = 0;
  for (let i = 0; i < n; i++) {
    const req = request(server).get('/api/ping').set('X-Forwarded-For', ip);
    if (userId) req.set('x-test-user', userId);
    const res = await req;
    if (res.status === 200) ok++;
    else if (res.status === 429) limited++;
  }
  return { ok, limited };
}

describe('senaryo A — aynı IP arkasındaki MEŞRU kullanıcılar birbirini engellemez', () => {
  it('20 kullanıcı kendi kotası içinde kalırsa HEPSİ hizmet alır', async () => {
    const ip = freshNatIp();
    const results: Array<{ ok: number; limited: number }> = [];
    // 20 kullanici x 4 istek = 80 < IP tavani (5 * RL_SHARED_IP_FACTOR = 100).
    for (let u = 0; u < 20; u++) {
      results.push(await burst(`nat-user-${u}`, 4, ip));   // kota 5 → 4 guvenli
    }

    // Kritik iddia: 20. kullanici da 1. kadar hizmet alir.
    expect(results.every(r => r.ok === 4)).toBe(true);
    expect(results.every(r => r.limited === 0)).toBe(true);
  });

  it('bir kullanıcının kotası TÜKENSE bile komşusu etkilenmez', async () => {
    const ip = freshNatIp();
    const heavy = await burst('nat-heavy', 12, ip);    // kendi kotasini asar
    expect(heavy.limited).toBeGreaterThan(0);          // kendisi sinirlanir

    // AYNI IP'deki temiz kullanici hâlâ normal hizmet alir.
    const neighbour = await burst('nat-neighbour', 4, ip);
    expect(neighbour.ok).toBe(4);
    expect(neighbour.limited).toBe(0);
  });
});

describe('senaryo C — bir kötüye kullanan masumları düşürmemeli', () => {
  it('tek kullanıcının aşırı trafiği KENDİ kotasını tüketir', async () => {
    const abuser = await burst('nat-abuser', 30, freshNatIp());

    // Kotayi asan istekler reddedilir — koruma CALISIR.
    expect(abuser.limited).toBeGreaterThan(0);
    // Ama ilk birkaci gecmis olmalidir; kullanici tamamen kilitlenmez.
    expect(abuser.ok).toBeGreaterThan(0);
  });

  it('ISRARLI kötüye kullanan, paylaşılan IP bütçesini TÜKETEMEZ', async () => {
    const ip = freshNatIp();

    // Bu sayi BILEREK IP tavaninin uzerindedir.
    //   hesap kotasi      = 5
    //   IP tavani         = 5 * RL_SHARED_IP_FACTOR(20) = 100
    //   kotuye kullanan   = 150 istek
    //
    // DUZELTME OLMADAN: 150 istegin TAMAMI IP sayacini artirirdi (145'i zaten
    // reddedilmis olsa bile) -> IP sayaci 150 > 100 -> ayni NAT arkasindaki
    // MASUM kullanici da 429 alirdi.
    //
    // DUZELTME ILE: hesap kendi kotasini astiktan sonraki istekler IP
    // butcesine DOKUNMAZ -> IP sayaci 5'te kalir -> komsu etkilenmez.
    const abuser = await burst('nat-abuser-2', 150, ip);
    expect(abuser.limited).toBeGreaterThan(100);   // kotuye kullanan durduruldu

    const innocent = await burst('nat-innocent', 4, ip);

    // ASIL ADALET IDDIASI: masum kullanici, komsusunun davranisi yuzunden
    // hizmet disi KALMAZ.
    expect(innocent.ok).toBe(4);
    expect(innocent.limited).toBe(0);
  });
});

describe('güvenlik gevşetilmedi', () => {
  it('KİMLİKSİZ trafik yalnızca IP kotasına tabidir ve sınırlanır', async () => {
    const anon = await burst(null, 25, freshNatIp());
    // Anonim taskin DURDURULUR — paylasilan IP adaleti bunu degistirmez.
    expect(anon.limited).toBeGreaterThan(0);
  });

  it('IP toplam tavanı VARDIR — sınırsız hesap açmak korumayı atlatmaz', async () => {
    // Cok sayida FARKLI hesap, ayni IP'den toplam tavana kadar sayilir.
    const ip = freshNatIp();
    let totalLimited = 0;
    for (let u = 0; u < 40; u++) {
      const r = await burst(`flood-account-${u}`, 5, ip);
      totalLimited += r.limited;
    }
    // 40 hesap x 5 istek = 200 istek; IP tavani (5 * RL_SHARED_IP_FACTOR=20 = 100)
    // asildigi icin bir noktadan sonra sinirlanma BASLAMALIDIR.
    expect(totalLimited).toBeGreaterThan(0);
  });

  it('hız sınırı yanıtı Retry-After taşır', async () => {
    const ip = freshNatIp();
    await burst('nat-retry', 10, ip);
    const res = await request(server).get('/api/ping')
      .set('X-Forwarded-For', ip).set('x-test-user', 'nat-retry');
    if (res.status === 429) {
      expect(res.headers['retry-after']).toBeTruthy();
    }
  });
});
