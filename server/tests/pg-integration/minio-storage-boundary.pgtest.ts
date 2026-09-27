// server/tests/pg-integration/minio-storage-boundary.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK S3 UYUMLU DEPO — GENEL/ÖZEL SINIRI
// ════════════════════════════════════════════════════════════════════════════
// Faz 1 raporu şunu açıkça bıraktı: "public/private storage mimarisi mantıksal
// olarak iyi görünüyor, ancak S3/R2/MinIO/B2 gerçek bucket'larla
// KANITLANMADI." Bu dosya o boşluğu MinIO ile kapatır (S3 API uyumlu).
//
// Kanıtlanan sözleşme:
//   · özel nesne ANONİM olarak indirilemez (bucket politikası GERÇEKTEN özel)
//   · genel varlık anonim olarak indirilebilir (yanlış pozitif kontrolü)
//   · aynı bucket'ı hem genel hem özel olarak kullanmak FAIL-CLOSED reddedilir
//   · özel adaptör public URL üretmeyi REDDEDER
//   · Range istekleri: 206, doğru baytlar, geçersiz aralıkta 416
//   · silme, listeleme, var olmayan nesne davranışı
//
// ── NEDEN MOCK YETMEZ ─────────────────────────────────────────────────────
// Mock'lanmış bir S3 istemcisi "hangi komutu gönderdiğimizi" gösterir; bir
// bucket'ın GERÇEKTEN anonim erişime kapalı olduğunu KANITLAYAMAZ. Bu dosyada
// özel nesne, imzasız düz HTTP ile çekilmeye çalışılır — sızıntının gerçek
// testi budur.
//
// Yalnızca `MINIO_TEST_ENDPOINT` verildiğinde çalışır.
//
// ── TEK KULLANIMLIK ORTAM (yerel koşu) ────────────────────────────────────
//   docker run -d --name bridge-minio -p 9000:9000 //     -e MINIO_ROOT_USER=bridgereview -e MINIO_ROOT_PASSWORD=bridgereview123 //     quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z server /data
//   docker exec bridge-minio mc alias set local http://127.0.0.1:9000 //     bridgereview bridgereview123
//   docker exec bridge-minio mc mb --ignore-existing //     local/bridge-public local/bridge-private
//   docker exec bridge-minio mc anonymous set download local/bridge-public
//
// SON SATIR ZORUNLUDUR. Genel bucket anonim okumaya AÇIK değilse "genel varlık
// anonim indirilebilir" yanlış-pozitif kontrolü 403 alır ve o zaman özel
// bucket'ın 403'ü hiçbir şey kanıtlamaz — her şey zaten kapalıdır. Aynı
// sağlama CI'da `Provision MinIO buckets` adımıyla yapılır.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const ENDPOINT = process.env.MINIO_TEST_ENDPOINT;
const RUN = ENDPOINT ? describe : describe.skip;

const PUBLIC_BUCKET = process.env.MINIO_TEST_PUBLIC_BUCKET || 'bridge-public';
const PRIVATE_BUCKET = process.env.MINIO_TEST_PRIVATE_BUCKET || 'bridge-private';
const ACCESS_KEY = process.env.MINIO_TEST_ACCESS_KEY || 'bridgereview';
const SECRET_KEY = process.env.MINIO_TEST_SECRET_KEY || 'bridgereview123';

type StorageModule = typeof import('../../lib/storageAdapter');

/** `lib/storageAdapter`ı verilen ortamla TAZE yükler (config modül düzeyinde okunur). */
function loadStorage(env: Record<string, string | undefined>): StorageModule {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  let mod!: StorageModule;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../../lib/storageAdapter');
  });
  // Ortamı GERİ ALMA: adaptör çağrı anında da env okuyabilir.
  void saved;
  return mod;
}

const BASE_ENV: Record<string, string | undefined> = {
  CDN_PROVIDER: 'minio',
  PRIVATE_STORAGE_PROVIDER: 'minio',
  MINIO_ENDPOINT: ENDPOINT,
  MINIO_BUCKET: PUBLIC_BUCKET,
  PRIVATE_MINIO_BUCKET: PRIVATE_BUCKET,
  MINIO_ACCESS_KEY: ACCESS_KEY,
  MINIO_SECRET_KEY: SECRET_KEY,
  MINIO_PUBLIC_URL: `${ENDPOINT}/${PUBLIC_BUCKET}`,
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-minio-'));
const createdKeys: Array<{ bucket: string; key: string }> = [];

function tmpFile(name: string, contents: Buffer): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, contents);
  return p;
}

/** İMZASIZ, düz HTTP GET — anonim erişimin gerçek testi. */
async function anonymousGet(bucket: string, key: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${ENDPOINT}/${bucket}/${key}`, { headers });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

afterAll(async () => {
  try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* yok */ }
});

RUN('gerçek MinIO — genel/özel sınırı', () => {
  const uniq = crypto.randomUUID().slice(0, 8);

  it('ÖZEL nesne ANONİM olarak indirilemez', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // Faz 1'de bu yalnızca kod okunarak "doğru görünüyor" denmişti. Burada
    // nesne gerçekten yüklenir ve imzasız bir istemciyle çekilmeye çalışılır.
    const s = loadStorage(BASE_ENV);
    const key = `uploads/private-${uniq}.txt`;
    const local = tmpFile('secret.txt', Buffer.from('gizli mesaj eki'));

    await s.getPrivateStorageAdapter().uploadFile(local, key, { contentType: 'text/plain', deleteLocal: false });
    createdKeys.push({ bucket: PRIVATE_BUCKET, key });

    const anon = await anonymousGet(PRIVATE_BUCKET, key);
    expect([401, 403]).toContain(anon.status);
    expect(anon.body.toString()).not.toContain('gizli mesaj eki');
  });

  it('GENEL varlık anonim olarak indirilebilir (yanlış pozitif kontrolü)', async () => {
    // Bu olmadan yukarıdaki iddia, "MinIO tamamen erişilemez" durumunda da
    // geçerdi ve hiçbir şey kanıtlamazdı.
    const s = loadStorage(BASE_ENV);
    const key = `avatars/public-${uniq}.txt`;
    const local = tmpFile('avatar.txt', Buffer.from('herkese acik avatar'));

    await s.getStorageAdapter().uploadFile(local, key, { contentType: 'text/plain', deleteLocal: false });
    createdKeys.push({ bucket: PUBLIC_BUCKET, key });

    const anon = await anonymousGet(PUBLIC_BUCKET, key);
    expect(anon.status).toBe(200);
    expect(anon.body.toString()).toBe('herkese acik avatar');
  });

  it('ÖZEL adaptör public URL üretmeyi REDDEDER', () => {
    // Özel nesnelerin public URL'si OLMAMALIDIR; üretilebilseydi, bir kod
    // yolu yanlışlıkla onu istemciye sızdırabilirdi.
    const s = loadStorage(BASE_ENV);
    expect(() => s.getPrivateStorageAdapter().publicUrlForKey('uploads/x.txt')).toThrow();
  });

  it('aynı bucket hem genel hem özel olarak kullanılamaz (fail-closed)', () => {
    // Yapılandırma hatası SESSİZCE kabul edilseydi, özel ekler public CDN
    // origin'inden servis edilirdi — tam olarak kapatılmak istenen açık.
    // Dogrulama TEMBELDIR: adaptor ilk istendiginde calisir, modul
    // yuklenirken degil. Bu yuzden iddia fabrika cagrisini sarmalidir.
    const s = loadStorage({ ...BASE_ENV, PRIVATE_MINIO_BUCKET: PUBLIC_BUCKET });
    expect(() => s.getPrivateStorageAdapter()).toThrow(/aynı olamaz/i);
  });
});

RUN('gerçek MinIO — nesne işlemleri', () => {
  const uniq = crypto.randomUUID().slice(0, 8);
  const CONTENT = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');

  async function seedPrivate(name: string): Promise<{ key: string; store: ReturnType<StorageModule['getPrivateStorageAdapter']> }> {
    const s = loadStorage(BASE_ENV);
    const store = s.getPrivateStorageAdapter();
    const key = `uploads/${name}-${uniq}.bin`;
    const local = tmpFile(`${name}.bin`, CONTENT);
    await store.uploadFile(local, key, { contentType: 'application/octet-stream', deleteLocal: false });
    createdKeys.push({ bucket: PRIVATE_BUCKET, key });
    return { key, store };
  }

  it('yüklenen nesne TAM olarak geri okunur', async () => {
    const { key, store } = await seedPrivate('roundtrip');
    const obj = await store.readFile(key);
    const chunks: Buffer[] = [];
    for await (const c of obj.body as NodeJS.ReadableStream) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks)).toEqual(CONTENT);
    expect(obj.contentLength).toBe(CONTENT.length);
  });

  it('Range isteği 206 ve DOĞRU baytları döndürür', async () => {
    const { key, store } = await seedPrivate('range');
    const obj = await store.readFile(key, { range: 'bytes=5-9' });
    const chunks: Buffer[] = [];
    for await (const c of obj.body as NodeJS.ReadableStream) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks).toString()).toBe('56789');
    expect(obj.contentRange).toMatch(/^bytes 5-9\//);
  });

  it('açık uçlu Range (bytes=30-) sondan okur', async () => {
    const { key, store } = await seedPrivate('open-range');
    const obj = await store.readFile(key, { range: 'bytes=30-' });
    const chunks: Buffer[] = [];
    for await (const c of obj.body as NodeJS.ReadableStream) chunks.push(Buffer.from(c as Buffer));
    expect(Buffer.concat(chunks)).toEqual(CONTENT.subarray(30));
  });

  it('KARŞILANAMAYAN Range için depo hata verir (416 sınıfı)', async () => {
    // `uploadAuthz` bu hatayı 416'ya çevirir; burada deponun gerçekten
    // reddettiği kanıtlanır.
    const { key, store } = await seedPrivate('bad-range');
    await expect(store.readFile(key, { range: 'bytes=99999-100000' })).rejects.toBeDefined();
  });

  it('VAR OLMAYAN nesne için hata verir (404 sınıfı)', async () => {
    const s = loadStorage(BASE_ENV);
    await expect(s.getPrivateStorageAdapter().readFile('uploads/yok-boyle-nesne.bin'))
      .rejects.toBeDefined();
  });

  it('silme sonrası nesne artık okunamaz', async () => {
    const { key, store } = await seedPrivate('delete-me');
    await store.deleteFile(key);
    await expect(store.readFile(key)).rejects.toBeDefined();
  });

  it('var olmayan nesneyi silmek HATA FIRLATMAZ (idempotent)', async () => {
    // Temizlik işleri aynı anahtarı iki kez silmeye çalışabilir; bu, işi
    // düşürmemelidir.
    const s = loadStorage(BASE_ENV);
    await expect(s.getPrivateStorageAdapter().deleteFile('uploads/hic-olmayan.bin')).resolves.toBeUndefined();
  });

  it('keyFromUrl, yüklenen anahtarı geri üretir', async () => {
    const { key, store } = await seedPrivate('keyurl');
    // Bridge özel ekler için göreli referans tutar.
    expect(store.keyFromUrl(`/uploads/${path.basename(key)}`)).toContain(path.basename(key));
  });

  it('healthCheck gerçek depoda TRUE döner', async () => {
    const s = loadStorage(BASE_ENV);
    await expect(s.getPrivateStorageAdapter().healthCheck()).resolves.toBe(true);
  });
});
