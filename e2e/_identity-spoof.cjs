// e2e/_identity-spoof.cjs
//
// KIMLIK TAKLIDI — GORUNEN AD (displayName) UZERINDEN
//
// ============================================================================
// NEDEN
// ============================================================================
// `username` ASCII ile sinirlidir (/^[a-zA-Z0-9_]+$/) — orada homoglif yok.
// Ama `displayName` yalnizca { type: 'string', max: 80 } ile dogrulanir.
// Kullanicilarin GORDUGU ad budur: uye listesi, mesaj basligi, ses katilimci
// listesi, bildirimler.
//
// Bu betik GERCEK sunucuya karsi dener:
//   1. Kiril homoglifi        -> "Аdmin" (А = U+0410, Latin A DEGIL)
//   2. Sifir genislikli karakter -> "Ad<ZWSP>min"
//   3. RTL/bidi ters cevirme  -> dosya adi/eylem gorsel olarak tersine doner
//   4. Birlestirici yigin     -> Zalgo
//
// Kanit: sunucunun SAKLADIGI ve API'nin DONDURDUGU deger.

const fs = require('fs');
const A = 'http://127.0.0.1:3000';
const T = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/120' };
  const c = (await (await fetch(A + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

const DENEMELER = [
  ['Kiril homoglifi',      'Аdmin'],                 // А + dmin
  ['Yunan homoglifi',      'Μoderator'],             // Μ + oderator
  ['Sifir genislikli',     'Ad​min'],                // ZWSP
  ['Sifir genislik birlestirici', 'Ad‍min'],         // ZWJ
  ['RTL override',         'user‮gnp.exe'],          // bidi ters cevirme
  ['Zalgo/birlestirici',   'Admiń̂̃̄̅'],
  ['Bosluk taklidi',       'Admin '],                // NBSP kuyruk
  ['Tam genislik',         'Ａdmin'],                 // fullwidth A
];

async function tazeToken() {
  // fixtures/tokens.json bayatlayabiliyor; TAZE giris yap.
  const u = (T.users && (T.users.bob || T.users[1] || T.users[0])) || {};
  const kullanici = u.username || 'bob';
  const parola    = u.password || 'E2eTestPass987!';
  const r = await fetch(A + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: kullanici, password: parola }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.token) { console.log('GIRIS BASARISIZ', r.status, JSON.stringify(j).slice(0,120)); process.exit(2); }
  return j.token;
}

(async () => {
  const H = await hdr(await tazeToken());

  // POZITIF KONTROL: ayni uc, ZARARSIZ bir ad kabul ediyor mu?
  // Bu olmadan "hepsi reddedildi" sonucu, yanlis uc noktaya vurmakla
  // AYIRT EDILEMEZ olurdu.
  const pk = await fetch(A + '/api/me', {
    method: 'PATCH', headers: H, body: JSON.stringify({ displayName: 'ZararsizAd' }),
  });
  console.log('POZITIF KONTROL /api/me ->', pk.status, (await pk.text()).slice(0, 90));
  console.log();

  // Karsilastirma icin gercek bir ad
  console.log('HEDEF: gorsel olarak "Admin" gibi gorunen adlar\n');
  console.log('sonuc | teknik ad'.padEnd(34) + '| sunucunun SAKLADIGI');
  console.log('-'.repeat(96));

  const kabul = [];
  for (const [ad, deger] of DENEMELER) {
    const r = await fetch(A + '/api/me', {
      method: 'PATCH', headers: H, body: JSON.stringify({ displayName: deger }),
    });
    let saklanan = '(okunamadi)';
    if (r.ok) {
      const me = await (await fetch(A + '/api/me', { headers: H })).json();
      saklanan = String(me?.displayName ?? me?.user?.displayName ?? '');
    }
    const esit = saklanan === deger;
    if (r.ok && esit) kabul.push(ad);
    console.log(
      (r.ok ? (esit ? 'KABUL' : 'degis') : ('RED' + r.status)).padEnd(6) + '| ' +
      ad.padEnd(30) + '| ' + JSON.stringify(saklanan).slice(0, 46));
  }

  console.log('\n── SONUC ──');
  console.log('kabul edilen taklit vektoru:', kabul.length + '/' + DENEMELER.length);
  for (const k of kabul) console.log('   *', k);
  if (kabul.length) {
    console.log('\nACIK: gorunen ad, gorsel olarak baska bir kimlige benzetilebiliyor.');
    process.exit(1);
  }
  console.log('\nKAPALI: taklit vektorleri reddedildi/normalize edildi.');
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
