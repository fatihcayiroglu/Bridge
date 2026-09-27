// e2e/_load500.cjs
//
// 500 SOKET — GERCEKCI DAGILIM
//
// ============================================================================
// NEDEN AYRI BIR HARNESS
// ============================================================================
// Ilk 500 olcumu 500 soketin TEK kanalda olmasiyla yapildi. Orada her mesaj
// 500 sokete dagitilir; 3.893 mesaj ~1.9 MILYON soket teslimi demektir ve bu
// olayların tamami TEK bir Node uretec surecine dusr. Olculen %80.7 "kayip"
// bu yuzden sunucu hakkinda bir hukum DEGILDIR — uretecin doyma noktasi
// olabilir.
//
// Gercek dagitimlar boyle gorunmez: kullanicilar bircok kanala yayilir.
// Burada 500 soket KANALLARA bolunur, boylece mesaj basina dagitim kucuk ve
// olculen sey sunucunun isi olur.
//
// ============================================================================
// DURUSTLUK
// ============================================================================
// Uretec ve sunucu AYNI makinede. CPU saniyeleri ikisi icin de raporlanir;
// uretec doymussa bu acikca yazilir ve sonuc sunucuya YUKLENMEZ.

const fs = require('fs');
const { execSync } = require('child_process');
const io = require('socket.io-client');

const BASE     = process.env.BASE || 'http://127.0.0.1:3300';
const N        = parseInt(process.env.N || '500', 10);
const KANAL    = parseInt(process.env.CHANNELS || '10', 10);
const SEND_MS  = parseInt(process.env.SEND_MS || '5000', 10);
const SURE_MS  = parseInt(process.env.DURATION_MS || '45000', 10);
const RAMP_MS  = parseInt(process.env.RAMP_MS || '6', 10);
const PORT     = new URL(BASE).port;

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] : NaN;

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/120' };
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

(async () => {
  const sunucuPid = pidOfPort(PORT);
  const uretecPid = process.pid;
  const perKanal = Math.floor(N / KANAL);
  console.log(`500 SOKET / GERCEKCI DAGILIM`);
  console.log(`  soket=${N}  kanal=${KANAL}  kanal basina=${perKanal}  gonderim=${SEND_MS}ms  sure=${SURE_MS / 1000}s`);
  console.log(`  sunucuPID=${sunucuPid}  uretecPID=${uretecPid}\n`);

  // ── Kanallari kur ────────────────────────────────────────────────────────
  const AH = await hdr(FIX.alice);
  const gruplar = [];
  for (let g = 0; g < KANAL; g++) {
    const srv = await (await fetch(BASE + '/api/servers', {
      method: 'POST', headers: AH, body: JSON.stringify({ name: `L5-${g}-${Date.now()}` }) })).json();
    const sid = srv._id || srv.id;
    const ch = await (await fetch(BASE + '/api/servers/' + sid + '/channels', {
      method: 'POST', headers: AH, body: JSON.stringify({ name: 'c' + g + Date.now(), type: 'text' }) })).json();
    const cid = ch._id || ch.id;
    const iv = await (await fetch(BASE + '/api/servers/invites', {
      method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }) })).json();
    gruplar.push({ sid, cid, kod: iv.code, users: POOL.users.slice(g * perKanal, (g + 1) * perKanal) });
  }
  console.log(`${KANAL} kanal kuruldu; uyelikler ekleniyor...`);
  for (const g of gruplar) {
    for (const u of g.users) {
      await fetch(BASE + '/api/servers/invites/' + g.kod + '/use', { method: 'POST', headers: await hdr(u.token), body: '{}' });
    }
  }

  // ── Baglan ───────────────────────────────────────────────────────────────
  const bekleyen = new Map();          // icerik -> gonderim zamani
  const gecikmeler = [];
  let gonderilen = 0, teslim = 0, hata = 0;
  const hataOlay = {};

  const socks = [];
  let sira = 0;
  await Promise.all(gruplar.flatMap(g => g.users.map(u => (async () => {
    await sleep((sira++) * RAMP_MS);
    return new Promise(res => {
      const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, timeout: 25000 });
      const t = setTimeout(() => { hata++; res(); }, 26000);
      s.once('userAuthenticated', () => {
        clearTimeout(t);
        s.emit('channel:join', g.cid);
        s.__aldi = 0;
        s.on('message:new', m => {
          s.__aldi++;
          const k = String(m?.content || '');
          const t0 = bekleyen.get(k);
          if (t0 !== undefined) { gecikmeler.push(Date.now() - t0); teslim++; bekleyen.delete(k); }
        });
        s.on('error:ratelimit', d => { hataOlay['ratelimit:' + (d && d.event)] = (hataOlay['ratelimit:' + (d && d.event)] || 0) + 1; });
        s.on('error', d => { const k = 'error:' + String(JSON.stringify(d)).slice(0, 40); hataOlay[k] = (hataOlay[k] || 0) + 1; });
        socks.push({ s, g });
        res();
      });
      s.on('connect_error', () => { clearTimeout(t); hata++; res(); });
    });
  })())));

  console.log(`bagli=${socks.length}/${N}  hata=${hata}\n`);
  if (socks.length < N * 0.95) { console.error('YETERSIZ BAGLANTI — olcum yapilmaz'); process.exit(2); }

  await sleep(1500);

  // ── Yuk ──────────────────────────────────────────────────────────────────
  const cpu0s = procSample(sunucuPid), cpu0u = procSample(uretecPid);
  const t0 = Date.now();
  const timers = socks.map((x, i) => setInterval(() => {
    const icerik = `L5-${i}-${gonderilen}-${Math.random().toString(36).slice(2, 6)}`;
    bekleyen.set(icerik, Date.now());
    gonderilen++;
    if (bekleyen.size > 8000) { const f = bekleyen.keys().next().value; if (f !== undefined) bekleyen.delete(f); }
    x.s.emit('message:send', { channelId: x.g.cid, serverId: x.g.sid, content: icerik, ackId: 'L' + gonderilen });
  }, SEND_MS + (i % 23) * 37));

  await sleep(SURE_MS);
  timers.forEach(clearInterval);
  await sleep(4000);                    // kuyruktakiler insin
  const gecen = (Date.now() - t0) / 1000;

  const cpu1s = procSample(sunucuPid), cpu1u = procSample(uretecPid);
  const canli = socks.filter(x => x.s.connected).length;
  const sirali = [...gecikmeler].sort((a, b) => a - b);
  const kayip = gonderilen - teslim;

  console.log('soket  canli  gonder  teslim  kayip   p50    p95    p99    msg/sn');
  console.log('─'.repeat(70));
  console.log(
    String(N).padEnd(7) + String(canli).padEnd(7) + String(gonderilen).padEnd(8) +
    String(teslim).padEnd(8) + String(kayip).padEnd(8) +
    String(pct(sirali, 50)).padEnd(7) + String(pct(sirali, 95)).padEnd(7) +
    String(pct(sirali, 99)).padEnd(7) + (gonderilen / gecen).toFixed(1));

  const sCpu = (cpu1s.cpu - cpu0s.cpu), uCpu = (cpu1u.cpu - cpu0u.cpu);
  console.log('\n── KAYNAK ──');
  console.log(`sunucu CPU: ${sCpu.toFixed(1)}s  RSS: ${cpu1s.rssMb} MB`);
  console.log(`uretec CPU: ${uCpu.toFixed(1)}s  RSS: ${cpu1u.rssMb} MB`);
  console.log(`uretec/sunucu CPU orani: ${(uCpu / Math.max(sCpu, 0.1)).toFixed(2)}`);

  const kayipOran = gonderilen ? kayip / gonderilen : 1;
  console.log('\n── DEGERLENDIRME ──');
  console.log(`baglanti kararliligi: ${canli}/${N}`);
  console.log(`teslim kaybi        : %${(kayipOran * 100).toFixed(1)}`);
  if (uCpu > sCpu * 1.5) {
    console.log('UYARI: uretec sunucudan COK daha fazla CPU yakti — kayip URETEC kaynakli olabilir.');
  }
  const saglikli = canli >= N * 0.98 && kayipOran < 0.05;
  console.log(saglikli
    ? '\nSONUC: 500 SOKET SAGLIKLI (baglanti kararli, kayip %5 alti)'
    : '\nSONUC: 500 SOKET bu kurulumda SAGLIKLI DEGIL — yukaridaki kaynak satirlarina bakin');
  process.exit(saglikli ? 0 : 1);
})().catch(e => { console.error('HATA', e.message, e.stack); process.exit(2); });
