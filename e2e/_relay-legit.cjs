// e2e/_relay-legit.cjs
//
// MEŞRU YOL KONTROLÜ — kaldırmadan önce kanıt.
//
// `infra.ts` içindeki `channel:*` / `category:*` yayın röleleri yetkisizdir ve
// çapraz kiracı enjeksiyonuna açıktır. Kaldırmadan önce cevaplanması gereken
// soru şudur:
//
//     GERÇEK bir kanal oluşturma, diğer üyelere zaten ulaşıyor mu?
//
// Eğer ulaşıyorsa röle ölü koddur ve güvenle kaldırılabilir.
// Eğer ulaşmıyorsa, röleyi silmek ürün davranışını bozar — o zaman doğru
// düzeltme silmek değil YETKİLENDİRMEKTİR.

const fs = require('fs');
const io = require('socket.io-client');

const T = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const A = 'http://127.0.0.1:3000';
const UA = 'Mozilla/5.0 Chrome/120';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': UA };
  const c = (await (await fetch(A + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

function connect(tok) {
  return new Promise(res => {
    const s = io(A, { auth: { token: tok }, transports: ['websocket'], reconnection: false, timeout: 15000 });
    const t = setTimeout(() => res(null), 16000);
    s.once('userAuthenticated', () => { clearTimeout(t); res(s); });
    s.on('connect_error', () => { clearTimeout(t); res(null); });
  });
}

(async () => {
  const OH = await hdr(T.alice);
  const srv = await (await fetch(A + '/api/servers', {
    method: 'POST', headers: OH, body: JSON.stringify({ name: 'Legit ' + Date.now() }),
  })).json();
  const sid = srv._id || srv.id;

  // Ikinci kullanici GERCEK uye olsun.
  const iv = await (await fetch(A + '/api/servers/invites', {
    method: 'POST', headers: OH, body: JSON.stringify({ serverId: sid }),
  })).json();
  const MH = await hdr(T.bob);
  await fetch(A + '/api/servers/invites/' + iv.code + '/use', { method: 'POST', headers: MH, body: '{}' });

  const member = await connect(T.bob);
  if (!member) { console.log('baglanti yok'); process.exit(2); }
  await sleep(1500);

  const seen = [];
  for (const ev of ['channel:created', 'channel:updated', 'channel:deleted',
                    'category:created', 'category:deleted', 'server:updated']) {
    member.on(ev, d => seen.push({ ev, d }));
  }

  // ── MESRU islem: sahibi REST ile kanal olusturur ────────────────────────
  const ch = await (await fetch(A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: OH, body: JSON.stringify({ name: 'yeni-' + Date.now(), type: 'text' }),
  })).json();
  const cid = ch._id || ch.id;

  await sleep(2500);

  // ── MESRU islem: kanal silinir ─────────────────────────────────────────
  await fetch(A + '/api/channels/' + cid, { method: 'DELETE', headers: OH });
  await sleep(2500);

  member.close();

  console.log('uye olarak alinan MESRU olaylar:', seen.length);
  for (const s of seen) console.log('   <= ' + s.ev + '  ' + JSON.stringify(s.d).slice(0, 80));

  console.log('\n── SONUC ──');
  if (seen.length === 0) {
    console.log('ROLE OLU: gercek kanal islemleri bu olaylari HIC uretmiyor.');
    console.log('=> istemci-yuzlu roleler guvenle KALDIRILABILIR.');
  } else {
    console.log('ROLE CANLI: gercek islemler bu olaylari uretiyor.');
    console.log('=> silmek DAVRANISI BOZAR; dogru duzeltme YETKILENDIRMEKTIR.');
  }
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
