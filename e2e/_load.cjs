// e2e/_load.cjs
//
// FAZ 2 — GERÇEK YÜK KANITI (uydurma sayı YOK)
//
// ════════════════════════════════════════════════════════════════════════════
// NE ÖLÇÜLÜYOR
// ════════════════════════════════════════════════════════════════════════════
// Bridge'in temel sıcak yolu: bir kullanıcı mesaj gönderir, kanaldaki HERKES
// canlı olarak alır. Ölçülen şey uçtan uca FAN-OUT GECİKMESİDİR —
// `message:send` yayınından, BAŞKA bir istemcinin `message:new` almasına dek.
//
// Artan eşzamanlılıkta çalıştırılır ve her seviye için p50/p95/p99, verim ve
// KAYIP oranı basılır.
//
// ── KORUMALAR KAPATILMADI ─────────────────────────────────────────────────
// Anti-spam (`SPAM_CONFIG`) kullanıcı başına 4 saniyede 5 mesaja izin verir.
// Bu test o korumayı DEVRE DIŞI BIRAKMAZ; onun ALTINDA kalır: her sanal
// istemci AYRI bir kullanıcıdır ve kendi eşiğinin altında gönderir. Ölçülen
// şey böylece anti-spam eşiği değil, gerçek fan-out kapasitesidir.
//
// ── DÜRÜSTLÜK NOTLARI (bu bir kapasite TAAHHÜDÜ değildir) ─────────────────
// * Tek makine: istemci ve sunucu AYNI CPU'yu paylaşır. Yüksek eşzamanlılıkta
//   ölçülen gecikmenin bir kısmı İSTEMCİ tarafı yüktür.
// * Yerel Docker PostgreSQL/Redis — üretim donanımı değildir.
// * `MAX_WS_PER_IP` yalnızca ölçüm sürecinde yükseltilmiştir (tüm istemciler
//   127.0.0.1'den gelir); üretim varsayılanı değişmedi.
// * Sonuç bir ÜST SINIR değil, BU ORTAMDA ölçülmüş bir taban çizgisidir.

const fs = require('fs');
const io = require('socket.io-client');

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const UA = 'Mozilla/5.0 Chrome/120';
const LEVELS = (process.env.LEVELS || '10,25,50').split(',').map(Number);
const ROUND_MS = parseInt(process.env.ROUND_MS || '12000', 10);
// Anti-spam: 4 sn'de 5 mesaj. Kullanıcı başına 1 msg/2sn GÜVENLE altındadır.
const PER_USER_INTERVAL = parseInt(process.env.PER_USER_INTERVAL || '2000', 10);

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const FIX = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': UA };
  const c = (await (await fetch(BASE + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

function connect(tok) {
  return new Promise(res => {
    const s = io(BASE, { auth: { token: tok }, transports: ['websocket'], reconnection: false, timeout: 20000 });
    const t = setTimeout(() => { s.close(); res(null); }, 21000);
    // Ürünle AYNI sözleşme: hazır sinyali `userAuthenticated`tir.
    s.once('userAuthenticated', () => { clearTimeout(t); res(s); });
    s.on('connect_error', () => { clearTimeout(t); res(null); });
  });
}

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN;

async function runLevel(n, sid, cid) {
  const chosen = POOL.users.slice(0, n);
  const socks = [];
  for (const u of chosen) {
    const s = await connect(u.token);
    if (s) socks.push({ s, u });
  }
  if (socks.length < 2) {
    socks.forEach(x => x.s.close());
    return { n, connected: socks.length, error: 'YETERSIZ_BAGLANTI' };
  }

  for (const x of socks) x.s.emit('channel:join', cid);
  await sleep(2500);

  // Gözlemci: TEK bir alıcı üzerinden gecikme ölçülür. Diğer tüm soketler
  // odada durarak gerçek fan-out yükünü (N alıcıya dağıtım) üretir.
  const observer = socks[0].s;
  const lat = [];
  const pending = new Map();
  observer.on('message:new', m => {
    const key = String(m.content || '');
    const t0 = pending.get(key);
    if (t0 !== undefined) { lat.push(Date.now() - t0); pending.delete(key); }
  });

  // Gönderenler: gözlemci HARİÇ herkes, kendi anti-spam eşiğinin altında.
  const senders = socks.slice(1);
  let sent = 0;
  const t0all = Date.now();
  const stopAt = t0all + ROUND_MS;

  await Promise.all(senders.map(async (x, idx) => {
    await sleep((idx % 10) * 120);              // yayılım: eşzamanlı patlama olmasın
    while (Date.now() < stopAt) {
      const content = `load-${n}-${idx}-${sent++}-${Math.random().toString(36).slice(2, 7)}`;
      pending.set(content, Date.now());
      x.s.emit('message:send', { channelId: cid, serverId: sid, content, ackId: 'l' + Date.now() + idx });
      await sleep(PER_USER_INTERVAL);
    }
  }));

  await sleep(5000);                             // kuyruk boşaltma
  const lost = pending.size;
  const wallMs = Date.now() - t0all;

  socks.forEach(x => x.s.close());
  await sleep(500);

  const sorted = lat.slice().sort((a, b) => a - b);
  return {
    n, connected: socks.length, sent, delivered: lat.length, lost,
    p50: pct(sorted, 50), p95: pct(sorted, 95), p99: pct(sorted, 99),
    max: sorted[sorted.length - 1] ?? NaN,
    throughput: +(lat.length / (wallMs / 1000)).toFixed(1),
  };
}

(async () => {
  // Sunucu/kanal fikstur kullanicisiyla kurulur; havuz kullanicilari davetle katilir.
  const AH = await hdr(FIX.alice);
  const s = await (await fetch(BASE + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'Load ' + Date.now() }),
  })).json();
  const sid = s._id || s.id;
  const c = await (await fetch(BASE + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'load' + Date.now(), type: 'text' }),
  })).json();
  const cid = c._id || c.id;
  const iv = await (await fetch(BASE + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }),
  })).json();

  const maxN = Math.max(...LEVELS);
  let joined = 0;
  for (const u of POOL.users.slice(0, maxN)) {
    const H = await hdr(u.token);
    const r = await fetch(BASE + '/api/servers/invites/' + iv.code + '/use', { method: 'POST', headers: H, body: '{}' });
    if (r.ok) joined++;
  }
  console.log(`kanal=${cid}  havuz=${POOL.users.length}  katilan=${joined}  tur=${ROUND_MS}ms\n`);

  console.log('soket  bagli  gonder  teslim  kayip   p50    p95    p99    max   msg/sn');
  console.log('─'.repeat(72));

  const rows = [];
  for (const n of LEVELS) {
    const r = await runLevel(n, sid, cid);
    rows.push(r);
    if (r.error) { console.log(`${String(n).padStart(5)}  ${r.error}`); continue; }
    console.log(
      `${String(r.n).padStart(5)}  ${String(r.connected).padStart(5)}  ${String(r.sent).padStart(6)}  ` +
      `${String(r.delivered).padStart(6)}  ${String(r.lost).padStart(5)}  ${String(r.p50).padStart(5)}  ` +
      `${String(r.p95).padStart(5)}  ${String(r.p99).padStart(5)}  ${String(r.max).padStart(5)}  ` +
      `${String(r.throughput).padStart(6)}`,
    );
  }

  console.log('\n── DEGERLENDIRME ──');
  for (const r of rows) {
    if (r.error) { console.log(`${r.n}: ${r.error}`); continue; }
    const lossPct = r.sent ? ((r.lost / r.sent) * 100).toFixed(1) : 'n/a';
    console.log(`${String(r.n).padStart(3)} soket: kayip=%${lossPct}  p95=${r.p95}ms  verim=${r.throughput} msg/sn`);
  }
  process.exit(0);
})().catch(e => { console.error('HATA', e); process.exit(2); });
