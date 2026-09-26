// server/tests/allowed-columns-model.test.ts
// ALLOWED_COLUMNS GÜVENLİK MODELİ — NİYETİN KANITI.
//
// ════════════════════════════════════════════════════════════════════════════
// MODEL NEDİR (ve ne DEĞİLDİR)
// ════════════════════════════════════════════════════════════════════════════
// `pgCollection` sütun adlarını SQL'e KİMLİK (identifier) olarak enterpole eder:
//     `"${k}"`
// Kimlikler parametrelenemez ($1, $2 yalnızca DEĞER içindir). Bu yüzden
// `ALLOWED_COLUMNS` bir SQL ENJEKSİYON savunmasıdır ve şu konumlarda uygulanır:
//     · WHERE filtreleri          (processKey)
//     · ORDER BY                  (sort)
//     · INSERT sütun listesi
//     · UPDATE $set / $inc / $push
// PROJEKSİYONDA UYGULANMAZ: sorgular satırın tamamını okur; hassas alanların
// gizlenmesi `sanitizeUser` gibi ÇIKIŞ katmanının işidir.
//
// Dolayısıyla bu Set bir YETKİLENDİRME sınırı DEĞİLDİR. Güvenliği şu
// değişmezden gelir:
//
//     SÜTUN ADLARI YALNIZCA GÜVENİLEN, DERLEME ZAMANI SABİTLERİNDEN GELİR.
//     KULLANICI GİRDİSİ ASLA BİR KİMLİK KONUMUNA ULAŞMAZ.
//
// Bu dosya o değişmezi KORUR. Değişmez bozulursa (ör. birileri
// `Users.update(id, req.body)` yazarsa) allow-list'in içeriği aniden saldırı
// yüzeyi haline gelir — bu test o anda kırmızıya döner.
//
// TARİHÇE: allow-list şemanın gerisinde kaldığı için `roleId`, `groupId` ve
// `featured` eksikti; bunlar çalışma zamanında 500'e dönüşüyordu (kanal izin
// uçları, GRUP DM oluşturma, Discover). Liste canlı `information_schema`'dan
// türetilerek hizalandı. Bu bir GEVŞETME değildir: eklenen adların tamamı
// gerçek sütunlardır ve hiçbiri kullanıcı girdisiyle seçilemez.

import fs from 'fs';
import path from 'path';

const SERVER = path.resolve(__dirname, '..');
const SCAN_DIRS = ['routes', 'lib', 'socket'];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(SERVER, d));
  return out;
}

/** Yorumlar denetim dışıdır: bu dosyanın anlattığı desenler bulguya dönüşmesin. */
function code(file: string): string {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('ALLOWED_COLUMNS — enjeksiyon guardının kapsamı', () => {
  const pg = fs.readFileSync(path.join(SERVER, 'db/postgres/pgCollection.ts'), 'utf8');

  it('sütun adı SQL\'e KİMLİK olarak enterpole edilir (bu yüzden allow-list şart)', () => {
    expect(pg).toMatch(/`"\$\{k\}"`|"\$\{col\}"|`"\$\{col\}"`/);
  });

  it('guard filtre, sıralama, insert ve update yollarında UYGULANIR', () => {
    const calls = (pg.match(/assertValidColumn\(/g) ?? []).length;
    // processKey + sort + insert + $set + $inc + $push (+ tanım)
    expect(calls).toBeGreaterThanOrEqual(6);
  });

  it('DEĞERLER her zaman parametrelenir (kimlik ile değer karıştırılmaz)', () => {
    expect(pg).toMatch(/\$\$\{n\+\+\}|\$\$\{params\.length\}|addParam/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('DEĞİŞMEZ — kullanıcı girdisi kimlik konumuna ULAŞAMAZ', () => {
  const files = sourceFiles();

  it('taranacak üretim dosyası bulunur (test kendi kendini boşa düşürmez)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('req.body/query/params DOĞRUDAN filtre/insert/update nesnesi olarak geçilmez', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = code(f);
      // DIKKAT — ONCEKI DESEN YETERSIZDI: `req.body` yalnizca ILK argumanda
      // araniyordu; oysa gercek tehlike `update(id, req.body)` gibi IKINCI
      // argumanda da olusur. Mutasyon testi bunu ortaya cikardi (enjekte
      // edilen ihlal YAKALANMAMISTI). Artik TUM arguman konumlari denetlenir.
      //
      // MESRU KULLANIM KORUNUR: `find({ userId: req.params.id })` gibi
      // cagrilarda kullanici girdisi bir DEGERDIR (parametrelenir), sutun
      // ADI degildir. Bu yuzden yalnizca argumanin TAMAMI `req.x` olan
      // durumlar ihlal sayilir.
      const RISKY = /\.(find|findOne|update|insert|insertMany|remove)\s*\(([^;]{0,400}?)\)/g;
      let m: RegExpExecArray | null;
      while ((m = RISKY.exec(src)) !== null) {
        for (const a of m[2].split(',').map(x => x.trim())) {
          if (/^req\.(body|query|params)$/.test(a)) {
            bad.push(`${path.relative(SERVER, f)}: ${m[0].slice(0, 60)}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('$set / $inc / $push içine kullanıcı nesnesi YAYILMAZ (spread)', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = code(f);
      const m = src.match(/\$(set|inc|push)\s*:\s*\{[^}]*\.\.\.\s*req\.(body|query|params)/g);
      if (m) bad.push(`${path.relative(SERVER, f)}: ${m.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('$set içinde HESAPLANAN anahtar (computed key) kullanılmaz', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = code(f);
      const m = src.match(/\$set\s*:\s*\{\s*\[/g);
      if (m) bad.push(`${path.relative(SERVER, f)}: ${m.length} yer`);
    }
    expect(bad).toEqual([]);
  });

  it('sort() kullanıcı girdisiyle çağrılmaz (ORDER BY kimliği sabittir)', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = code(f);
      const m = src.match(/\.sort\(\s*req\.(body|query|params)/g);
      if (m) bad.push(`${path.relative(SERVER, f)}: ${m.join(', ')}`);
    }
    expect(bad).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('ÇIKIŞ KATMANI — hassas alanlar yanıtta sızmaz', () => {
  // Allow-list projeksiyonu KISITLAMADIGI icin, hassas alan gizleme
  // sorumlulugu `sanitizeUser`dadir. Bu testler o sinirin yerinde durdugunu
  // dogrular; boylece allow-list'in genis olmasi bir SIZINTIYA donusmez.
  it('sanitizeUser parola/token benzeri alanları DIŞARIDA bırakır', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { sanitizeUser } = require('../lib/userUtils');
    const out = sanitizeUser({
      _id: 'u1', username: 'x', displayName: 'X',
      password: 'HASH-SIZMAMALI',
      tokenVersion: 7,
      twoFactorSecret: 'MFA-SIZMAMALI',
      email: 'a@b.c',
    }) as Record<string, unknown>;

    const json = JSON.stringify(out);
    expect(json).not.toContain('HASH-SIZMAMALI');
    expect(json).not.toContain('MFA-SIZMAMALI');
    expect(out.password).toBeUndefined();
    expect(out.twoFactorSecret).toBeUndefined();
    // Kimlik alanlari korunur (pozitif kontrol — test her seyi bosa dusurmuyor).
    expect(out.username).toBe('x');
  });
});
