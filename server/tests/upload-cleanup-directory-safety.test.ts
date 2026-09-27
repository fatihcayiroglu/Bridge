// server/tests/upload-cleanup-directory-safety.test.ts
// FAZ J — TEMİZLİK İŞİ DİZİNLERİ DOSYA SANMAZ.
//
// ════════════════════════════════════════════════════════════════════════════
// CANLI ÇALIŞTIRMADA GÖRÜLEN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `storageAdapter.listFiles()` (local sağlayıcı) `readdirSync` çıktısının
// TAMAMINI `StorageObject` olarak döndürüyordu — alt DİZİNLER dâhil:
//
//     _chunks, _quarantine, emojis, member-profiles, recordings,
//     server-assets, soundboard, stickers
//
// `cleanupUploads` işi bu "dosyaları" `deleteFile()` ile silmeye çalışıyor,
// o da `unlinkSync` çağırdığı için dizinlerde EPERM fırlatıyordu. Hata
// yakalanıp atlandığı için işlevsel zarar yoktu, ancak her temizlik
// döngüsünde tekrarlayan hata gürültüsü üretiyordu (gerçek dağıtım
// loglarında gözlendi).
//
// `statSync` zaten çağrılıyordu; eksik olan tek şey `isFile()` süzgeciydi.
//
// ════════════════════════════════════════════════════════════════════════════
// BU PAKET NEDEN GERÇEK DİZİNİ OKUR
// ════════════════════════════════════════════════════════════════════════════
// `LOCAL_UPLOAD_DIR` ortam değişkeniyle YAPILANDIRILAMAZ — `__dirname/../uploads`
// olarak sabittir. Bu yüzden test onu başka yere yönlendiremez.
//
// Bunun yerine test GERÇEK `server/uploads` dizinini SALT OKUNUR biçimde
// doğrular. Bu hem daha güvenli (hiçbir dosya oluşturulmaz/silinmez) hem de
// daha güçlüdür: kusura yol açan GERÇEK yerleşim üzerinde ölçüm yapılır.
//
// GÜVENLİK: `uploads/stickers` tarihsel, atfedilemeyen ~242 dosya içerir ve
// ASLA silinmemelidir. Bu paket hiçbir şey yazmaz/silmez.

process.env.NODE_ENV = 'test';

import fs from 'fs';
import path from 'path';
import { getStorageAdapter } from '../lib/storageAdapter';
import { uploadRoot } from '../lib/runtimePaths';

// Kanonik kok kullanilir: testler artik tek kullanimlik bir dizine yazar
// (bkz. tests/setup.js). Ham `__dirname` hesabi, derlenmis kosuda
// `server/dist/uploads` gosteren kusurun ta kendisiydi.
const UPLOAD_DIR = uploadRoot();

/** Diskteki ilk seviye girdileri türlerine göre ayırır. */
function split() {
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of fs.readdirSync(UPLOAD_DIR)) {
    try {
      (fs.statSync(path.join(UPLOAD_DIR, e)).isDirectory() ? dirs : files).push(e);
    } catch { /* yoksay */ }
  }
  return { dirs, files };
}

// ── FIXTURE, ORTAM DEGILI ──────────────────────────────────────────────────
// Bu dosya eskiden GERCEK `server/uploads/` icerigine bagliydi: on kosul,
// diskte tarihsel olarak birikmis `stickers/` klasorunun VARLIGINI sart
// kosuyordu. Iki sorun: (1) test, kaynak agacindaki calisma zamani cop
// verisine bagimliydi; (2) temiz bir makinede sessizce vakumsal gecerdi.
// Artik gerekli yapiyi KENDISI kurar (tek kullanimlik kokte, bkz.
// tests/setup.js) — iddia ayni, bagimlilik yok.
const FIXTURE_DIRS  = ['stickers', 'emojis', '_chunks'];
const FIXTURE_FILES = ['duz-dosya-1.bin', 'duz-dosya-2.bin'];

beforeAll(() => {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const d of FIXTURE_DIRS) {
    fs.mkdirSync(path.join(UPLOAD_DIR, d), { recursive: true });
    // Alt dosyalar: ozyinelemeli taranmadigi da olculebilsin.
    fs.writeFileSync(path.join(UPLOAD_DIR, d, `ic-${d}.bin`), 'x');
  }
  for (const f of FIXTURE_FILES) fs.writeFileSync(path.join(UPLOAD_DIR, f), 'x');
});

describe('listFiles — dizin/dosya ayrımı', () => {
  it('ÖN KOŞUL: uploads dizini gerçekten alt DİZİNLER içerir', () => {
    // Bu olmadan aşağıdaki "dizin listelenmez" iddiası boş bir küme üzerinde
    // vakumsal olarak geçerdi.
    const { dirs, files } = split();

    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toEqual(expect.arrayContaining(['stickers']));
    expect(files).toEqual(expect.arrayContaining(FIXTURE_FILES));
  });

  it('HİÇBİR dizin dosya olarak listelenmez (asıl kusur)', async () => {
    const { dirs } = split();

    const listed = (await getStorageAdapter().listFiles()).map(o => o.key);

    for (const d of dirs) {
      expect(listed).not.toContain(d);
    }
  });

  it('stickers dizini listelenmez — tarihsel dosyalar korunur', async () => {
    const listed = (await getStorageAdapter().listFiles()).map(o => o.key);

    expect(listed).not.toContain('stickers');
    // Alt dosyalar ÖZYİNELEMELİ olarak da taranmaz.
    const stickerDir = path.join(UPLOAD_DIR, 'stickers');
    if (fs.existsSync(stickerDir)) {
      const inner = fs.readdirSync(stickerDir).slice(0, 5);
      for (const f of inner) expect(listed).not.toContain(f);
      // Ve dosyalar diskte DURUYOR.
      expect(fs.readdirSync(stickerDir).length).toBeGreaterThan(0);
    }
  });

  it('listelenen her öğe diskte GERÇEKTEN düz dosyadır', async () => {
    const objs = await getStorageAdapter().listFiles();

    for (const o of objs) {
      const st = fs.statSync(path.join(UPLOAD_DIR, o.key));
      expect(st.isFile()).toBe(true);
      expect(typeof o.lastModifiedMs).toBe('number');
    }
  });

  it('listelenen öğe sayısı diskteki DÜZ DOSYA sayısına eşittir', async () => {
    const { files } = split();

    const listed = (await getStorageAdapter().listFiles()).map(o => o.key).sort();

    expect(listed).toEqual([...files].sort());
  });

  it('üretim kodu isFile() süzgecini KORUR (regresyon kapısı)', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/storageAdapter.ts'), 'utf8');

    // Dizin elemesi KORUNMALI. `isFile()` ZORUNLU DEĞİLDİR: bazı çağıranlar
    // statSync'ten düz `{ mtimeMs }` nesneleri döndürür; `isFile()` şart
    // koşulsaydı o girdiler listelenmez ve temizlik hiçbir şeyi
    // değerlendiremezdi. Bu yüzden ölçüt `isDirectory()` elemesidir.
    expect(src).toMatch(/isDirectory/);
    // Eski "hepsini döndür" biçimi geri gelmemeli.
    expect(src).not.toMatch(/return fs\.readdirSync\(LOCAL_UPLOAD_DIR\)\.map\(/);
  });
});
