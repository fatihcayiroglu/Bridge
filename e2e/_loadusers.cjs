// e2e/_loadusers.cjs
//
// YÜK ÖLÇÜMÜ İÇİN KULLANICI HAVUZU
//
// Yük testinin ANTİ-SPAM korumasını devre dışı bırakmadan çalışması gerekir.
// `SPAM_CONFIG` kullanıcı başına 4 saniyede 5 mesaja izin verir ve aşan
// kullanıcıyı 30 saniye susturur. Tek kullanıcıyla yapılan bir yük testi bu
// yüzden KAPASİTEYİ DEĞİL, anti-spam eşiğini ölçer.
//
// Doğru yol korumayı kapatmak değil, GERÇEK bir kalabalık üretmektir: her
// biri kendi eşiğinin ALTINDA kalan çok sayıda kullanıcı. Bu betik o havuzu
// oluşturur ve jetonlarını `fixtures/load-users.json` dosyasına yazar.
//
// Kullanıcılar `e2e_load_*` önekiyle adlandırılır — mevcut fikstür
// kullanıcılarından ayırt edilebilir ve istenirse ayıklanabilir.

const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const COUNT = parseInt(process.env.COUNT || '60', 10);
const UA = 'Mozilla/5.0 Chrome/120';
const OUT = __dirname + '/fixtures/load-users.json';

const PASSWORD = 'LoadTestPass123!';

async function csrf(headers) {
  const r = await fetch(BASE + '/api/csrf-token', { headers });
  const j = await r.json().catch(() => ({}));
  return j.token || '';
}

async function ensureUser(i, tag) {
  const username = `e2e_load_${tag}_${i}`;
  const H = { Accept: 'application/json', 'User-Agent': UA, 'Content-Type': 'application/json' };
  const body = JSON.stringify({
    username, password: PASSWORD,
    email: `${username}@bridge-e2e.test`,
    displayName: `Load ${i}`,
  });

  // Once kayit; zaten varsa login.
  let r = await fetch(BASE + '/api/register', {
    method: 'POST', headers: { ...H, 'X-CSRF-Token': await csrf(H) }, body,
  });
  let j = await r.json().catch(() => ({}));
  let tok = j.accessToken || j.token;
  if (tok) return { username, token: tok };

  r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { ...H, 'X-CSRF-Token': await csrf(H) },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  j = await r.json().catch(() => ({}));
  tok = j.accessToken || j.token;
  if (tok) return { username, token: tok };

  return { username, token: null, status: r.status, err: JSON.stringify(j).slice(0, 120) };
}

(async () => {
  // Sabit etiket: tekrar calistirildiginda AYNI kullanicilar yeniden
  // kullanilir, veritabani her kosumda sismez.
  const tag = process.env.TAG || 'p1';
  const users = [];
  let failed = 0;

  for (let i = 0; i < COUNT; i++) {
    const u = await ensureUser(i, tag);
    if (u.token) users.push(u);
    else { failed++; if (failed <= 3) console.log('FAIL', u.username, u.status, u.err); }
  }

  fs.writeFileSync(OUT, JSON.stringify({ password: PASSWORD, users }, null, 2));
  console.log(`hazir: ${users.length}/${COUNT} kullanici  (basarisiz=${failed})`);
  console.log(`yazildi: ${OUT}`);
  process.exit(users.length >= 2 ? 0 : 1);
})().catch(e => { console.error('HATA', e); process.exit(2); });
