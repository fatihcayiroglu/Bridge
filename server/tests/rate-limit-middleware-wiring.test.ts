// server/tests/rate-limit-middleware-wiring.test.ts
//
// REGRESYON KORUMASI — ÇAĞRILMAMIŞ RATE LIMIT FABRİKASI İSTEĞİ SONSUZA KADAR ASAR.
//
// `limits.api`, `limits.write`, `limits.upload` … BİRER FABRİKADIR:
//     const _c = (key) => () => rateLimit(...)
// Yani `limits.api` middleware DEĞİL, middleware ÜRETEN fonksiyondur ve
// doğru kullanım `limits.api()` şeklindedir.
//
// Parantez unutulduğunda Express fabrikayı middleware sanıp `(req, res, next)`
// ile çağırır. Fabrika argümanlarını YOK SAYAR, yeni bir fonksiyon döndürür,
// `next()` ÇAĞIRMAZ ve yanıt YAZMAZ. Sonuç: istek asla tamamlanmaz.
//
// Canlı ölçüm (Faz J): 13 uç bu şekilde asılıydı. `/.well-known/webfinger` ve
// `/api/federation/users/:username` KİMLİK DOĞRULAMASIZ ve HERKESE AÇIK
// olduğundan, her istek bir bağlantıyı süresiz tutuyordu — bu bir kaynak
// tüketimi vektörüdür. curl 20 sn sonra kod 000 ile düşüyordu.
//
// Bu test kaynak kodunu tarar: middleware konumunda (virgül/parantezle biten)
// ÇAĞRILMAMIŞ bir `limits.x` referansı kalırsa başarısız olur.

import fs from 'fs';
import path from 'path';

const ROUTES_DIR = path.join(__dirname, '..', 'routes');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('rate limit middleware wiring', () => {
  const files = walk(ROUTES_DIR);

  it('route dosyalarını gerçekten tarayabiliyor (koruma anlamlı olsun)', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('hiçbir rotada ÇAĞRILMAMIŞ limits.<x> fabrikası middleware olarak kullanılmaz', () => {
    // Middleware konumu: `limits.api,` veya `limits.api)` — ardından `(` YOKSA
    // fabrika çağrılmamış demektir.
    const offenders: string[] = [];

    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      src.split(/\r?\n/).forEach((line, i) => {
        const re = /limits\.([A-Za-z][A-Za-z0-9_]*)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line))) {
          // Hemen ardından `(` gelmiyorsa fabrika ÇAĞRILMAMIŞ demektir.
          const after = line.slice(m.index + m[0].length);
          if (!after.startsWith('(')) {
            offenders.push(`${path.relative(ROUTES_DIR, file)}:${i + 1}  ${line.trim().slice(0, 100)}`);
          }
        }
      });
    }

    expect(offenders).toEqual([]);
  });
});
