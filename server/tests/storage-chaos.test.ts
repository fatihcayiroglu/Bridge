// server/tests/storage-chaos.test.ts
//
// NESNE DEPOLAMA KAOSU — REAPER SAĞLAYICI ARIZALARINDA NE YAPAR?
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR
// ════════════════════════════════════════════════════════════════════════════
// Temizlik işi (reaper) sahipsiz yüklemeleri SİLER. Bu, üründeki en yüksek
// hasarlı işlemdir: yanlış davranırsa kullanıcı verisi KALICI olarak gider.
// Daha önce bu yolda gerçek bir P0 veri kaybı yaşandı (`Delimiter: '/'`).
//
// Depolama sağlayıcıları ve veritabanı ARIZALANIR. Bu dosya arızayı ENJEKTE
// eder ve reaper'ın kapalı devre kaldığını kanıtlar.
//
// ── EN KRİTİK DEĞİŞMEZ ──────────────────────────────────────────────────────
// Bir arıza, "hiçbir dosya referanslı değil" gibi YORUMLANMAMALIDIR.
// `listFiles` veya referans sorgusu başarısız olduğunda reaper HİÇBİR ŞEY
// silmemelidir. Aksi hâlde geçici bir veritabanı kesintisi TOPLU VERİ KAYBINA
// dönüşürdü.

import path from 'path';

const _adapter = {
  listFiles:   jest.fn(),
  uploadFile:  jest.fn(),
  deleteFile:  jest.fn(),
  keyFromUrl:  jest.fn((u: string) => String(u).split('/').pop() || ''),
  healthCheck: jest.fn(async () => true),
};

jest.mock('../lib/storageAdapter', () => ({
  __esModule: true,
  getStorageAdapter: () => _adapter,
  getPrivateStorageAdapter: () => _adapter,
  PROVIDER: 'local',
  getProvider: () => 'local',
  getPrivateStorageProvider: () => 'local',
}));

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb({ withPgPool: true }));


jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import db from '../db/loader';
import { runCleanup, isReapable } from '../jobs/cleanupUploads';

/** Mock havuza erisim — GERCEK referans sorgusu bu yoldan gecer. */
const havuz = () => (db as unknown as { _pool: { query: jest.Mock } })._pool.query;

const ESKI = Date.now() - 60 * 60 * 1000;   // 1 saat once — grace period disi
const YENI = Date.now();                     // simdi — grace period icinde

const obj = (key: string, ms: number = ESKI) => ({ key, lastModifiedMs: ms });

// DIKKAT: `obj(key, undefined)` YAZILAMAZ — JavaScript varsayilan parametreleri
// ACIKCA gecilen `undefined` icin de devreye girer, yani deger sessizce ESKI
// olurdu ve test yanlis bir sonucu dogrulardi (ilk yazimda tam bunu yaptim).
// mtime'i BILINMEYEN nesne icin alan HIC konmaz.
const objMtimeYok = (key: string) => ({ key } as { key: string; lastModifiedMs?: number });

beforeEach(() => {
  jest.clearAllMocks();
  // Varsayilan SAGLIKLI referans sorgusu; testler gerektiginde patlatir.
  havuz().mockReset();
  havuz().mockResolvedValue({ rows: [] });
  _adapter.listFiles.mockResolvedValue([]);
  _adapter.deleteFile.mockResolvedValue(undefined);
});

const silinenler = () => _adapter.deleteFile.mock.calls.map(c => c[0]);

// ════════════════════════════════════════════════════════════════════════════
// ARIZA ENJEKSİYONU — kapalı devre kalmalı
// ════════════════════════════════════════════════════════════════════════════
describe('sağlayıcı arızaları', () => {
  it('listFiles PATLARSA hiçbir şey SİLİNMEZ', async () => {
    // Arizayi "dosya yok" saymak veri kaybina donusurdu.
    _adapter.listFiles.mockRejectedValue(new Error('S3 500'));
    await runCleanup();
    expect({ silinen: silinenler() }).toEqual({ silinen: [] });
  });

  it('listFiles ZAMAN AŞIMINA uğrarsa hiçbir şey SİLİNMEZ', async () => {
    _adapter.listFiles.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await runCleanup();
    expect(silinenler()).toEqual([]);
  });

  it('listFiles 403 dönerse hiçbir şey SİLİNMEZ', async () => {
    _adapter.listFiles.mockRejectedValue(Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 403 } }));
    await runCleanup();
    expect(silinenler()).toEqual([]);
  });

  it('listFiles BOŞ dönerse hiçbir şey silinmez', async () => {
    _adapter.listFiles.mockResolvedValue([]);
    await runCleanup();
    expect(silinenler()).toEqual([]);
  });

  it('deleteFile PATLARSA iş DURMAZ — diğer dosyalar işlenir', async () => {
    // Tek bir bozuk nesne tum temizligi engellememeli.
    _adapter.listFiles.mockResolvedValue([obj('a.png'), obj('b.png'), obj('c.png')]);
    _adapter.deleteFile.mockImplementation(async (k: string) => {
      if (k === 'b.png') throw new Error('429 Slow Down');
    });
    await runCleanup();
    expect(silinenler()).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('deleteFile 404 (yarış) İŞİ BOZMAZ', async () => {
    _adapter.listFiles.mockResolvedValue([obj('yok.png')]);
    _adapter.deleteFile.mockRejectedValue(Object.assign(new Error('NoSuchKey'), { $metadata: { httpStatusCode: 404 } }));
    await expect(runCleanup()).resolves.toBeUndefined();
  });

  it('BOZUK sağlayıcı sonucu (key yok) çökme YARATMAZ', async () => {
    _adapter.listFiles.mockResolvedValue([{ lastModifiedMs: ESKI } as never, obj('gecerli.png')]);
    await expect(runCleanup()).resolves.toBeUndefined();
    // Gecerli olan yine de islenmis olmali.
    expect(silinenler()).toContain('gecerli.png');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// KAPSAM — deny-by-default
// ════════════════════════════════════════════════════════════════════════════
describe('kapsam koruması', () => {
  it('STICKER anahtarları ASLA silinmez (yol ayırıcı = kapsam dışı)', async () => {
    // server/uploads/stickers ASLA SILINMEMELI — acik kural.
    _adapter.listFiles.mockResolvedValue([
      obj('stickers/paket/kalp.png'),
      obj('stickers\\paket\\kalp.png'),
      obj('avatars/kullanici.png'),
      obj('banners/sunucu.png'),
    ]);
    await runCleanup();
    expect({ silinen: silinenler() }).toEqual({ silinen: [] });
  });

  it('gizli/dahili girdiler korunur', async () => {
    _adapter.listFiles.mockResolvedValue([obj('.gitkeep'), obj('_manifest')]);
    await runCleanup();
    expect(silinenler()).toEqual([]);
  });

  it('isReapable KÖK DIŞINI reddeder', () => {
    expect({
      kok:      isReapable('dosya.png'),
      altdizin: isReapable('a/b.png'),
      ters:     isReapable('a\\b.png'),
      gizli:    isReapable('.env'),
      dahili:   isReapable('_x'),
      bos:      isReapable(''),
    }).toEqual({ kok: true, altdizin: false, ters: false, gizli: false, dahili: false, bos: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ZAMAN GÜVENLİĞİ
// ════════════════════════════════════════════════════════════════════════════
describe('zaman koruması', () => {
  it('lastModifiedMs BİLİNMİYORSA silinmez (güvenli taraf)', async () => {
    _adapter.listFiles.mockResolvedValue([objMtimeYok('bilinmiyor.png')]);
    await runCleanup();
    expect(silinenler()).toEqual([]);
  });

  it('grace period İÇİNDEKİ yeni dosya silinmez (upload→DB yarışı)', async () => {
    _adapter.listFiles.mockResolvedValue([obj('yeni.png', YENI)]);
    await runCleanup();
    expect(silinenler()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// POZİTİF KONTROL — reaper GERÇEKTEN çalışıyor mu?
// ════════════════════════════════════════════════════════════════════════════
describe('POZİTİF KONTROL', () => {
  it('ESKİ ve SAHİPSİZ kök dosya GERÇEKTEN silinir', async () => {
    // Bu olmadan yukaridaki tum "silinmedi" testleri, reaper HIC calismasa
    // da yesil kalirdi — ve is tamamen olu olurdu.
    _adapter.listFiles.mockResolvedValue([obj('sahipsiz.png')]);
    await runCleanup();
    expect(silinenler()).toEqual(['sahipsiz.png']);
  });

  it('kapsam içi ve kapsam dışı BİR ARADA doğru ayrılır', async () => {
    _adapter.listFiles.mockResolvedValue([
      obj('sahipsiz.png'),                 // silinmeli
      obj('stickers/kalp.png'),            // korunmali
      obj('.gitkeep'),                     // korunmali
      obj('yeni.png', YENI),               // korunmali (grace)
      objMtimeYok('bilinmiyor.png'),    // korunmali (mtime yok)
    ]);
    await runCleanup();
    expect({ silinen: silinenler() }).toEqual({ silinen: ['sahipsiz.png'] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EN KRİTİK DEĞİŞMEZ — REFERANS SORGUSU ARIZASI
// ════════════════════════════════════════════════════════════════════════════
// Reaper "hangi dosyalar referanslı?" sorusunu VERİTABANINA sorar. O sorgu
// başarısız olur ve boş küme gibi ele alınırsa, kapsamdaki HER eski dosya
// "sahipsiz" görünür ve TOPLU VERİ KAYBI olur.
//
// Geçici bir veritabanı kesintisi ASLA kullanıcı dosyalarını silmemelidir.
describe('referans sorgusu arızası', () => {
  it('referans sorgusu PATLARSA hiçbir şey SİLİNMEZ', async () => {
    // GERCEK kod yolu `db._pool.query` uzerinden gider (PostgreSQL dali).
    _adapter.listFiles.mockResolvedValue([obj('a.png'), obj('b.png'), obj('c.png')]);
    havuz().mockRejectedValue(new Error('DB baglantisi koptu'));
    // Kapali devre: firlatabilir ya da sessizce donebilir — ama SILMEZ.
    await runCleanup().catch(() => { /* firlatmasi da kabul */ });
    expect({ silinen: silinenler() }).toEqual({ silinen: [] });
  });

  it('referans sorgusu ZAMAN AŞIMINDA hiçbir şey SİLİNMEZ', async () => {
    _adapter.listFiles.mockResolvedValue([obj('a.png'), obj('b.png')]);
    havuz().mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    await runCleanup().catch(() => { /* firlatmasi da kabul */ });
    expect(silinenler()).toEqual([]);
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('referans sorgusu SAĞLAMKEN silme GERÇEKTEN olur', async () => {
    // Yukaridaki iki test, reaper hic calismasa da yesil kalirdi.
    _adapter.listFiles.mockResolvedValue([obj('a.png')]);
    havuz().mockResolvedValue({ rows: [] });
    await runCleanup();
    expect(silinenler()).toEqual(['a.png']);
  });
});
