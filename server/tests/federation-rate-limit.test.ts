// server/tests/federation-rate-limit.test.ts
//
// FEDERASYON INBOX HIZ SINIRI — TIER-0 DAL KAPSAMI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA YAZILDI
// ════════════════════════════════════════════════════════════════════════════
// Kapsam ilk kez ölçülebildiğinde `middleware/federationRateLimit.ts` Tier-0
// içindeki EN ZAYIF modül çıktı: dalların yalnızca %50'si (12/24) çalışıyordu.
// ActivityPub inbox'ı kimliği doğrulanmamış UZAK sunuculara açık olduğu için
// bu, hasmane trafiğe bakan bir yüzeyde yarı kör bir koruma demekti.
//
// Bu dosya asıl karar dallarını kapsar: peer kimliğinin nasıl çıkarıldığı,
// Redis yokken ne olduğu ve üç limitin (global / burst / peer) hangi sırayla
// devreye girdiği.
//
// ── DÜRÜST SINIRLAMA: PEER KİMLİĞİ DOĞRULANMAMIŞTIR ───────────────────────
// `extractPeerHost` peer'i `Signature` başlığındaki `keyId`den okur ve bu
// başlık BU NOKTADA DOĞRULANMAMIŞTIR — imza denetimi daha sonra, inbox
// işleyicisinde yapılır. Sıralama bilinçlidir: her isteğe kriptografi
// uygulamak, hız sınırının kendisini bir CPU tüketim vektörüne çevirirdi.
//
// Sonucu açıkça yazmak gerekir: kötü niyetli bir peer `keyId` değerini
// döndürerek PEER BAŞINA limiti atlatabilir. Bunu tutan şey GLOBAL limittir
// ve o, peer kimliğine hiç bakmaz. Aşağıdaki testler hem atlatmayı hem de
// global limitin gerçekten arkada durduğunu belgeler.

process.env.NODE_ENV = 'test';

// ── Redis sahtesi — sayaçlar bellekte tutulur ────────────────────────────
let redisUp = true;
let clientNull = false;
let throwOnExec = false;
const zsets = new Map<string, number>();

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => redisUp,
  cache: {
    slidingWindowCount: async (key: string) => {
      if (throwOnExec) throw new Error('redis down');
      if (clientNull) return null;
      const count = (zsets.get(key) ?? 0) + 1;
      zsets.set(key, count);
      return count;
    },
  },
}));

import {
  federationGlobalRateLimit,
  federationInboxRateLimit,
  _resetFederationRateLimitFallbackForTest,
} from '../middleware/federationRateLimit';

interface Res {
  statusCode: number;
  headers: Record<string, unknown>;
  body: unknown;
  setHeader(k: string, v: unknown): void;
  status(c: number): Res;
  json(b: unknown): Res;
}

function makeRes(): Res {
  const res: Res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  return res;
}

function makeReq(over: Record<string, unknown> = {}) {
  return { headers: {}, body: {}, ip: '203.0.113.9', ...over } as never;
}

beforeEach(() => {
  redisUp = true;
  clientNull = false;
  throwOnExec = false;
  zsets.clear();
  _resetFederationRateLimitFallbackForTest();
});

// ════════════════════════════════════════════════════════════════════════════
// PEER KIMLIGI CIKARIMI — en cok dallanan bolum
// ════════════════════════════════════════════════════════════════════════════
describe('peer kimliği çıkarımı', () => {
  /** Peer anahtarini, olusan Redis anahtarindan geri okur. */
  async function peerOf(req: unknown): Promise<string> {
    zsets.clear();
    await federationInboxRateLimit(req as never, makeRes() as never, () => {});
    const k = [...zsets.keys()].find(x => x.startsWith('ap:inbox:burst:'));
    return k ? k.replace('ap:inbox:burst:', '') : '';
  }

  it('Signature keyId varsa HOST oradan alınır', async () => {
    const req = makeReq({
      headers: { signature: 'keyId="https://mastodon.example/users/a#main-key",sig="x"' },
    });
    expect(await peerOf(req)).toBe('mastodon.example');
  });

  it('keyId GEÇERSİZ URL ise actor’a düşülür', async () => {
    // `new URL()` firlatir; sessizce yutulup bir sonraki kaynaga gecilmeli.
    const req = makeReq({
      headers: { signature: 'keyId="not-a-url",sig="x"' },
      body: { actor: 'https://actor.example/users/b' },
    });
    expect(await peerOf(req)).toBe('actor.example');
  });

  it('Signature var ama keyId YOKSA actor’a düşülür', async () => {
    const req = makeReq({
      headers: { signature: 'algorithm="rsa-sha256",sig="x"' },
      body: { actor: 'https://actor2.example/users/c' },
    });
    expect(await peerOf(req)).toBe('actor2.example');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // BU TEST DEGISTIRILDI — eskiden ACIGI bekleniyordu
  // ══════════════════════════════════════════════════════════════════════════
  // Eski hali `x-forwarded-for: '198.51.100.7, 10.0.0.1'` icin ILK hop'un
  // (198.51.100.7) alinmasini bekliyordu ve yorumu "Ilk giris alinir" idi.
  // Ama ilk hop TAMAMEN ISTEMCI TARAFINDAN YAZILIR: proxy gercek IP'yi SONA
  // ekler. Yani test, uzak bir esin sahte bir XFF ile hiz sinirini
  // atlamasini BEKLENEN DAVRANIS olarak kodluyordu.
  //
  // Artik kanonik cozumleyici kullaniliyor (lib/clientIp.ts) ve guven modeli
  // her iki yonde de test ediliyor.
  describe('actor geçersizken IP’ye düşüş — güven modeli', () => {
    let saved: string | undefined;
    beforeEach(() => { saved = process.env.TRUSTED_PROXY_COUNT; });
    afterEach(() => {
      if (saved === undefined) delete process.env.TRUSTED_PROXY_COUNT;
      else process.env.TRUSTED_PROXY_COUNT = saved;
    });

    it('proxy GÜVENİLMİYORSA (varsayılan) XFF yok sayılır', async () => {
      delete process.env.TRUSTED_PROXY_COUNT;
      const req = makeReq({
        body: { actor: 'garbage' },
        headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      });
      // Saldirganin uydurdugu deger KULLANILMAZ; soket adresine dusulur.
      expect(await peerOf(req)).toBe('203.0.113.9');
    });

    it('proxy GÜVENİLİYORSA proxy’nin eklediği GERÇEK hop kullanılır', async () => {
      process.env.TRUSTED_PROXY_COUNT = '1';
      const req = makeReq({
        body: { actor: 'garbage' },
        headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
      });
      // '10.0.0.1' proxy tarafindan eklenen gercek istemcidir.
      expect(await peerOf(req)).toBe('10.0.0.1');
    });
  });

  it('hiçbir ipucu yoksa req.ip kullanılır', async () => {
    expect(await peerOf(makeReq())).toBe('203.0.113.9');
  });

  it('req.ip de yoksa "unknown" olur', async () => {
    expect(await peerOf(makeReq({ ip: undefined }))).toBe('unknown');
  });

  // ── DURUSTLUK TESTI: kimlik DOGRULANMAMISTIR ───────────────────────────
  it('SINIRLAMA: sahte keyId ile peer kimliği DEĞİŞTİRİLEBİLİR', async () => {
    // Bu bir kusur RAPORU degil, bilincli tasarimin BELGESIDIR: imza bu
    // noktada henuz dogrulanmamistir (kriptografiyi hiz sinirindan ONCE
    // yapmak, sinirin kendisini CPU tuketim vektoru yapardi).
    //
    // Sonuc: kotu niyetli bir peer keyId'yi dondurerek PEER BASINA limiti
    // atlatabilir. Bunu tutan sey GLOBAL limittir (asagidaki test).
    const a = await peerOf(makeReq({
      headers: { signature: 'keyId="https://spoof-1.example/k#main",sig="x"' },
    }));
    const b = await peerOf(makeReq({
      headers: { signature: 'keyId="https://spoof-2.example/k#main",sig="x"' },
    }));
    expect({ differentKeys: a !== b }).toEqual({ differentKeys: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// REDIS YOKKEN — PROCESS-LOCAL FAIL-SAFE KOTA
// ════════════════════════════════════════════════════════════════════════════
describe('Redis erişilemediğinde', () => {
  async function exhaustLocalGlobal(): Promise<Res> {
    redisUp = false;
    let last = makeRes();
    for (let i = 0; i <= 500; i++) {
      last = makeRes();
      await federationGlobalRateLimit(makeReq(), last as never, () => {});
    }
    return last;
  }

  it('Redis KAPALIYSA sınırsız fail-open olmak yerine local kota 429 üretir', async () => {
    const res = await exhaustLocalGlobal();
    expect(res.statusCode).toBe(429);
  });

  it('shared cache null dönerse local quota uygulanır', async () => {
    clientNull = true;
    let res = makeRes();
    for (let i = 0; i <= 500; i++) {
      res = makeRes();
      await federationGlobalRateLimit(makeReq(), res as never, () => {});
    }
    expect(res.statusCode).toBe(429);
  });

  it('Redis HATA fırlatırsa hata loglanır ve local quota koruması devam eder', async () => {
    throwOnExec = true;
    let res = makeRes();
    for (let i = 0; i <= 500; i++) {
      res = makeRes();
      await federationGlobalRateLimit(makeReq(), res as never, () => {});
    }
    expect(res.statusCode).toBe(429);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// LIMITLERIN SIRASI VE DEVREYE GIRMESI
// ════════════════════════════════════════════════════════════════════════════
describe('limit uygulaması', () => {
  it('GLOBAL limit aşılınca 429 ve Retry-After döner', async () => {
    zsets.set('ap:inbox:global', 100000);           // esigin cok ustu
    const res = makeRes();
    let passed = false;
    await federationGlobalRateLimit(makeReq(), res as never, () => { passed = true; });
    expect({ passed, status: res.statusCode }).toEqual({ passed: false, status: 429 });
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('GLOBAL limit peer kimliğine BAKMAZ — sahte keyId onu kurtarmaz', async () => {
    // Peer basina limitin atlatilabildigi yerde gercek arka durak budur.
    zsets.set('ap:inbox:global', 100000);
    const res = makeRes();
    let passed = false;
    await federationGlobalRateLimit(
      makeReq({ headers: { signature: 'keyId="https://spoof-9.example/k#m",sig="x"' } }),
      res as never, () => { passed = true; },
    );
    expect({ passed, status: res.statusCode }).toEqual({ passed: false, status: 429 });
  });

  it('BURST limiti peer pencere limitinden ÖNCE devreye girer', async () => {
    // Sira onemlidir: ani patlama, dakikalik kota dolmadan durdurulmalidir.
    const peer = 'burst.example';
    zsets.set(`ap:inbox:burst:${peer}`, 100000);
    const res = makeRes();
    let passed = false;
    await federationInboxRateLimit(
      makeReq({ headers: { signature: `keyId="https://${peer}/k#m",sig="x"` } }),
      res as never, () => { passed = true; },
    );
    expect({ passed, status: res.statusCode }).toEqual({ passed: false, status: 429 });
    expect((res.body as { error: string }).error).toBe('Burst limit exceeded');
  });

  it('PEER pencere limiti aşılınca 429 döner', async () => {
    const peer = 'slow.example';
    zsets.set(`ap:inbox:peer:${peer}`, 100000);      // burst temiz, pencere dolu
    const res = makeRes();
    let passed = false;
    await federationInboxRateLimit(
      makeReq({ headers: { signature: `keyId="https://${peer}/k#m",sig="x"` } }),
      res as never, () => { passed = true; },
    );
    expect({ passed, status: res.statusCode }).toEqual({ passed: false, status: 429 });
    expect((res.body as { error: string }).error).toBe('Peer rate limit exceeded');
  });

  it('POZİTİF KONTROL: normal trafik GEÇER ve sayaç başlıkları yazılır', async () => {
    // Asiri sert bir yama da testleri gecerdi; mesru trafigin gectigi
    // ayrica kanitlanir.
    const res = makeRes();
    let passed = false;
    await federationInboxRateLimit(
      makeReq({ headers: { signature: 'keyId="https://ok.example/k#m",sig="x"' } }),
      res as never, () => { passed = true; },
    );
    expect({ passed, status: res.statusCode }).toEqual({ passed: true, status: 200 });
    expect(res.headers['X-AP-Peer-RateLimit-Limit']).toBeDefined();
    expect(res.headers['X-AP-Peer-RateLimit-Remaining']).toBeDefined();
  });

  it('farklı peer’lar BİRBİRİNİ etkilemez', async () => {
    // Yan hasar kontrolu: bir peer kotasini doldurdugunda digeri gecmeli.
    zsets.set('ap:inbox:peer:noisy.example', 100000);
    const res = makeRes();
    let passed = false;
    await federationInboxRateLimit(
      makeReq({ headers: { signature: 'keyId="https://quiet.example/k#m",sig="x"' } }),
      res as never, () => { passed = true; },
    );
    expect({ passed, status: res.statusCode }).toEqual({ passed: true, status: 200 });
  });
});
