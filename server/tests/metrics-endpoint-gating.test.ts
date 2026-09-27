// server/tests/metrics-endpoint-gating.test.ts
//
// /metrics — ÜRETİMDE KAPALI-DEVRE (FAIL-CLOSED) KAPISI
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// `/metrics` Prometheus çıktısı verir: istek sayıları, hata oranları, WS
// bağlantı sayısı, rate-limit isabetleri, otomatik ban sayaçları. Bir
// saldırgan için bu KEŞİF değeri taşır — hangi uçların var olduğu, ne kadar
// yük olduğu, korumaların ne zaman tetiklendiği.
//
// Uç nokta DOĞRU tasarlanmış (üretimde METRICS_SECRET yoksa 503, varsa Bearer
// zorunlu) ama bu programa kadar ADANMIŞ TESTİ YOKTU. Yani kapı bir
// yeniden düzenlemede sessizce açılabilirdi ve hiçbir test bunu yakalamazdı.
//
// ── AYRICA DÜZELTİLEN ───────────────────────────────────────────────────────
// Sır karşılaştırması `auth !== ` + backtick şablonu ile yapılıyordu. JS dize
// karşılaştırması İLK FARKLI BAYTTA kısa devre yapar; bu, sırrın zamanlama
// ölçümüyle bayt bayt tahmin edilmesine kapı aralar. `crypto.timingSafeEqual`
// tabanlı sabit zamanlı karşılaştırmaya geçildi.

import express from 'express';
import request from 'supertest';
import { metricsEndpoint } from '../middleware/metrics';

function app() {
  const a = express();
  a.get('/metrics', metricsEndpoint);
  return a;
}

const SECRET = 'cok-gizli-metrik-sirri';
let savedEnv: string | undefined;
let savedSecret: string | undefined;

beforeEach(() => {
  savedEnv = process.env.NODE_ENV;
  savedSecret = process.env.METRICS_SECRET;
  delete process.env.METRICS_SECRET;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = savedEnv;
  if (savedSecret === undefined) delete process.env.METRICS_SECRET;
  else process.env.METRICS_SECRET = savedSecret;
});

function setEnv(v: string) {
  // DUZ ATAMA sart. Ilk denemede Object.defineProperty(process.env, ...)
  // kullanilmisti: bu, process.env'in Node tarafindaki ozel erisimcisini
  // GOLGELEYEN duz bir veri ozelligi tanimliyor ve modul icindeki
  // process.env.NODE_ENV okumasi ESKI degeri gormeye devam ediyordu.
  //
  // Sonuc: uretim kapisi ASLINDA CALISIRKEN test onu "fail-open" sandi.
  // Yani kusur URUNDE DEGIL, TESTTEYDI. Dogrudan atama ile 503 doner.
  // Bu not bilerek birakildi: ayni tuzaga baska bir env testi de dusebilir.
  process.env.NODE_ENV = v;
}

// ════════════════════════════════════════════════════════════════════════════
// ÜRETİM — KAPALI DEVRE
// ════════════════════════════════════════════════════════════════════════════
describe('üretim ortamı', () => {
  it('METRICS_SECRET YOKSA uç nokta TAMAMEN KAPALI (503)', async () => {
    // EN ONEMLI TEST: yapilandirilmamis bir uretim kurulumu metrikleri
    // HERKESE ACMAMALI. Fail-open olsaydi kesif verisi sizardi.
    setEnv('production');
    const r = await request(app()).get('/metrics');
    expect({ status: r.status }).toEqual({ status: 503 });
  });

  it('kapalıyken GÖVDEDE metrik verisi SIZMAZ', async () => {
    setEnv('production');
    const r = await request(app()).get('/metrics');
    expect(String(r.text || '')).not.toContain('bridge_');
  });

  it('sır VARKEN kimliksiz istek 401', async () => {
    setEnv('production');
    process.env.METRICS_SECRET = SECRET;
    const r = await request(app()).get('/metrics');
    expect({ status: r.status }).toEqual({ status: 401 });
  });

  it('YANLIŞ sır 401', async () => {
    setEnv('production');
    process.env.METRICS_SECRET = SECRET;
    const r = await request(app()).get('/metrics').set('Authorization', 'Bearer yanlis');
    expect({ status: r.status }).toEqual({ status: 401 });
  });

  it('AYNI UZUNLUKTA yanlış sır da 401 (kısmi eşleşme yetmez)', async () => {
    // Sabit zamanli karsilastirmanin dogruluk kontrolu: ayni uzunlukta ama
    // farkli bir dize KABUL EDILMEMELI.
    setEnv('production');
    process.env.METRICS_SECRET = SECRET;
    const ayniUzunluk = 'X'.repeat(SECRET.length);
    const r = await request(app()).get('/metrics').set('Authorization', 'Bearer ' + ayniUzunluk);
    expect({ status: r.status }).toEqual({ status: 401 });
  });

  it('ÖNEKİ paylaşan yanlış sır 401', async () => {
    setEnv('production');
    process.env.METRICS_SECRET = SECRET;
    const r = await request(app()).get('/metrics')
      .set('Authorization', 'Bearer ' + SECRET.slice(0, -1) + 'X');
    expect({ status: r.status }).toEqual({ status: 401 });
  });

  it('"Bearer" önekі olmadan çıplak sır 401', async () => {
    setEnv('production');
    process.env.METRICS_SECRET = SECRET;
    const r = await request(app()).get('/metrics').set('Authorization', SECRET);
    expect({ status: r.status }).toEqual({ status: 401 });
  });

});

// ════════════════════════════════════════════════════════════════════════════
// GELİŞTİRME — belgelenen davranış
// ════════════════════════════════════════════════════════════════════════════
// Bu blok NODE_ENV'i DEGISTIRMEZ; Jest'in kendi 'test' ortaminda kosar.
// 'test' de uretim DISI bir ortamdir, yani urun kodunda tam olarak ayni dal
// calisir (`NODE_ENV === 'production'` yanlis).
//
// NEDEN 'development' ATANMIYOR: basari yolu `tryRequire('socket/index')`
// cagirir, o da `db/loader` zincirini yukler. 'test' DISINDAKI her ortamda
// db/loader gercek bir veritabani yapilandirmasi bulamayinca
// `process.exit(1)` cagirip TEST KOSUCUSUNU OLDURUYOR. Bu bir urun kusuru
// degil, uretim/gelistirme yapilandirmasinin zorunlulugudur.
describe('üretim DIŞI ortam', () => {
  it('sır yokken AÇIK kalır (bilinçli kolaylık)', async () => {
    // Bu KASITLI: yerel calistirmada metrik bakmak icin sir gerekmez.
    // Uretimde ayni yolun KAPALI oldugunu yukaridaki testler kilitliyor.
    const r = await request(app()).get('/metrics');
    expect({ status: r.status }).toEqual({ status: 200 });
  });

  it('üretim dışında da sır TANIMLIYSA zorunlu olur', async () => {
    // Sir tanimlanmissa ortam ne olursa olsun dogrulanir.
    process.env.METRICS_SECRET = SECRET;
    const r = await request(app()).get('/metrics');
    expect({ status: r.status }).toEqual({ status: 401 });
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  // Bu olmadan yukarıdaki bütün 401/503'ler, uç nokta HER İSTEĞE hata
  // döndüren bozuk bir durumda da yeşil kalırdı.
  //
  // Yetki mantığı ortamdan BAĞIMSIZDIR: sır tanımlıysa her ortamda doğrulanır
  // (bir üstteki test bunu kanıtlıyor), bu yüzden pozitif kontrol burada da
  // tam olarak aynı kod yolunu kanıtlar.
  it('DOĞRU sır ile 200 ve GERÇEK metrik gövdesi döner', async () => {
    process.env.METRICS_SECRET = SECRET;
    const r = await request(app()).get('/metrics').set('Authorization', `Bearer ${SECRET}`);
    expect({ status: r.status }).toEqual({ status: 200 });
    expect(String(r.text)).toContain('bridge_');
  });
});
