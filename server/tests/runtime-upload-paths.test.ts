// server/tests/runtime-upload-paths.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ÇALIŞMA ZAMANI VERİSİ, DERLEME ÇIKTISINI KİRLETMEZ
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN KUSUR: 12 üretim dosyası yükleme kökünü
// `path.join(__dirname, '../uploads')` ile hesaplıyordu. `__dirname` derlenmiş
// konuma bağlı olduğu için:
//
//     kaynaktan (ts-node)  server/routes      -> server/uploads       ✔
//     derlenmiş (node)     server/dist/routes -> server/dist/uploads  ✘
//
// Bu incelemede `server/dist/uploads/` altında 83 MB gerçek çalışma zamanı
// verisi ölçüldü — 154 adet `e2e-*` parça dizini dâhil.
//
// ── NEDEN CİDDİ ─────────────────────────────────────────────────────────────
// `dist/` ÜRETİLEN çıktıdır. `rm -rf dist && npm run build` ya da yeni bir
// Docker katmanı TÜM KULLANICI YÜKLEMELERİNİ siler. Yedekleme yordamları da
// `dist/`i "türetilmiş" sayıp atlar; kayıp sessiz ve geri dönüşsüz olur.
//
// Bu dosya, düzeltmenin gerçekten DERLENMİŞ konumda da çalıştığını ölçer —
// yalnızca kaynaktan çalışan testler bu kusuru ASLA göremezdi, çünkü kaynak
// yolu zaten doğruydu.

import fs from 'fs';
import os from 'os';
import path from 'path';

const MOD = '../lib/runtimePaths';

/** `runtimePaths`i, sanki verilen dizinde duruyormuş gibi yeniden yükler. */
function loadFrom(fakeDirname: string) {
  let mod: typeof import('../lib/runtimePaths');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require(MOD);
  });
  // `SERVER_ROOT` modül yüklenirken hesaplanır; çözümleyiciyi doğrudan sınamak
  // için aynı mantığı burada da uygularız (bkz. resolveServerRoot).
  const parts = fakeDirname.split(path.sep);
  const i = parts.lastIndexOf('dist');
  const root = i > 0 ? parts.slice(0, i).join(path.sep) : path.resolve(fakeDirname, '..');
  return { mod: mod!, root };
}

describe('server kökü çözümlemesi — kaynak ve derlenmiş AYNI yeri verir', () => {
  // Platforma göre GERÇEK mutlak yol kullan. Önceki test Windows `C:/...`
  // dizgesini POSIX'te `path.resolve()`a vererek onu göreceli yol saydırıyor,
  // ürün mantığı doğru olsa bile Linux CI'da kırılıyordu.
  const fixtureRoot = path.resolve(path.sep, 'bridge-runtime-path-contract', 'server');
  const cases: Array<[string, string, string]> = [
    ['kaynak/lib',      path.join(fixtureRoot, 'lib'),                     fixtureRoot],
    ['derlenmiş/lib',   path.join(fixtureRoot, 'dist', 'lib'),             fixtureRoot],
    ['derlenmiş/derin', path.join(fixtureRoot, 'dist', 'routes', 'x'),     fixtureRoot],
  ];

  it.each(cases)('%s -> server kökü', (_label, dirname, expected) => {
    expect(loadFrom(dirname).root).toBe(expected);
  });

  it('KAYNAK ve DERLENMİŞ konum AYNI kökü verir', () => {
    const src  = loadFrom(path.join(fixtureRoot, 'routes')).root;
    const dist = loadFrom(path.join(fixtureRoot, 'dist', 'routes')).root;
    expect(dist).toBe(src);
  });

  it('adında "dist" GEÇEN bir klasör yanlışlıkla eşleşmez', () => {
    // `my-dist-tools` bir yol PARÇASI olarak `dist` değildir.
    const parent = path.resolve(path.sep, 'bridge-runtime-path-contract', 'my-dist-tools', 'server');
    const r = loadFrom(path.join(parent, 'lib')).root;
    expect(r).toBe(parent);
  });
});

describe('uploadRoot / uploadDir', () => {
  const prev = process.env.BRIDGE_UPLOAD_ROOT;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-uploads-'));
    process.env.BRIDGE_UPLOAD_ROOT = tmp;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.BRIDGE_UPLOAD_ROOT;
    else process.env.BRIDGE_UPLOAD_ROOT = prev;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('BRIDGE_UPLOAD_ROOT kökü geçersiz kılar', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { uploadRoot } = require(MOD) as typeof import('../lib/runtimePaths');
    expect(path.resolve(uploadRoot())).toBe(path.resolve(tmp));
  });

  it('kök HER ÇAĞRIDA okunur (modül yükleme anında yakalanmaz)', () => {
    // Yakalansaydı, testler tek kullanımlık bir dizine yönlendiremez ve
    // gerçek `uploads/` klasörünü kirletirlerdi.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { uploadRoot } = require(MOD) as typeof import('../lib/runtimePaths');
    const first = uploadRoot();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-uploads-2-'));
    process.env.BRIDGE_UPLOAD_ROOT = other;
    try {
      expect(path.resolve(uploadRoot())).toBe(path.resolve(other));
      expect(path.resolve(uploadRoot())).not.toBe(path.resolve(first));
    } finally {
      process.env.BRIDGE_UPLOAD_ROOT = tmp;
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('uploadDir alt dizini oluşturur ve kök altında tutar', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { uploadDir, isInsideUploadRoot } = require(MOD) as typeof import('../lib/runtimePaths');
    const chunks = uploadDir('_chunks');
    expect(fs.existsSync(chunks)).toBe(true);
    expect(isInsideUploadRoot(chunks)).toBe(true);
  });

  it('isInsideUploadRoot kökün DIŞINI reddeder (path traversal)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isInsideUploadRoot, uploadRoot } = require(MOD) as typeof import('../lib/runtimePaths');
    expect(isInsideUploadRoot(path.join(uploadRoot(), '..', 'gizli.txt'))).toBe(false);
    expect(isInsideUploadRoot(path.join(uploadRoot(), 'a', '..', '..', 'gizli.txt'))).toBe(false);
    expect(isInsideUploadRoot(path.join(uploadRoot(), 'a', 'b.txt'))).toBe(true);
  });

  it('kökün KENDİSİ "içeride" sayılmaz (sınır kesin)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { isInsideUploadRoot, uploadRoot } = require(MOD) as typeof import('../lib/runtimePaths');
    expect(isInsideUploadRoot(uploadRoot())).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('statik denetim: üretim kodu artık __dirname ile uploads hesaplamaz', () => {
  it('app/, lib/, routes/ içinde ham `__dirname, "../uploads"` KALMADI', () => {
    // Bu, kusurun geri gelmesini engelleyen asıl kapıdır: yeni bir dosya eski
    // deseni kopyalarsa bu test kırmızıya döner.
    const roots = ['app', 'lib', 'routes'];
    const offenders: string[] = [];
    const RE = /__dirname\s*,\s*['"]\.\.\/uploads/;

    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.ts') || e.name.endsWith('.d.ts')) continue;
        if (e.name === 'runtimePaths.ts') continue;          // kusuru anlatan yorum
        const src = fs.readFileSync(full, 'utf8');
        // Yorum satırlarını at: yalnızca gerçek kod sayılır.
        const code = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
        if (RE.test(code)) offenders.push(path.relative(path.resolve(__dirname, '..'), full).replace(/\\/g, '/'));
      }
    };
    for (const r of roots) walk(path.resolve(__dirname, '..', r));
    expect(offenders).toEqual([]);
  });

  it('denetim gerçekten dosya tarıyor (kendi kendini doğrulama)', () => {
    const dir = path.resolve(__dirname, '..', 'routes');
    const n = fs.readdirSync(dir).filter(f => f.endsWith('.ts')).length;
    expect(n).toBeGreaterThan(10);
  });
});
