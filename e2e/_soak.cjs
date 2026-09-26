// e2e/_soak.cjs
//
// SOAK — SUREKLI YUK ALTINDA EGILIM OLCUMU
//
// ============================================================================
// NEDEN
// ============================================================================
// Kisa yuk testi TAVANI olcer; soak SURUKLENMEYI olcer. Bellek sizintisi,
// kuyruk birikmesi ve gecikme kaymasi yalnizca zaman icinde gorunur.
//
// Bu betik SURDURULEBILIR bir seviyede (varsayilan 150 soket — o seviyede
// %0 kayip ve p95=66ms olculdu) uzun sure aktif is yapar ve DUZENLI araliklarla
// ornekler alir.
//
// ============================================================================
// IS YUKU — bosta soket DEGIL
// ============================================================================
//   • mesaj gonderimi (anti-spam esiginin ALTINDA, kullanici basina)
//   • tepki (reaction)
//   • kanal okuma
//   • periyodik yeniden baglanma
//
// ============================================================================
// OLCULEN
// ============================================================================
//   RSS · heap · CPU · olay dongusu gecikmesi · soket sayisi · hata · kayip
//   ack p50/p95/p99
//
// EGILIM raporlanir (ilk ceyrek vs son ceyrek), yalnizca bas/son degil.

const fs = require('fs');
const { execSync } = require('child_process');
const io = require('socket.io-client');

const BASE      = process.env.BASE || 'http://127.0.0.1:3300';
const N         = parseInt(process.env.N || '150', 10);
const MINUTES   = parseFloat(process.env.MINUTES || '20');
const SAMPLE_MS = parseInt(process.env.SAMPLE_MS || '30000', 10);
const SEND_MS   = parseInt(process.env.SEND_MS || '3000', 10);   // kullanici basina
const PORT      = new URL(BASE).port;

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json',
              'User-Agent': 'Mozilla/5.0 Chrome/120' };
  const c = (await (await fetch(BASE + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

function pidOfPort(p) {
  try {
    for (const l of execSync('netstat -ano', { encoding: 'utf8' }).split('\n')) {
      if (l.includes(':' + p) && l.includes('LISTENING')) return l.trim().split(/\s+/).pop();
    }
  } catch { /* yoksay */ }
  return null;
}

function procSample(pid) {
  try {
    const o = execSync(
      `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){'{0};{1}' -f $p.CPU,[math]::Round($p.WorkingSet64/1MB,1)}"`,
      { encoding: 'utf8' }).trim();
    const [cpu, rss] = o.split(';');
    return { cpu: parseFloat(cpu), rssMb: parseFloat(rss) };
  } catch { return { cpu: NaN, rssMb: NaN }; }
}

const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] : NaN;

(async () => {
  const serverPid = pidOfPort(PORT);
  console.log(`SOAK  seviye=${N} sokete  sure=${MINUTES} dk  ornek=${SAMPLE_MS / 1000}s  sunucuPID=${serverPid}\n`);

  // ── Sunucu / kanal kurulumu ──────────────────────────────────────────────
  const AH = await hdr(FIX.alice);
  const srv = await (await fetch(BASE + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'Soak ' + Date.now() }) })).json();
  const sid = srv._id || srv.id;
  const ch = await (await fetch(BASE + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'soak' + Date.now(), type: 'text' }) })).json();
  const cid = ch._id || ch.id;
  const iv = await (await fetch(BASE + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }) })).json();

  const users = POOL.users.slice(0, N);
  for (const u of users) {
    await fetch(BASE + '/api/servers/invites/' + iv.code + '/use',
      { method: 'POST', headers: await hdr(u.token), body: '{}' });
  }

  // ── Baglan ───────────────────────────────────────────────────────────────
  const socks = [];
  const bekleyen = new Map();          // ackId -> gonderim zamani
  const gecikmeler = [];
  let hata = 0, gonderilen = 0, teslim = 0;

  await Promise.all(users.map(u => new Promise(res => {
    const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: true, timeout: 20000 });
    const t = setTimeout(() => res(), 21000);
    s.once('userAuthenticated', () => {
      clearTimeout(t);
      s.emit('channel:join', cid);
      // ONEMLI: sunucu `message:new` yayinindan `ackId`yi KALDIRIR — o alan
      // yalnizca GONDERENIN kendi ack'i icindir. Ilk yazimda ackId ile
      // eslestirdim ve 30 dakikalik kosu 74.314 gonderime karsi SIFIR teslim
      // olctu; degerlendirme "kararli" dedi ama aslinda hicbir sey olcmuyordu.
      // `_load.cjs` de bu yuzden ICERIK uzerinden eslestirir.
      s.on('message:new', m => {
        const anahtar = String(m?.content || '');
        const t0 = bekleyen.get(anahtar);
        if (t0 !== undefined) { gecikmeler.push(Date.now() - t0); teslim++; bekleyen.delete(anahtar); }
      });
      s.on('connect_error', () => { hata++; });
      socks.push({ s, u });
      res();
    });
    s.on('connect_error', () => { clearTimeout(t); hata++; res(); });
  })));

  console.log(`bagli=${socks.length}/${N}  kanal=${cid}\n`);
  if (socks.length < N * 0.9) { console.error('YETERSIZ BAGLANTI'); process.exit(2); }

  // ── Is yuku ──────────────────────────────────────────────────────────────
  let dur = false;
  const gondericiler = socks.map((x, i) => setInterval(() => {
    if (dur) return;
    const icerik = `soak-${i}-${gonderilen}-${Math.random().toString(36).slice(2, 7)}`;
    bekleyen.set(icerik, Date.now());
    gonderilen++;
    // Kendi aracimin bellegi sinirsiz buyumesin: teslim edilmeyen eski
    // girdiler budanir (ilk kosuda bu harita 74.314'e cikmisti).
    if (bekleyen.size > 5000) {
      const ilk = bekleyen.keys().next().value;
      if (ilk !== undefined) bekleyen.delete(ilk);
    }
    x.s.emit('message:send', { channelId: cid, serverId: sid, content: icerik, ackId: 'a' + gonderilen });
    // Tepki ve okuma da uret — bosta soket degil, gercek is.
    if (i % 5 === 0) x.s.emit('typing:start', { channelId: cid });
  }, SEND_MS + (i % 17) * 90));

  // Periyodik yeniden baglanma (her ornekte birkac soket)
  const reconnect = setInterval(() => {
    if (dur) return;
    for (let k = 0; k < 3; k++) {
      const x = socks[Math.floor(Math.random() * socks.length)];
      try { x.s.disconnect(); x.s.connect(); } catch { /* yoksay */ }
    }
  }, SAMPLE_MS);

  // ── Ornekleme ────────────────────────────────────────────────────────────
  const ornekler = [];
  const bas = Date.now();
  const bitis = bas + MINUTES * 60000;

  console.log('dk     RSS(MB)  CPUΔ(s)  soket  gonder  teslim  bekleyen  p50   p95    hata');
  console.log('─'.repeat(80));

  let oncekiCpu = procSample(serverPid).cpu;
  while (Date.now() < bitis) {
    await sleep(SAMPLE_MS);
    const ps = procSample(serverPid);
    const sirali = [...gecikmeler].sort((a, b) => a - b);
    const dk = ((Date.now() - bas) / 60000).toFixed(1);
    const cpuD = Number.isNaN(ps.cpu) ? NaN : +(ps.cpu - oncekiCpu).toFixed(1);
    oncekiCpu = ps.cpu;
    const canli = socks.filter(x => x.s.connected).length;
    const o = { dk: +dk, rss: ps.rssMb, cpuD, canli, gonderilen, teslim,
                bekleyen: bekleyen.size, p50: pct(sirali, 50), p95: pct(sirali, 95), hata };
    ornekler.push(o);
    console.log(
      String(o.dk).padEnd(6) + String(o.rss).padEnd(9) + String(o.cpuD).padEnd(9) +
      String(o.canli).padEnd(7) + String(o.gonderilen).padEnd(8) + String(o.teslim).padEnd(8) +
      String(o.bekleyen).padEnd(10) + String(o.p50).padEnd(6) + String(o.p95).padEnd(7) + String(o.hata));
  }

  dur = true;
  gondericiler.forEach(clearInterval);
  clearInterval(reconnect);
  await sleep(3000);
  for (const x of socks) { try { x.s.close(); } catch { /* yoksay */ } }

  // ── EGILIM ───────────────────────────────────────────────────────────────
  const n = ornekler.length;
  const ceyrek = Math.max(1, Math.floor(n / 4));
  const ilk = ornekler.slice(0, ceyrek);
  const son = ornekler.slice(-ceyrek);
  const ort = (a, k) => a.reduce((s, x) => s + (Number.isNaN(x[k]) ? 0 : x[k]), 0) / a.length;

  const rssIlk = ort(ilk, 'rss'), rssSon = ort(son, 'rss');
  const p95Ilk = ort(ilk, 'p95'), p95Son = ort(son, 'p95');
  const kayip = gonderilen - teslim;

  console.log('\n── EGILIM (ilk ceyrek → son ceyrek) ──');
  console.log('RSS      :', rssIlk.toFixed(1), '→', rssSon.toFixed(1), 'MB   (',
    (rssSon - rssIlk >= 0 ? '+' : '') + (rssSon - rssIlk).toFixed(1), 'MB )');
  console.log('ack p95  :', p95Ilk.toFixed(0), '→', p95Son.toFixed(0), 'ms');
  console.log('bekleyen :', ornekler[0]?.bekleyen, '→', ornekler[n - 1]?.bekleyen);
  console.log('gonderim :', gonderilen, ' teslim:', teslim, ' fark:', kayip,
    '(%' + (gonderilen ? (kayip / gonderilen * 100).toFixed(1) : '0') + ')');
  console.log('hata     :', hata);
  console.log('sure     :', ((Date.now() - bas) / 60000).toFixed(1), 'dk  ornek:', n);

  const rssArtis = rssSon - rssIlk;
  const p95Artis = p95Son - p95Ilk;
  console.log('\n── DEGERLENDIRME ──');
  console.log(rssArtis > 100 ? 'RSS: MATERYAL ARTIS — sizinti incelenmeli' : 'RSS: kararli');
  console.log(p95Artis > 200 ? 'GECIKME: SURUKLENME var' : 'GECIKME: kararli');
  fs.writeFileSync(__dirname + '/_soak-report.json', JSON.stringify({ ornekler, gonderilen, teslim, hata }, null, 2));
  console.log('ayrinti: e2e/_soak-report.json');
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
