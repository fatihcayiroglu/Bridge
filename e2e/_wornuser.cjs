// e2e/_wornuser.cjs
//
// COK SUNUCUYA UYE KULLANICI GERCEK ZAMANLI MESAJ ALMAYI BIRAKIYOR MU?
//
// GOZLEM: havuzun ilk kullanicilari (onceki kosularda defalarca sunucuya
// katildi) artik HIC `message:new` almiyor; hic kullanilmamis kullanicilar
// %100 aliyor. Ayni an, ayni kod, ayni kanal.
//
// Bu betik farkin NEDENINI arar:
//   * kullanici kac sunucuya uye?
//   * mesaj VERITABANINA yaziliyor mu (yani gonderim mi yoksa YAYIN mi bozuk)?
//   * soket kanala gercekten katiliyor mu (ack/hata var mi)?
//
// Ayrim onemli: mesaj kaydediliyor ama yayin gelmiyorsa bu GERCEK ZAMANLI
// KATMAN kusurudur ve gercek kullanicilari da etkiler.

const fs = require('fs');
const io = require('socket.io-client');

const BASE   = process.env.BASE || 'http://127.0.0.1:3300';
const OFFSET = parseInt(process.env.OFFSET || '0', 10);

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/120' };
  const c = (await (await fetch(BASE + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

async function incele(etiket, u) {
  const H = await hdr(u.token);
  const sunucular = await (await fetch(BASE + '/api/servers', { headers: H })).json();
  const adet = Array.isArray(sunucular) ? sunucular.length : (sunucular?.servers?.length ?? -1);
  console.log(`\n── ${etiket} ──`);
  console.log(`uye oldugu sunucu sayisi: ${adet}`);
  return { H, adet };
}

(async () => {
  const AH = await hdr(FIX.alice);
  const srv = await (await fetch(BASE + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'Worn ' + Date.now() }) })).json();
  const sid = srv._id || srv.id;
  const ch = await (await fetch(BASE + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'w' + Date.now(), type: 'text' }) })).json();
  const cid = ch._id || ch.id;
  const iv = await (await fetch(BASE + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }) })).json();

  const denek = [
    ['YIPRANMIS (havuz 0)',  POOL.users[OFFSET]],
    ['TAZE      (havuz 505)', POOL.users[505]],
  ];

  for (const [etiket, u] of denek) {
    const { H, adet } = await incele(etiket, u);

    const kat = await fetch(BASE + '/api/servers/invites/' + iv.code + '/use', { method: 'POST', headers: H, body: '{}' });
    console.log(`davet kullanimi        : HTTP ${kat.status}`);

    const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, timeout: 20000 });
    let alinan = 0;
    const olaylar = [];
    await new Promise(res => {
      const t = setTimeout(res, 21000);
      s.once('userAuthenticated', () => { clearTimeout(t); res(); });
      s.on('connect_error', e => { clearTimeout(t); olaylar.push('connect_error ' + e.message); res(); });
    });
    s.on('message:new', () => { alinan++; });
    s.onAny((ev, d) => {
      if (/error|limit|denied|forbid/i.test(ev)) olaylar.push(ev + ' ' + JSON.stringify(d).slice(0, 80));
    });
    s.emit('channel:join', cid);
    await sleep(1500);

    // ALICE SOKETLE gonderir (mesaj gonderimi REST degil, soket uzerinden).
    const icerik = 'worn-test-' + Date.now();
    const as = io(BASE, { auth: { token: FIX.alice }, transports: ['websocket'], reconnection: false, timeout: 20000 });
    await new Promise(r => { const t = setTimeout(r, 21000); as.once('userAuthenticated', () => { clearTimeout(t); r(); }); as.on('connect_error', () => { clearTimeout(t); r(); }); });
    as.emit('channel:join', cid);
    await sleep(800);
    as.emit('message:send', { channelId: cid, serverId: sid, content: icerik, ackId: 'w1' });
    const gonderim = { status: 'soket' };
    await sleep(2500);

    // Mesaj VERITABANINDA mi?
    const liste = await (await fetch(BASE + '/api/channels/' + cid + '/messages?limit=10', { headers: H })).json();
    const kayitli = Array.isArray(liste) ? liste.length : (liste?.messages?.length ?? -1);

    console.log(`gonderim yolu          : ${gonderim.status}`);
    console.log(`kanalda GORDUGU mesaj  : ${kayitli}   (REST ile okuma)`);
    console.log(`SOKET ile alinan       : ${alinan}   <-- gercek zamanli katman`);
    console.log(`soket olaylari         : ${olaylar.length ? olaylar.join(' | ') : 'yok'}`);
    console.log(`TANI: ${kayitli > 0 && alinan === 0
      ? 'MESAJ KAYITLI AMA YAYIN GELMEDI — gercek zamanli katman kusuru'
      : (alinan > 0 ? 'saglikli' : 'mesaj ne kaydedildi ne yayinlandi')}`);
    try { s.close(); as.close(); } catch { /* yoksay */ }
  }
  process.exit(0);
})().catch(e => { console.error('HATA', e.message, e.stack); process.exit(2); });
