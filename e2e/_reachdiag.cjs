// e2e/_reachdiag.cjs
//
// YAYIN ERISIMI TANISI
//
// SORU: bir kanaldaki N soketten KACI gercekten `message:new` aliyor?
//
// 500 soketlik olcumde teslim orani %17 cikti ama CPU doymamisti ve gecikme
// dusuktu. Bu, "yavas" degil "ULASMIYOR" demektir. Burada tek kanalda
// erisim DOGRUDAN sayilir: kac soket yayini aldi, kaci almadi.
//
// Ayrica sunucunun gonderene dondugu hata olaylari (`error:ratelimit`,
// `error`) da toplanir — sessiz reddi gorunur kilmak icin.

const fs = require('fs');
const io = require('socket.io-client');

const BASE   = process.env.BASE || 'http://127.0.0.1:3300';
const N      = parseInt(process.env.N || '50', 10);
const OFFSET = parseInt(process.env.OFFSET || '0', 10);
const MESAJ  = parseInt(process.env.MSGS || '5', 10);

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/120' };
  const c = (await (await fetch(BASE + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

(async () => {
  const users = POOL.users.slice(OFFSET, OFFSET + N);
  const AH = await hdr(FIX.alice);
  const srv = await (await fetch(BASE + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'Reach ' + Date.now() }) })).json();
  const sid = srv._id || srv.id;
  const ch = await (await fetch(BASE + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'r' + Date.now(), type: 'text' }) })).json();
  const cid = ch._id || ch.id;
  const iv = await (await fetch(BASE + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }) })).json();

  const davet = {};
  for (const u of users) {
    const r = await fetch(BASE + '/api/servers/invites/' + iv.code + '/use',
      { method: 'POST', headers: await hdr(u.token), body: '{}' });
    davet[r.status] = (davet[r.status] || 0) + 1;
  }
  console.log('davet sonuclari:', JSON.stringify(davet));

  const hatalar = {};
  const say = k => { hatalar[k] = (hatalar[k] || 0) + 1; };

  const socks = [];
  for (const u of users) {
    await new Promise(res => {
      const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, timeout: 20000 });
      const t = setTimeout(() => { say('baglanti zamanasimi'); res(); }, 21000);
      s.once('userAuthenticated', () => {
        clearTimeout(t);
        s.__aldi = 0;
        s.on('message:new', () => { s.__aldi++; });
        s.on('error:ratelimit', d => say('error:ratelimit ' + (d && d.event)));
        s.on('error', d => say('error ' + JSON.stringify(d).slice(0, 60)));
        socks.push(s);
        res();
      });
      s.on('connect_error', e => { clearTimeout(t); say('connect_error ' + String(e.message).slice(0, 40)); res(); });
    });
  }
  console.log(`bagli: ${socks.length}/${N}`);

  // ── KATILIM: her soket kanala katilir, ACK beklenir ──────────────────────
  socks.forEach(s => s.emit('channel:join', cid));
  await sleep(2500);

  // ── GONDERICI SAYISI degistirilebilir ───────────────────────────────────
  // TEK gonderen ile TUM soketler gonderdiginde davranis farkli mi?
  const GONDERICI = parseInt(process.env.SENDERS || '1', 10);
  const gonderenler = socks.slice(0, Math.min(GONDERICI, socks.length));
  console.log(`gonderici sayisi: ${gonderenler.length}`);

  let toplamGonderim = 0;
  const bekleyen = new Map();
  socks.forEach(s => s.on('message:new', m => {
    const k = String(m?.content || '');
    if (bekleyen.has(k)) bekleyen.delete(k);
  }));

  if (GONDERICI === 1) {
    for (let i = 0; i < MESAJ; i++) {
      const c = `reach-${i}-${Date.now()}`;
      bekleyen.set(c, 1); toplamGonderim++;
      socks[0].emit('message:send', { channelId: cid, serverId: sid, content: c, ackId: 'r' + i });
      await sleep(700);
    }
  } else {
    // Hepsi es zamanli, MESAJ tur boyunca 5sn araliklarla
    for (let tur = 0; tur < MESAJ; tur++) {
      gonderenler.forEach((s, j) => {
        const c = `reach-${tur}-${j}-${Math.random().toString(36).slice(2, 6)}`;
        bekleyen.set(c, 1); toplamGonderim++;
        s.emit('message:send', { channelId: cid, serverId: sid, content: c, ackId: `r${tur}_${j}` });
      });
      await sleep(5000);
    }
  }
  await sleep(3000);
  console.log(`GONDERILEN: ${toplamGonderim}  TESLIM EDILMEYEN: ${bekleyen.size}  ` +
              `teslim orani: %${(100 * (toplamGonderim - bekleyen.size) / Math.max(1, toplamGonderim)).toFixed(1)}`);

  const alan = socks.filter(s => s.__aldi > 0).length;
  const dagilim = {};
  socks.forEach(s => { dagilim[s.__aldi] = (dagilim[s.__aldi] || 0) + 1; });

  console.log(`\ngonderilen mesaj      : ${MESAJ}`);
  console.log(`EN AZ BIR mesaj alan  : ${alan}/${socks.length}`);
  console.log(`HIC almayan           : ${socks.length - alan}`);
  console.log('alinan mesaj sayisina gore soket dagilimi:', JSON.stringify(dagilim));
  console.log('hata olaylari         :', Object.keys(hatalar).length ? JSON.stringify(hatalar) : 'yok');

  socks.forEach(s => { try { s.close(); } catch { /* yoksay */ } });
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
