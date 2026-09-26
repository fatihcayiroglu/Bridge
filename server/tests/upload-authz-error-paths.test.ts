// server/tests/upload-authz-error-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// middleware/uploadAuthz.ts — HATA, DEPOLAMA VE BAŞLIK DALLARI
// ════════════════════════════════════════════════════════════════════════════
// `tests/upload-authz.test.ts` yetkilendirme KARARINI ölçer (kim erişebilir).
// Bu dosya kalan dalları ölçer: bozuk yol, DM sahiplik çözümlemesi, uzak
// depolama arıza sınıfları ve korumalı baytlara basılan GÜVENLİK BAŞLIKLARI.
import type { Request, Response, NextFunction } from 'express';
//
// Neden bu dallar önemli: yetkilendirme geçtikten SONRA yanlış bir başlık
// kararı, yetkilendirmenin kendisini geçersiz kılabilir —
//   · `Cache-Control` özel değilse bir ara önbellek (proxy/CDN) korumalı bir
//     eki herkese açık nesne olarak saklayabilir;
//   · SVG bir eke CSP/`Content-Disposition` uygulanmazsa yüklenen dosya
//     kullanıcının oturumunda script çalıştırabilir (depolanmış XSS).
//
// Ayrıca uzak depolama hataları BİRBİRİNDEN AYRILMALIDIR: "yok" (404),
// "aralık karşılanamaz" (416) ve "geçici arıza" (503). Hepsinin 403'e
// düşmesi, var olmayan bir dosyayı "yetkiniz yok" gibi göstererek hata
// ayıklamayı imkânsız hâle getirirdi.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

const mockQuery = jest.fn();
jest.mock('../db/postgres/pool', () => ({ pool: { query: async (...a: unknown[]) => mockQuery(...a) } }));

const mockTokenVersion = jest.fn();
jest.mock('./..\/middleware/auth', () => ({
  ...jest.requireActual('../middleware/auth'),
  getTokenVersion: (...a: unknown[]) => mockTokenVersion(...a),
}));

const mockCanView = jest.fn();
jest.mock('../lib/permissions', () => ({
  ...jest.requireActual('../lib/permissions'),
  canViewChannel: (...a: unknown[]) => mockCanView(...a),
}));

let mockPrivateProvider = 'local';
const mockStorageReadFile = jest.fn();
jest.mock('../lib/storageAdapter', () => ({
  ...jest.requireActual('../lib/storageAdapter'),
  getPrivateStorageProvider: () => mockPrivateProvider,
  getPrivateStorageAdapter: () => ({ readFile: (...a: unknown[]) => mockStorageReadFile(...a) }),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import { uploadAuthz } from '../middleware/uploadAuthz';

const tok = (id: string, v = 0) => jwt.sign({ id, username: id, v }, 'test-jwt-secret-long-enough-32chars!!', { expiresIn: '1h' });

function app() {
  const a = express();
  a.use(cookieParser());
  a.use('/uploads', uploadAuthz());
  a.use('/uploads', (_req: Request, res: Response) => res.status(200).send('BAYTLAR'));
  return a;
}

/** Hiçbir mesaj referansı yok; `uploads` tablosu dosyayı `sahip`e bağlar. */
function ownerIsUploader(uploaderId: string | null) {
  mockQuery.mockReset();
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM uploads')) {
      return { rows: uploaderId ? [{ userId: uploaderId }] : [], rowCount: uploaderId ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrivateProvider = 'local';
  mockTokenVersion.mockResolvedValue(0);
  mockCanView.mockResolvedValue(false);
});

// ════════════════════════════════════════════════════════════════════════════
describe('yol ayrıştırma', () => {
  it('BOZUK yüzde kodlaması 400 döner, 500 değil', async () => {
    // `decodeURIComponent('%E0%A4%A')` fırlatır. Yakalanmasaydı istek
    // yığın izi ile 500 dönerdi.
    ownerIsUploader(null);
    const r = await request(app()).get('/uploads/%E0%A4%A').set('Authorization', `Bearer ${tok('u1')}`);
    expect(r.status).toBe(400);
  });

  it('ALT DİZİN varlıkları guard’a takılmaz (herkese açık)', async () => {
    const r = await request(app()).get('/uploads/avatars/ayse.png');
    expect(r.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    'avatar_0f8fad5b-d9cb-469f-a165-70867728950e.png',
    'banner_0f8fad5b-d9cb-469f-a165-70867728950e.webp',
  ])('KÖKTEKİ eski %s dosyası herkese açıktır (geriye dönük uyumluluk)', async (name) => {
    // Muafiyet zorlanamaz: mesaj ekleri `${uuidv4()}${ext}` olarak adlandırılır
    // ve bir UUID asla `avatar_`/`banner_` ile BAŞLAYAMAZ.
    const r = await request(app()).get(`/uploads/${name}`);
    expect(r.status).toBe(200);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it.each([
    'avatar_not-a-uuid.png',
    'avatar_0f8fad5b-d9cb-469f-a165-70867728950e.png.txt',
    '0f8fad5b-d9cb-469f-a165-70867728950e.png',
  ])('muafiyete BENZEYEN ama uymayan %s korunmaya devam eder', async (name) => {
    ownerIsUploader('sahibi');
    const r = await request(app()).get(`/uploads/${name}`);
    expect(r.status).toBe(401);           // kimlik istendi → guard uygulandı
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DM sahipliği — participants biçimleri', () => {
  function ownerIsDm(participants: unknown) {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM dm_messages')) return { rows: [{ dmId: 'dm1' }], rowCount: 1 };
      if (sql.includes('FROM dm_conversations')) return { rows: [{ participants }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
  }

  it('DİZİ participants ile katılımcı erişir', async () => {
    ownerIsDm(['ayse', 'burak']);
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(200);
  });

  it('JSON METİN participants de çözülür (legacy sütun biçimi)', async () => {
    // Sütun `text` olarak saklandığında bu dal çalışır; çözülmezse meşru
    // katılımcı kendi DM ekini göremezdi.
    ownerIsDm('["ayse","burak"]');
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(200);
  });

  it('KATILIMCI OLMAYAN reddedilir', async () => {
    ownerIsDm(['ayse', 'burak']);
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('cem')}`);
    expect(r.status).toBe(403);
  });

  it('participants NULL ise fail-closed', async () => {
    ownerIsDm(null);
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(403);
  });

  it('participants BOZUK JSON ise fail-closed (kabul değil)', async () => {
    // `JSON.parse` fırlatır → middleware'in fail-closed sınırına düşer.
    ownerIsDm('{bozuk');
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(403);
  });

  it('DM konuşması BULUNAMAZSA fail-closed', async () => {
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM dm_messages')) return { rows: [{ dmId: 'dm1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('yetim dosya — uploads tablosu erişilemezken', () => {
  it('uploads SORGUSU PATLARSA erişim verilmez', async () => {
    // ── ÖNEMLİ ─────────────────────────────────────────────────────────────
    // `.catch(() => ({ rows: [] }))` DB belirsizliğini yutar. Yutulan hata
    // "sahip yok" demektir, "herkes erişebilir" değil. Bu dal, boş yakalama
    // bloğunun fail-OPEN'a dönüşmediğini kanıtlar.
    mockQuery.mockReset();
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM uploads')) throw new Error('deadlock detected');
      return { rows: [], rowCount: 0 };
    });
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(403);
  });

  it('yükleyen kimliği BİLİNMİYORSA kimse erişemez', async () => {
    ownerIsUploader(null);
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('ayse')}`);
    expect(r.status).toBe(403);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('korumalı bayt başlıkları', () => {
  beforeEach(() => ownerIsUploader('ayse'));

  const get = (name: string) =>
    request(app()).get(`/uploads/${name}`).set('Authorization', `Bearer ${tok('ayse')}`);

  it('ARA ÖNBELLEKLEME engellenir', async () => {
    // `private, no-store` olmasaydı bir CDN korumalı eki herkese açık
    // nesne olarak saklayabilirdi — yetkilendirme tamamen atlanırdı.
    const r = await get('ek.txt');
    expect(r.headers['cache-control']).toBe('private, no-store');
  });

  it('nosniff ve DENY her zaman basılır', async () => {
    const r = await get('ek.txt');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
  });

  it('SVG için CSP uygulanır ve tip sabitlenir (depolanmış XSS)', async () => {
    // ── EN ÖNEMLİ İDDİA ────────────────────────────────────────────────────
    // SVG bir BELGEDİR: `<script>` taşıyabilir. Aynı origin'de CSP'siz
    // servis edilirse yüklenen dosya kurbanın oturumunda kod çalıştırır.
    const r = await get('cizim.svg');
    expect(r.headers['content-type']).toContain('image/svg+xml');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['content-security-policy']).toContain('sandbox');
  });

  it.each(['ek.txt', 'arsiv.zip', 'kod.html', 'betik.js'])(
    'satır içi OLMAYAN %s indirmeye zorlanır', async (name) => {
      // `.html` satır içi açılabilseydi yüklenen sayfa origin içinde çalışırdı.
      const r = await get(name);
      expect(r.headers['content-disposition']).toBe('attachment');
    });

  it.each(['resim.png', 'foto.JPG', 'klip.mp4', 'ses.mp3', 'animasyon.gif'])(
    'medya %s satır içi kalır (önizleme bozulmaz)', async (name) => {
      const r = await get(name);
      expect(r.headers['content-disposition']).toBeUndefined();
    });

  it('UZANTISIZ dosya indirmeye zorlanır', async () => {
    const r = await get('uzantisiz');
    expect(r.headers['content-disposition']).toBe('attachment');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('uzak depolama arıza sınıfları', () => {
  beforeEach(() => {
    ownerIsUploader('ayse');
    mockPrivateProvider = 's3';
  });

  const get = (name = 'ek.txt') =>
    request(app()).get(`/uploads/${name}`).set('Authorization', `Bearer ${tok('ayse')}`);

  it.each([
    ['S3 NoSuchKey',      { name: 'NoSuchKey' }],
    ['S3 NotFound',       { name: 'NotFound' }],
    ['HTTP 404 metadata', { $metadata: { httpStatusCode: 404 } }],
    ['yerel ENOENT',      { code: 'ENOENT' }],
  ])('%s → 404 (403 DEĞİL)', async (_label, err) => {
    // "yok" ile "yetkiniz yok" ayrı kalmalı: yetkilendirme zaten GEÇTİ.
    mockStorageReadFile.mockRejectedValue(err);
    const r = await get();
    expect(r.status).toBe(404);
  });

  it.each([
    ['InvalidRange adı',  { name: 'InvalidRange' }],
    ['InvalidRange kodu', { code: 'InvalidRange' }],
    ['HTTP 416 metadata', { $metadata: { httpStatusCode: 416 } }],
    ['RFC adı',           { name: 'RequestedRangeNotSatisfiable' }],
  ])('%s → 416', async (_label, err) => {
    mockStorageReadFile.mockRejectedValue(err);
    const r = await get();
    expect(r.status).toBe(416);
    expect(r.headers['content-range']).toBe('bytes */*');
  });

  it('SINIFLANDIRILAMAYAN arıza → 503 (geçici), 403 değil', async () => {
    // 403 dönseydi bir altyapı arızası kalıcı bir izin hatası gibi görünür,
    // istemci yeniden denemek yerine kullanıcıya "yetkiniz yok" derdi.
    mockStorageReadFile.mockRejectedValue(new Error('connection reset'));
    const r = await get();
    expect(r.status).toBe(503);
  });

  it('BAŞARILI okuma baytları ve güvenlik başlıklarını taşır', async () => {
    mockStorageReadFile.mockResolvedValue({
      body: Readable.from([Buffer.from('BAYTLAR')]),
      contentType: 'text/plain',
      contentLength: 7,
      etag: '"abc"',
      lastModified: new Date('2026-01-01T00:00:00Z'),
      acceptRanges: 'bytes',
    });
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.headers.etag).toBe('"abc"');
    expect(r.headers['last-modified']).toBe('Thu, 01 Jan 2026 00:00:00 GMT');
    expect(r.headers['accept-ranges']).toBe('bytes');
    expect(r.headers['cache-control']).toBe('private, no-store');
  });

  it('KISMİ içerik 206 ve Content-Range döner', async () => {
    mockStorageReadFile.mockResolvedValue({
      body: Readable.from([Buffer.from('AYT')]),
      contentType: 'text/plain',
      contentRange: 'bytes 1-3/7',
      contentLength: 3,
    });
    const r = await request(app()).get('/uploads/ek.txt')
      .set('Authorization', `Bearer ${tok('ayse')}`).set('Range', 'bytes=1-3');
    expect(r.status).toBe(206);
    expect(r.headers['content-range']).toBe('bytes 1-3/7');
  });

  it('AKIŞ ortasında kopan bağlantı süreci düşürmez', async () => {
    // Yakalanmamış bir stream `error` olayı Node'da süreci sonlandırır —
    // tek bir bozuk nesne tüm sunucuyu indirebilirdi.
    const broken = new Readable({ read() { this.destroy(new Error('stream reset')); } });
    mockStorageReadFile.mockResolvedValue({ body: broken, contentType: 'text/plain' });
    await get().catch(() => { /* istemci tarafı kopma beklenir */ });
    expect(mockStorageReadFile).toHaveBeenCalled();
  });

  it('YETKİSİZ kullanıcı için uzak depolamaya HİÇ gidilmez', async () => {
    // Yetkilendirmeden önce okumak, var olmayan/erişilemez dosyaları zamanlama
    // ve hata farkıyla ele verirdi (ve gereksiz maliyet üretirdi).
    const r = await request(app()).get('/uploads/ek.txt').set('Authorization', `Bearer ${tok('yabanci')}`);
    expect(r.status).toBe(403);
    expect(mockStorageReadFile).not.toHaveBeenCalled();
  });
});
