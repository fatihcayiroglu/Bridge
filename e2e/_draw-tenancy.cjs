// e2e/_draw-tenancy.cjs
//
// ORTAK TUVAL (draw-together) — ÇAPRAZ KİRACI ERİŞİMİ
//
// `draw:join` istemcinin gönderdiği `channelId` değerine KOŞULSUZ güvenir:
// kanal üyeliği denetlenmez, sunucu üyeliği denetlenmez. Oturum yoksa
// SALDIRGAN ADINA OLUŞTURULUR ve saldırgan `draw:<channelId>` odasına girer.
//
// Sonuç iki yönlüdür:
//   OKUMA  — kanaldaki herkesin çizimleri (metin aracı dahil) saldırgana akar
//   YAZMA  — saldırgan o kanalın tuvaline çizim/metin enjekte edebilir
//
// Bu betik ikisini de GERÇEK sunucuya karşı ölçer.

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

function stroke(channelId, id, text) {
  return {
    channelId, id, tool: 'pen', color: '#ff0000', size: 4, opacity: 1,
    points: [{ x: 1, y: 1 }, { x: 2, y: 2 }], text,
  };
}

(async () => {
  // Kurban kendi sunucusunu ve kanalini kurar. Saldirgan UYE DEGILDIR.
  const VH = await hdr(T.alice);
  const srv = await (await fetch(A + '/api/servers', {
    method: 'POST', headers: VH, body: JSON.stringify({ name: 'DrawVictim ' + Date.now() }),
  })).json();
  const sid = srv._id || srv.id;
  const ch = await (await fetch(A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: VH, body: JSON.stringify({ name: 'tuval-' + Date.now(), type: 'text' }),
  })).json();
  const cid = ch._id || ch.id;

  const victim = await connect(T.alice);
  const attacker = await connect(T.bob);            // bob UYE DEGIL
  if (!victim || !attacker) { console.log('baglanti yok'); process.exit(2); }

  // Kurban tuvale girer ve cizer.
  victim.emit('draw:join', { channelId: cid, sessionId: 'sess-' + Date.now() });
  await sleep(1200);

  // ── SALDIRI 1: uye olmadan tuvale KATIL ────────────────────────────────
  const attackerGot = [];
  attacker.on('draw:stroke', s => attackerGot.push(s));
  attacker.on('draw:state', s => attackerGot.push({ state: true, s }));
  attacker.emit('draw:join', { channelId: cid, sessionId: 'sess-attack' });
  await sleep(1200);

  // Kurban gizli bir metin cizer.
  victim.emit('draw:stroke', stroke(cid, 'v-1', 'GIZLI NOT'));
  await sleep(1500);

  // ── SALDIRI 2: kurbanin tuvaline YAZ ──────────────────────────────────
  const victimGot = [];
  victim.on('draw:stroke', s => victimGot.push(s));
  attacker.emit('draw:stroke', stroke(cid, 'a-1', 'SALDIRGAN ENJEKSIYONU'));
  await sleep(1500);

  // ── POZITIF KONTROL: MESRU UYE hala cizebilmeli ───────────────────────
  // Asiri genis bir yama da saldiriyi "kapatirdi"; mesru yolun calistigini
  // ayrica kanitlamak sart.
  const iv = await (await fetch(A + '/api/servers/invites', {
    method: 'POST', headers: VH, body: JSON.stringify({ serverId: sid }),
  })).json();
  await fetch(A + '/api/servers/invites/' + iv.code + '/use', {
    method: 'POST', headers: await hdr(T.carol), body: '{}',
  });
  const member = await connect(T.carol);
  const memberGot = [];
  const victimGot2 = [];
  victim.on('draw:stroke', s2 => victimGot2.push(s2));
  member.on('draw:state', () => memberGot.push('state'));
  member.emit('draw:join', { channelId: cid, sessionId: 'sess-member' });
  await sleep(1500);
  member.emit('draw:stroke', stroke(cid, 'm-1', 'UYE CIZIMI'));
  await sleep(1500);
  const memberJoined = memberGot.length > 0;
  const memberCanDraw = victimGot2.some(x => String(x?.text || '') === 'UYE CIZIMI');
  member.close();

  victim.close(); attacker.close();

  const readLeak = attackerGot.length > 0;
  const writeInject = victimGot.some(s => String(s?.text || '') === 'SALDIRGAN ENJEKSIYONU');

  console.log('kurban kanali :', cid);
  console.log('saldirgan uye : HAYIR');
  console.log('OKUMA sizintisi (saldirgan kurban cizimini aldi):', readLeak, '(' + attackerGot.length + ' olay)');
  console.log('YAZMA enjeksiyonu (kurban saldirgan cizimini aldi):', writeInject);

  console.log('MESRU uye tuvale katilabildi :', memberJoined);
  console.log('MESRU uye cizebildi          :', memberCanDraw);

  console.log('\n── SONUC ──');
  // POZITIF KONTROL ONCE: asiri genis bir yama da saldiriyi "kapatir".
  if (!memberJoined || !memberCanDraw) {
    console.log('DUSTU: yama COK GENIS — mesru uye de engellendi.');
    process.exit(1);
  }
  if (readLeak || writeInject) {
    console.log('ACIK: uye OLMAYAN kullanici baska bir kanalin tuvalini okuyabiliyor/yazabiliyor.');
    process.exit(1);
  }
  console.log('KAPALI: capraz kiraci tuval erisimi yok, mesru uye CALISIYOR.');
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
