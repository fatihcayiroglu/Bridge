// e2e/_relay-probe.cjs — yayin mi yoksa oda uyeligi mi sorunlu?
//
// Iki kol karsilastirilir:
//   KOL 1: uye baglanir ve BEKLER (oda uyeligi baglantidaki onbellege bagli)
//   KOL 2: uye acikca `server:join` yayar (infra.ts odaya ELLE ekler)
//
// KOL 2 calisip KOL 1 calismiyorsa sorun YAYINDA degil, baglantidaki oda
// uyeligindedir.

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
    method: 'POST', headers: OH, body: JSON.stringify({ name: 'Probe ' + Date.now() }),
  })).json();
  const sid = srv._id || srv.id;

  const iv = await (await fetch(A + '/api/servers/invites', {
    method: 'POST', headers: OH, body: JSON.stringify({ serverId: sid }),
  })).json();
  const MH = await hdr(T.bob);
  const useRes = await fetch(A + '/api/servers/invites/' + iv.code + '/use', {
    method: 'POST', headers: MH, body: '{}',
  });
  console.log('davet kullanildi:', useRes.status);

  // ── KOL 1: baglan ve bekle ────────────────────────────────────────────
  const m1 = await connect(T.bob);
  await sleep(1500);
  const got1 = [];
  m1.on('channel:created', d => got1.push(d));

  await fetch(A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: OH, body: JSON.stringify({ name: 'k1-' + Date.now(), type: 'text' }),
  });
  await sleep(2500);
  console.log('KOL 1 (yalnizca baglanti)     :', got1.length, 'olay');

  // ── KOL 2: acikca server:join ─────────────────────────────────────────
  const got2 = [];
  m1.on('channel:created', d => got2.push(d));
  m1.emit('server:join', { serverId: sid });
  await sleep(1200);

  await fetch(A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: OH, body: JSON.stringify({ name: 'k2-' + Date.now(), type: 'text' }),
  });
  await sleep(2500);
  console.log('KOL 2 (acik server:join sonra):', got2.length, 'olay');

  m1.close();

  console.log('\n── TESHIS ──');
  if (got2.length > 0 && got1.length === 0) {
    console.log('YAYIN CALISIYOR. Sorun BAGLANTIDAKI oda uyeliginde (uyelik onbellegi).');
  } else if (got2.length === 0) {
    console.log('YAYIN HIC ULASMIYOR — emit tarafina bakilmali (getIo/oda adi).');
  } else {
    console.log('HER IKI KOL da calisiyor.');
  }
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
