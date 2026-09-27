// e2e/_readysignal-ab.cjs
//
// FAZ 1 — ÇOK INSTANCE'LI FAN-OUT: DÜZELTMENİN A/B KANITI
//
// ════════════════════════════════════════════════════════════════════════════
// NE KANITLANIYOR
// ════════════════════════════════════════════════════════════════════════════
// Kök neden Redis fan-out DEĞİLDİ. Sunucu, özellik dinleyicilerini
// (`channel:join` dahil) DÖRT ardışık `await`ten SONRA kaydeder ve
// `userAuthenticated`i kayıt BİTTİKTEN sonra yayar. Socket.IO, dinleyicisi
// olmayan bir olayı SESSİZCE ATAR — `channel:join` ack'siz olduğu için hata
// da üretmez.
//
// İstemci (`SocketManager.svelte`) hazır sinyalini ham `connect` olayında
// yayıyordu; `MessageLoader` o sinyalde `channel:join` gönderiyordu. Sonuç:
// katılma isteği düşüyor, kullanıcı BAĞLI görünüp CANLI MESAJ ALMIYORDU.
//
// ── BU BETİK İKİ KOLU YAN YANA ÖLÇER ──────────────────────────────────────
//   A) ESKİ DAVRANIŞ : `connect` olur olmaz `channel:join`
//   B) YENİ DAVRANIŞ : `userAuthenticated` beklenip sonra `channel:join`
//
// Her kol N tur, hem ÇAPRAZ (gönderen A, alan B) hem AYNI instance'ta.
// Beklenen: A kolu kayıp verir, B kolu %100 teslim eder.
//
// TEK BİR TUR BİLE KANIT DEĞİLDİR — yarış olasılıksaldır. Bu yüzden tekrar
// edilir ve oranlar basılır.

const fs = require('fs');
const io = require('socket.io-client');

const T = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const A = 'http://127.0.0.1:3000';
const B = 'http://127.0.0.1:3010';
const UA = 'Mozilla/5.0 Chrome/120';
const ROUNDS = parseInt(process.env.ROUNDS || '8', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(base, tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': UA };
  const c = (await (await fetch(base + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

/**
 * Bağlanır ve İSTENEN SİNYALE kadar bekler.
 * mode='connect'  → ham connect (ESKİ, yarışlı davranış)
 * mode='authed'   → userAuthenticated (YENİ, düzeltilmiş davranış)
 */
function conn(base, tok, mode) {
  return new Promise(res => {
    const s = io(base, { auth: { token: tok }, transports: ['websocket'], reconnection: false, timeout: 8000 });
    const t = setTimeout(() => res(null), 9000);
    const done = () => { clearTimeout(t); res(s); };
    s.on('connect_error', () => { clearTimeout(t); res(null); });
    if (mode === 'authed') {
      s.once('userAuthenticated', done);
      // Sinyal hiç gelmezse ürünle aynı yedek süre uygulanır.
      s.on('connect', () => setTimeout(() => { if (s.connected) done(); }, 3000));
    } else {
      s.on('connect', done);
    }
  });
}

/** Tek tur: alıcı `mode`a göre katılır, gönderen mesaj atar, teslim ölçülür. */
async function round(sendBase, recvBase, mode, cid, sid) {
  const sender = await conn(sendBase, T.alice, 'authed');   // gönderen hep hazır
  const recv   = await conn(recvBase, T.bob, mode);
  if (!sender || !recv) { sender?.close(); recv?.close(); return 'CONN_FAIL'; }

  // Alıcı, ölçülen davranışa göre katılır: sinyal gelir gelmez, GECİKMESİZ.
  recv.emit('channel:join', cid);

  // Gönderen odaya güvenle girsin (bu kolun ölçüsü DEĞİL).
  sender.emit('channel:join', cid);
  await sleep(1200);

  const content = 'ab-' + Math.random().toString(36).slice(2, 10);
  const got = await new Promise(r => {
    const timer = setTimeout(() => r(false), 6000);
    recv.on('message:new', m => {
      if (String(m.content || '') === content) { clearTimeout(timer); r(true); }
    });
    sender.emit('message:send', { channelId: cid, serverId: sid, content, ackId: 'ab' + Date.now() });
  });

  sender.close(); recv.close();
  return got;
}

(async () => {
  const AH = await hdr(A, T.alice), BH = await hdr(A, T.bob);

  const s = await (await fetch(A + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'ABTest ' + Date.now() }),
  })).json();
  const sid = s._id || s.id;
  const c = await (await fetch(A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'ab' + Date.now(), type: 'text' }),
  })).json();
  const cid = c._id || c.id;
  const iv = await (await fetch(A + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }),
  })).json();
  await fetch(A + '/api/servers/invites/' + iv.code + '/use', { method: 'POST', headers: BH, body: '{}' });

  console.log(`kanal=${cid} tur=${ROUNDS}\n`);
  const results = {};

  // Her iki YON de olculur: A->B ve B->A. Tek yonlu bir kanit,
  // yalnizca bir instance'in yayin yaptigi bir kurulumu gizleyebilirdi.
  for (const [topo, sendBase, recvBase] of [
    ['CROSS A->B', A, B],
    ['CROSS B->A', B, A],
    ['SAME  A->A', A, A],
  ]) {
    for (const mode of ['connect', 'authed']) {
      let ok = 0, fail = 0, err = 0;
      for (let i = 0; i < ROUNDS; i++) {
        const r = await round(sendBase, recvBase, mode, cid, sid);
        if (r === 'CONN_FAIL') err++;
        else if (r) ok++;
        else fail++;
        await sleep(400);
      }
      const label = `${topo}/${mode === 'authed' ? 'userAuthenticated (YENI)' : 'connect (ESKI)'}`;
      results[`${topo}:${mode}`] = { ok, fail, err };
      console.log(`${label.padEnd(38)} teslim ${ok}/${ROUNDS}  kayip=${fail} baglanti_hatasi=${err}`);
    }
  }

  console.log('\n── SONUC ──');
  const ab = results['CROSS A->B:authed'], ba = results['CROSS B->A:authed'];
  console.log(`A->B yeni=${ab.ok}/${ROUNDS}   B->A yeni=${ba.ok}/${ROUNDS}`);
  const good = ab.ok === ROUNDS && ba.ok === ROUNDS && ab.err === 0 && ba.err === 0;
  console.log(good
    ? 'GECTI: her IKI yonde de %100 teslim'
    : 'DUSTU: en az bir yonde kayip var');
  process.exit(good ? 0 : 1);
})().catch(e => { console.error('HATA', e); process.exit(2); });
