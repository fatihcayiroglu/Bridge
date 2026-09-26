// server/tests/turn-config.test.ts
//
// TURN/ICE YAPILANDIRMASI — DURUM RAPORU İLE GERÇEK ÇIKTININ TUTARLILIĞI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `lib/turnConfig.ts` bu programa kadar ADANMIŞ TESTSİZDİ. İki gerçek kusur
// barındırıyordu ve ikisi de operatörden GİZLİYDİ:
//
// A) DURUM RAPORU YALAN SÖYLÜYORDU
//    `getTurnStatus()`  → hasMetered = !!METERED_API_KEY
//    `getIceServers()`  → metered dalı ayrıca METERED_APP_NAME + TURN_URL +
//                         TURN_USERNAME + TURN_CREDENTIAL istiyordu.
//    Yalnızca METERED_API_KEY ayarlıysa:
//        durum  → { turn: true, provider: 'metered', warning: null }
//        gerçek → SIFIR turn girdisi
//    Yani /api/health "TURN hazır" derken NAT arkasındaki kullanıcılar sese
//    hiç bağlanamıyordu ve uyarı da BASTIRILIYORDU.
//
// B) ÖNCELİK TUZAĞI
//    `else if` zinciri: metered anahtarları ayarlıysa dal SEÇİLİYOR ama
//    yayın yapamıyorsa 4. dal (manuel statik TURN) ATLANIYOR ve sonuç sıfır
//    TURN oluyordu — kullanılabilir bir statik yapılandırma varken.
//
// ── EN ÖNEMLİ TEST ──────────────────────────────────────────────────────────
// Aşağıdaki DEĞİŞMEZ taraması: her yapılandırma kombinasyonu için
//     status.turn  ===  (yayılan listede gerçekten turn:/turns: var mı)
// Bu, A sınıfı kusurun bir daha SESSİZCE geri gelmesini yapısal olarak
// engeller — tek tek senaryo yazmaya gerek kalmadan.

import crypto from 'crypto';
import { getIceServers, getIceTransportPolicy, getRtcIceConfig, getTurnStatus, generateTimeLimitedCredential } from '../lib/turnConfig';

type IceEntry = { urls?: string | string[]; username?: string; credential?: string };

const TURN_ENV = [
  'STUN_URLS', 'TURN_SECRET', 'TURN_HOST', 'TURN_PORT', 'TURN_TLS_PORT',
  'TURN_TLS_443', 'METERED_API_KEY', 'METERED_APP_NAME', 'TURN_URL',
  'TURN_URL_TLS', 'TURN_USERNAME', 'TURN_CREDENTIAL', 'FORCE_TURN', 'FORCE_RELAY',
];

let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = {};
  for (const k of TURN_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of TURN_ENV) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

function urlsOf(entry: IceEntry): string[] {
  const raw = entry.urls;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}
function turnUrls(servers: object[]): string[] {
  return servers.flatMap(s => urlsOf(s as IceEntry)).filter(u => /^turns?:/i.test(u));
}

// ════════════════════════════════════════════════════════════════════════════
// STUN
// ════════════════════════════════════════════════════════════════════════════
describe('STUN', () => {
  it('yapılandırma YOKKEN bile STUN döner', () => {
    const urls = urlsOf(getIceServers()[0] as IceEntry);
    expect(urls.every(u => u.startsWith('stun:'))).toBe(true);
    expect(urls.length).toBeGreaterThan(0);
  });

  it('STUN_URLS özelleştirilebilir; boşluk/boş girdi temizlenir', () => {
    process.env.STUN_URLS = ' stun:a.example:3478 ,  stun:b.example:3478\n stun:c.example:3478 ';
    expect(urlsOf(getIceServers()[0] as IceEntry))
      .toEqual(['stun:a.example:3478', 'stun:b.example:3478', 'stun:c.example:3478']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// coturn — HMAC kimlik bilgisi
// ════════════════════════════════════════════════════════════════════════════
describe('coturn time-limited credential', () => {
  it('coturn sözleşmesi: username = expiry:userId', () => {
    const before = Math.floor(Date.now() / 1000);
    const { username, ttl } = generateTimeLimitedCredential('user-42', 'gizli');
    const [expiry, uid] = username.split(':');
    expect(uid).toBe('user-42');
    expect(ttl).toBe(86400);
    // Son kullanma TAM 24 saat ileride olmali.
    expect(Number(expiry) - before).toBeGreaterThanOrEqual(86400);
    expect(Number(expiry) - before).toBeLessThanOrEqual(86402);
  });

  it('credential = base64(HMAC-SHA1(secret, username)) — coturn ile uyumlu', () => {
    const { username, credential } = generateTimeLimitedCredential('u1', 'gizli');
    const expected = crypto.createHmac('sha1', 'gizli').update(username).digest('base64');
    expect(credential).toBe(expected);
  });

  it('FARKLI secret FARKLI credential üretir', () => {
    const a = generateTimeLimitedCredential('u1', 'secret-a');
    const b = generateTimeLimitedCredential('u1', 'secret-b');
    expect(a.credential === b.credential).toBe(false);
  });

  it('kullanıcıya ÖZEL: iki kullanıcı aynı credential değerini paylaşmaz', () => {
    const a = generateTimeLimitedCredential('alice', 's');
    const b = generateTimeLimitedCredential('bob', 's');
    expect(a.credential === b.credential).toBe(false);
  });

  it('UDP + TCP + TLS taşımalarının üçü de sunulur', () => {
    process.env.TURN_SECRET = 's'; process.env.TURN_HOST = 'turn.example';
    const urls = turnUrls(getIceServers('u1'));
    expect({
      udp: urls.some(u => u === 'turn:turn.example:3478'),
      tcp: urls.some(u => u.includes('transport=tcp')),
      tls: urls.some(u => u.startsWith('turns:')),
    }).toEqual({ udp: true, tcp: true, tls: true });
  });

  it('TURN_TLS_443 kurumsal 443 girdisini EKLER', () => {
    process.env.TURN_SECRET = 's'; process.env.TURN_HOST = 'turn.example';
    const without = turnUrls(getIceServers('u1')).length;
    process.env.TURN_TLS_443 = 'true';
    const urls = turnUrls(getIceServers('u1'));
    expect(urls.length).toBeGreaterThan(without);
    expect(urls.some(u => u === 'turns:turn.example:443?transport=tcp')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KUSUR A — DURUM RAPORU YALANI (gerileme kilidi)
// ════════════════════════════════════════════════════════════════════════════
describe('getTurnStatus — çıktıyla ÇELİŞEMEZ', () => {
  it('YALNIZCA METERED_API_KEY: hazır DEMEZ ve uyarıyı BASTIRMAZ', () => {
    // Kusurun tam hali: eski kod burada turn:true/provider:metered/warning:null
    // donduruyordu ama getIceServers SIFIR turn yayiyordu.
    process.env.METERED_API_KEY = 'anahtar';
    const st = getTurnStatus();
    expect({ turn: st.turn, provider: st.provider, uyariVar: st.warning !== null })
      .toEqual({ turn: false, provider: 'none', uyariVar: true });
    expect(turnUrls(getIceServers('u1'))).toEqual([]);
  });

  it('METERED_API_KEY + APP_NAME ama kimlik bilgisi YOK → yine none', () => {
    process.env.METERED_API_KEY = 'anahtar';
    process.env.METERED_APP_NAME = 'uygulama';
    const st = getTurnStatus();
    expect({ turn: st.turn, provider: st.provider }).toEqual({ turn: false, provider: 'none' });
  });

  it('coturn yapılandırılınca provider coturn ve uyarı YOK', () => {
    process.env.TURN_SECRET = 's'; process.env.TURN_HOST = 'turn.example';
    const st = getTurnStatus();
    expect({ turn: st.turn, provider: st.provider, warning: st.warning })
      .toEqual({ turn: true, provider: 'coturn', warning: null });
  });

  it('durum raporu kimlik bilgisi SIZDIRMAZ', () => {
    // Durum raporu yalnizca dort alan dondurur; bir kullanicinin credential
    // degeri admin paneline dusmemeli.
    process.env.TURN_SECRET = 's'; process.env.TURN_HOST = 'turn.example';
    const st = getTurnStatus() as Record<string, unknown>;
    expect(Object.keys(st).sort()).toEqual(['provider', 'stun', 'turn', 'warning']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KUSUR B — ÖNCELİK TUZAĞI
// ════════════════════════════════════════════════════════════════════════════
describe('sağlayıcı önceliği', () => {
  it('yarım metered anahtar seti statik dalı ARTIK atlamıyor', () => {
    // Eskiden: metered anahtarlari dali SECIYOR, ic kontrol dusuyor, hicbir
    // sey push edilmiyor ve else-if yuzunden statik dal HIC denenmiyordu.
    // Metered kapisi artik TURN ucluesunu de istiyor, dolayisiyla yarim bir
    // metered yapilandirmasi akisi DOGAL OLARAK statik dala dusurur.
    process.env.METERED_API_KEY = 'anahtar';
    // METERED_APP_NAME kasitli olarak YOK → metered dali secilemez
    process.env.TURN_URL = 'turn:statik.example:3478';
    process.env.TURN_USERNAME = 'kullanici';
    process.env.TURN_CREDENTIAL = 'gizli';
    expect(turnUrls(getIceServers('u1'))).toEqual(['turn:statik.example:3478']);
    expect(getTurnStatus()).toMatchObject({ turn: true, provider: 'static', warning: null });
  });

  it('kimlik bilgisi EKSİKKEN hiçbir dal kimliksiz TURN yayınlamaz', () => {
    // Bir TURN sunucusu credential olmadan kullanilamaz. Eksik ucluede
    // "en azindan bir URL verelim" davranisi operatore CALISIYOR yalanini
    // soylerdi; kanonik davranis SIFIR turn + durum raporunda DURUST uyari.
    process.env.METERED_API_KEY = 'anahtar';
    process.env.METERED_APP_NAME = 'uygulama';
    process.env.TURN_URL = 'turn:statik.example:3478';
    process.env.TURN_USERNAME = 'kullanici';
    // TURN_CREDENTIAL kasitli olarak YOK
    expect(turnUrls(getIceServers('u1'))).toEqual([]);
    const st = getTurnStatus();
    expect(st.turn).toBe(false);
    expect(st.provider).toBe('none');
    expect(st.warning).toMatch(/TURN sunucu yapılandırılmamış/);
  });

  it('coturn, metered ve statiği EZER', () => {
    process.env.TURN_SECRET = 's'; process.env.TURN_HOST = 'coturn.example';
    process.env.TURN_URL = 'turn:statik.example:3478';
    process.env.TURN_USERNAME = 'k'; process.env.TURN_CREDENTIAL = 'c';
    const urls = turnUrls(getIceServers('u1'));
    expect(urls.every(u => u.includes('coturn.example'))).toBe(true);
  });

  it('tam metered yapılandırması ÇALIŞMAYA devam eder (gerileme yok)', () => {
    process.env.METERED_API_KEY = 'anahtar';
    process.env.METERED_APP_NAME = 'uygulama';
    process.env.TURN_URL = 'turn:metered.example:3478';
    process.env.TURN_USERNAME = 'k'; process.env.TURN_CREDENTIAL = 'c';
    const st = getTurnStatus();
    expect({ turn: st.turn, provider: st.provider }).toEqual({ turn: true, provider: 'metered' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DEĞİŞMEZ TARAMASI — durum ile çıktı HER kombinasyonda örtüşmeli
// ════════════════════════════════════════════════════════════════════════════
describe('DEĞİŞMEZ: status.turn === listede gerçek turn girdisi', () => {
  const FLAGS = ['TURN_SECRET+TURN_HOST', 'METERED_API_KEY', 'METERED_APP_NAME',
                 'TURN_URL', 'TURN_USERNAME', 'TURN_CREDENTIAL'];

  // 2^6 = 64 kombinasyon; her biri icin rapor ile gercek ciktiyi karsilastir.
  const combos: string[][] = [];
  for (let mask = 0; mask < (1 << FLAGS.length); mask++) {
    combos.push(FLAGS.filter((_, i) => mask & (1 << i)));
  }

  it(String(combos.length) + ' yapılandırma kombinasyonunun HEPSİ tutarlı', () => {
    const uyusmazlik: object[] = [];
    for (const on of combos) {
      for (const k of TURN_ENV) delete process.env[k];
      for (const flag of on) {
        if (flag === 'TURN_SECRET+TURN_HOST') {
          process.env.TURN_SECRET = 's'; process.env.TURN_HOST = 'turn.example';
        } else {
          process.env[flag] = flag === 'TURN_URL' ? 'turn:x.example:3478' : 'v';
        }
      }
      const st = getTurnStatus();
      const gercek = turnUrls(getIceServers('u1')).length > 0;
      if (st.turn !== gercek) uyusmazlik.push({ on, rapor: st.turn, gercek });
      // Uyari, turn YOKKEN mutlaka olmali; VARKEN mutlaka olmamali.
      if ((st.warning !== null) !== !gercek) uyusmazlik.push({ on, uyari: st.warning, gercek });
    }
    expect({ uyusmazlik }).toEqual({ uyusmazlik: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// transport policy
// ════════════════════════════════════════════════════════════════════════════
describe('getIceTransportPolicy', () => {
  it('varsayılan all', () => {
    expect(getIceTransportPolicy()).toBe('all');
  });
  it('FORCE_TURN=true → relay (dokümante ürün bayrağı)', () => {
    process.env.FORCE_TURN = 'true';
    expect(getIceTransportPolicy()).toBe('relay');
  });
  it('FORCE_RELAY=true → relay (relay-only teşhis modu)', () => {
    process.env.FORCE_RELAY = 'true';
    expect(getIceTransportPolicy()).toBe('relay');
  });
  it('FORCE_RELAY yalnızca tam true dizesinde etkin', () => {
    process.env.FORCE_RELAY = '1';
    expect(getIceTransportPolicy()).toBe('all');
  });
});


describe('getRtcIceConfig — canlı RTC yollarının tek kanonik ICE sözleşmesi', () => {
  it('FORCE_TURN istenir ama TURN yoksa medya black-hole olmaz', () => {
    process.env.FORCE_TURN = 'true';
    const cfg = getRtcIceConfig('u1');
    expect(cfg.iceTransportPolicy).toBe('all');
    expect(cfg.warning).toContain('FORCE_TURN');
  });

  it('self-hosted HMAC TURN varsa relay-only gerçekten etkinleşir', () => {
    process.env.FORCE_TURN = 'true';
    process.env.TURN_SECRET = 'shared';
    process.env.TURN_HOST = 'turn.example';
    const cfg = getRtcIceConfig('u1');
    expect(cfg.iceTransportPolicy).toBe('relay');
    expect(cfg.warning).toBeUndefined();
    expect(turnUrls(cfg.iceServers)).toEqual(expect.arrayContaining([
      'turn:turn.example:3478',
      'turn:turn.example:3478?transport=tcp',
      'turns:turn.example:5349',
    ]));
  });
});
