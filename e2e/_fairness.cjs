// e2e/_fairness.cjs
//
// KIRACI ADALETI — SICAK TOPLULUK YANINDA NORMAL TOPLULUK
//
// ============================================================================
// SORU
// ============================================================================
// Tek bir buyuk/kotu davranan topluluk, ALAKASIZ kucuk bir toplulugun
// gecikmesini yok ediyor mu?
//
// Bu, toplam yuk testinden FARKLIDIR. Toplam yuk "kac kullanici" sorar;
// adalet testi "bir kiraci digerini ac birakabiliyor mu" sorar. Kuresel bir
// platform hedefi icin ikincisi daha belirleyicidir.
//
// ============================================================================
// TASARIM
// ============================================================================
//   TENANT A (SICAK)  : cok kullanici, yuksek mesaj hizi, tek kanal
//   TENANT B (NORMAL) : birkac kullanici, insani hiz, ayri sunucu/kanal
//
// Once B TEK BASINA olculur (taban cizgisi), sonra A calisirken B TEKRAR
// olculur. Fark, adalet kaybidir.
//
// ============================================================================
// DURUSTLUK
// ============================================================================
// Tek makinede kosar: A'nin yuku hem sunucuyu hem uretec surecini mesgul eder.
// Bu yuzden sonuc "Bridge adaletsiz" degil, "bu kurulumda B'nin gecikmesi
// su kadar bozuldu" olarak raporlanir.

const fs = require('fs');
const io = require('socket.io-client');

const BASE     = process.env.BASE || 'http://127.0.0.1:3300';
const HOT_N    = parseInt(process.env.HOT_N || '80', 10);
const NORM_N   = parseInt(process.env.NORM_N || '6', 10);
const ROUND_MS = parseInt(process.env.ROUND_MS || '15000', 10);
const HOT_MS   = parseInt(process.env.HOT_MS || '250', 10);   // sicak kiraci gonderim araligi
const NORM_MS  = parseInt(process.env.NORM_MS || '3000', 10); // normal kullanici araligi
// Havuz ofseti: onceki kosularda kullanilmis kullanicilardan kacinmak icin.
const OFFSET   = parseInt(process.env.OFFSET || '0', 10);

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const FIX  = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p / 100))] : NaN;

async function hdr(tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 Chrome/120' };
  const c = (await (await fetch(BASE + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

/** Sunucu + kanal kurar, verilen kullanicilari davetle katar. */
async function kiraciKur(ad, users) {
  const AH = await hdr(FIX.alice);
  const srv = await (await fetch(BASE + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: ad + ' ' + Date.now() }) })).json();
  const sid = srv._id || srv.id;
  const ch = await (await fetch(BASE + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'k' + Date.now(), type: 'text' }) })).json();
  const cid = ch._id || ch.id;
  const iv = await (await fetch(BASE + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }) })).json();
  const durumlar = {};
  for (const u of users) {
    const r = await fetch(BASE + '/api/servers/invites/' + iv.code + '/use',
      { method: 'POST', headers: await hdr(u.token), body: '{}' });
    durumlar[r.status] = (durumlar[r.status] || 0) + 1;
  }
  console.log(`  [${ad}] davet sonuclari:`, JSON.stringify(durumlar), ' kanal:', cid);
  return { sid, cid };
}

function baglan(users, cid) {
  return Promise.all(users.map(u => new Promise(res => {
    const s = io(BASE, { auth: { token: u.token }, transports: ['websocket'], reconnection: false, timeout: 20000 });
    const t = setTimeout(() => res(null), 21000);
    s.once('userAuthenticated', () => {
      clearTimeout(t);
      // KANALA KATILMA ilk yazimda ATLANMISTI: soketler odada olmadigi icin
      // hicbir `message:new` yayini gelmedi, olcum 0 teslim gosterdi ve
      // degerlendirme yine de "adalet korundu" dedi. Sifir ornekli bir
      // "basari" en tehlikeli sonuctur.
      s.emit('channel:join', cid);
      // GOZLEMCI KALICI: dinleyiciyi tur basina takip cikarmak ikinci turda
      // sessizce sifir teslim uretiyordu (kontrol kosusu HOT_N=0 ile
      // dogrulandi). Artik bir KEZ baglanir ve tur icinde yalnizca paylasilan
      // haritaya bakilir.
      s.__alinan = [];
      s.on('message:new', m => { s.__alinan.push({ k: String(m?.content || ''), t: Date.now() }); });
      res({ s, u });
    });
    s.on('connect_error', () => { clearTimeout(t); res(null); });
  }))).then(a => a.filter(Boolean));
}

/** Bir kiracida ROUND_MS boyunca gonderir ve TESLIM gecikmesini olcer. */
async function olc(socks, sid, cid, araMs, etiket) {
  const bekleyen = new Map();
  let gonderilen = 0;

  const gozlemci = socks[0].s;
  gozlemci.__alinan.length = 0;          // tur icin tamponu sifirla

  const timers = socks.map((x, i) => setInterval(() => {
    const icerik = `${etiket}-${i}-${gonderilen}-${Math.random().toString(36).slice(2, 6)}`;
    bekleyen.set(icerik, Date.now());
    gonderilen++;
    x.s.emit('message:send', { channelId: cid, serverId: sid, content: icerik, ackId: 'f' + gonderilen });
  }, araMs + (i % 11) * 40));

  await sleep(ROUND_MS);
  timers.forEach(clearInterval);
  await sleep(1500);

  const gecikme = [];
  for (const { k, t } of gozlemci.__alinan) {
    const t0 = bekleyen.get(k);
    if (t0 !== undefined) { gecikme.push(t - t0); bekleyen.delete(k); }
  }

  if (gecikme.length === 0) {
    console.log(`   [tani ${etiket}] ham=${gozlemci.__alinan.length} ` +
                `bagli=${socks.filter(x => x.s.connected).length}/${socks.length}`);
  }

  const sirali = gecikme.sort((a, b) => a - b);
  return {
    gonderilen, teslim: gecikme.length,
    kayip: gonderilen - gecikme.length,
    p50: pct(sirali, 50), p95: pct(sirali, 95), p99: pct(sirali, 99),
  };
}

const yaz = (ad, r) => console.log(
  ad.padEnd(30) + String(r.gonderilen).padEnd(9) + String(r.teslim).padEnd(9) +
  String(r.kayip).padEnd(8) + String(r.p50).padEnd(7) + String(r.p95).padEnd(8) + String(r.p99));

(async () => {
  const hotUsers  = POOL.users.slice(OFFSET, OFFSET + HOT_N);
  const normUsers = POOL.users.slice(OFFSET + HOT_N, OFFSET + HOT_N + NORM_N);
  if (normUsers.length < NORM_N) { console.error('Havuz yetersiz'); process.exit(2); }

  console.log(`SICAK kiraci: ${HOT_N} kullanici / ${HOT_MS}ms   NORMAL kiraci: ${NORM_N} kullanici / ${NORM_MS}ms`);
  console.log(`tur: ${ROUND_MS}ms\n`);

  const A = await kiraciKur('HotTenant', hotUsers);
  const B = await kiraciKur('NormalTenant', normUsers);

  const hotSocks  = await baglan(hotUsers, A.cid);
  const normSocks = await baglan(normUsers, B.cid);
  console.log(`bagli — sicak: ${hotSocks.length}/${HOT_N}  normal: ${normSocks.length}/${NORM_N}\n`);

  console.log('senaryo'.padEnd(30) + 'gonder   teslim   kayip   p50    p95     p99');
  console.log('─'.repeat(74));

  // ── 1) TABAN CIZGISI: normal kiraci YALNIZ ────────────────────────────────
  const taban = await olc(normSocks, B.sid, B.cid, NORM_MS, 'norm');
  yaz('NORMAL (yalniz)', taban);

  await sleep(2000);

  // ── 2) SICAK kiraci calisirken normal kiraci ─────────────────────────────
  const hotBekleyen = new Map();
  let hotGonderilen = 0;
  const hotTimers = hotSocks.map((x, i) => setInterval(() => {
    const icerik = `hot-${i}-${hotGonderilen}-${Math.random().toString(36).slice(2, 6)}`;
    hotBekleyen.set(icerik, Date.now());
    hotGonderilen++;
    if (hotBekleyen.size > 3000) {
      const ilk = hotBekleyen.keys().next().value;
      if (ilk !== undefined) hotBekleyen.delete(ilk);
    }
    x.s.emit('message:send', { channelId: A.cid, serverId: A.sid, content: icerik, ackId: 'h' + hotGonderilen });
  }, HOT_MS + (i % 13) * 20));

  await sleep(2500);                       // sicak kiraci ivmelensin
  const baski = await olc(normSocks, B.sid, B.cid, NORM_MS, 'norm2');
  hotTimers.forEach(clearInterval);
  yaz('NORMAL (sicak kiraci varken)', baski);
  console.log(`\nsicak kiraci bu surede ${hotGonderilen} mesaj gonderdi`);

  for (const x of [...hotSocks, ...normSocks]) { try { x.s.close(); } catch { /* yoksay */ } }

  // ── DEGERLENDIRME ────────────────────────────────────────────────────────
  const p95Artis = baski.p95 - taban.p95;
  const kayipArtis = (baski.kayip / Math.max(1, baski.gonderilen)) - (taban.kayip / Math.max(1, taban.gonderilen));
  console.log('\n── ADALET ──');
  console.log('normal kiraci p95 :', taban.p95, '→', baski.p95, 'ms  (', (p95Artis >= 0 ? '+' : '') + p95Artis, 'ms )');
  console.log('normal kiraci kayip:', '%' + (taban.kayip / Math.max(1, taban.gonderilen) * 100).toFixed(1),
    '→', '%' + (baski.kayip / Math.max(1, baski.gonderilen) * 100).toFixed(1));

  // GECERLILIK KAPISI: taban cizgisi hic teslim olcmediyse karsilastirma
  // ANLAMSIZDIR. Boyle bir kosuyu "adalet korundu" saymak, hicbir sey
  // olcmeden yesil rapor uretmek demektir.
  if (taban.teslim === 0 || baski.teslim === 0) {
    console.log('');
    console.log('SONUC: OLCUM GECERSIZ — taban veya baski turunde SIFIR teslim.');
    console.log('Adalet hakkinda hicbir iddia URETILMEZ.');
    process.exit(2);
  }

  const kotu = baski.p95 > taban.p95 * 5 + 200 || kayipArtis > 0.10;
  console.log(kotu
    ? '\nSONUC: ADALET KAYBI — sicak kiraci normal kiraciyi materyal olarak etkiledi.'
    : '\nSONUC: ADALET KORUNDU — normal kiraci sicak kiraci altinda kullanilabilir kaldi.');
  console.log('NOT: tek makine — sicak kiraci hem sunucuyu hem ureteci mesgul eder.');
  process.exit(kotu ? 1 : 0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
