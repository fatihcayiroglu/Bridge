// server/scripts/run-security-corpus.cjs
//
// GUVENLIK GERILEME KORPUSU KOSUCUSU
//
// Tek komutla Bridge'in KANITLANMIS ciddi acik siniflarinin hepsini kosturur:
//
//     npm run test:security
//
// TEK KAYNAK: liste `tests/security-corpus.test.ts` icindeki SECURITY_CORPUS
// dizisidir. Bu betik onu OKUR — ikinci bir liste tutmaz, cunku iki liste
// kacinilmaz olarak birbirinden ayrisir.

const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'tests', 'security-corpus.test.ts');

const src = fs.readFileSync(MANIFEST, 'utf8');

// Yalnizca SECURITY_CORPUS dizisi icindeki girisleri al — dosyanin geri
// kalanindaki ornek/negatif kontrol adlarini yanlislikla toplamamak icin.
const blokBas = src.indexOf('SECURITY_CORPUS');
const blokSon = src.indexOf('];', blokBas);
const blok    = src.slice(blokBas, blokSon);

const dosyalar = [...blok.matchAll(/dosya:\s*'([^']+)'/g)].map(m => m[1]);

if (!dosyalar.length) {
  console.error('HATA: korpus listesi okunamadi —', MANIFEST);
  process.exit(2);
}

const eksik = dosyalar.filter(d => !fs.existsSync(path.join(__dirname, '..', 'tests', d)));
if (eksik.length) {
  console.error('HATA: korpusta eksik dosya(lar):');
  for (const e of eksik) console.error('   ', e);
  process.exit(2);
}

console.log(`Güvenlik gerileme korpusu — ${dosyalar.length} suite\n`);
for (const d of dosyalar) console.log('   ', d);
console.log();

// Manifest testi de kosulur: liste curumesin.
const hedefler = [...dosyalar, 'security-corpus.test.ts']
  .map(d => 'tests/' + d);

// NOT: Windows'ta `npx.cmd` spawnSync ile shell:true olmadan ciktisini
// aktarmiyordu — ilk surumde jest sessizce hic gorunmuyordu.
const r = spawnSync(
  'npx jest --runInBand --forceExit ' + hedefler.join(' '),
  { cwd: path.join(__dirname, '..'), stdio: 'inherit', shell: true },
);
process.exit(r.status ?? 1);
