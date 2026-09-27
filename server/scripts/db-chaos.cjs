// server/scripts/db-chaos.cjs
//
// VERITABANI KAOS TESTI
//
// ============================================================================
// GUVENLIK
// ============================================================================
// AKTIF Bridge veritabanina DOKUNULMAZ. Bu betik:
//   • kendi TEK KULLANIMLIK veritabanini olusturur
//   • ona karsi AYRI bir Bridge sureci baslatir (ayri port)
//   • yalnizca O veritabaninin baglantilarini koparir
//     (pg_terminate_backend ... WHERE datname = <tek kullanimlik>)
//   • sonunda her seyi temizler
//
// ============================================================================
// OLCULEN SENARYOLAR
// ============================================================================
//   1. Saglikli taban cizgisi (pozitif kontrol)
//   2. Okuma sirasinda baglanti kopmasi
//   3. Yazma sirasinda baglanti kopmasi
//   4. Ifade zaman asimi
//   5. Havuz tukenmesi
//   6. Kesintiden sonra KURTARMA
//   7. Baslangicta veritabani YOK
//
// ============================================================================
// BEKLENTILER — Bridge SUNLARI YAPMAMALI
// ============================================================================
//   • sahte basari dondurmek (2xx ama veri yok)
//   • sonsuza kadar askida kalmak
//   • gecici hatadan sonra kalici olarak cokmek
//   • kurtarmadan sonra saglikli olmamak

require('dotenv/config');
const { Client } = require('pg');
const { spawn } = require('child_process');
const path = require('path');

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) { console.error('DATABASE_URL yok'); process.exit(2); }

const SUFFIX = Date.now().toString(36);
const DB     = `bridge_chaos_${SUFFIX}`;
const PORT   = 3210;
const BASE   = `http://127.0.0.1:${PORT}`;
const SRV    = path.join(__dirname, '..');

function dbUrl(name) {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + name;
  return u.toString();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Zaman asimli fetch — ASKIDA KALMA da bir bulgudur. */
async function req(pathname, opts = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const r = await fetch(BASE + pathname, { ...opts, signal: ac.signal });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - started, body: text.slice(0, 160), full: text };
  } catch (e) {
    return { status: e.name === 'AbortError' ? 'ASKIDA' : 'HATA', ms: Date.now() - started, body: String(e.message).slice(0, 120) };
  } finally { clearTimeout(t); }
}

async function waitHealthy(tries = 40) {
  for (let i = 0; i < tries; i++) {
    const r = await req('/api/health', {}, 3000);
    if (r.status === 200) return true;
    await sleep(700);
  }
  return false;
}

// ON KOSUL (olcum DEGIL): ilk acilis BOS veritabaninda semayi kurar. Final21 Faz 22'de olculdu:
// Windows + Docker PostgreSQL uzerinde 20–32 sn (sema kurulumu ~27 sn); eski 40 deneme (~28 sn)
// sinirdaydi ve kapi rastgele "Bridge ornegi baslamadi" diyordu. Acilis, surec OLENE ya da
// saglikli olana kadar beklenir (ust sinir 180 sn); olculen senaryolarin (ozellikle 6. KURTARMA,
// `waitHealthy(20)`) beklentileri DEGISMEDI.
async function waitStarted(proc, limitMs = 180_000) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    const r = await req('/api/health', {}, 3000);
    if (r.status === 200) return true;
    await sleep(700);
  }
  return false;
}

/** Yalnizca TEK KULLANIMLIK veritabaninin baglantilarini koparir. */
async function killConnections(admin, why) {
  const r = await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`, [DB]);
  console.log(`   [kaos] ${why}: ${r.rowCount} baglanti koparildi`);
}

const bulgular = [];
function kaydet(senaryo, beklenen, gercek, ok, not = '') {
  bulgular.push({ senaryo, beklenen, gercek, ok, not });
  console.log(`${ok ? 'OK  ' : 'BULGU'} | ${senaryo.padEnd(42)} | ${String(gercek).padEnd(26)} | ${not}`);
}

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  console.log('Tek kullanimlik veritabani:', DB, '\n');
  await admin.query(`CREATE DATABASE ${DB}`);

  let child = null;
  let childTail = '';
  const start = () => {
    child = spawn(process.execPath, ['dist/index.js'], {
      cwd: SRV,
      // YAZMA senaryolari (1b, 3, 3b, 6b) `/api/register` ile gercek bir satir yazar. Kayit kotalari
      // (RL_REGISTER_MAX 5/dk, MAX_REG_PER_HOUR 3/saat) IP basinadir ve PAYLASILAN Redis'tedir: ayni
      // saatte kosan e2e paketinin kayitlari kotayi doldurunca bu surec 429 aliyor ve VERITABANI
      // olcumu hiz sinirina takiliyordu (Final21 Faz 22, taze cikartma: "1b saglikli YAZMA -> 429").
      // Yalnizca BU olcum surecinde, e2e-server.js'deki gibi, verim kotalari yukseltilir; urun
      // varsayilanlari ve olculen senaryo beklentileri DEGISMEDI.
      env: {
        ...process.env, DATABASE_URL: dbUrl(DB), PORT: String(PORT), NODE_ENV: 'development',
        RL_REGISTER_MAX: '2000', MAX_REG_PER_HOUR: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Son 4 KB saklanir: acilamazsa NEDENI gorunsun (eskiden cikti atiliyordu).
    const keep = (d) => { childTail = (childTail + d).slice(-4096); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
  };

  try {
    start();
    const t0 = Date.now();
    const up = await waitStarted(child);
    if (!up) {
      console.error(`Bridge ornegi baslamadi (${Date.now() - t0} ms, surec cikis kodu: ${child.exitCode})`);
      console.error(childTail);
      throw new Error('baslatilamadi');
    }
    console.log(`Bridge ornegi hazir: ${Date.now() - t0} ms (bos veritabaninda sema kurulumu dahil)\n`);

    console.log('sonuc | senaryo'.padEnd(51) + '| gercek                     | not');
    console.log('-'.repeat(110));

    // ── 1. POZITIF KONTROL ───────────────────────────────────────────────
    const saglikli = await req('/api/health');
    kaydet('1. saglikli taban cizgisi', '200', saglikli.status, saglikli.status === 200,
      'pozitif kontrol');

    const kayit = () => req('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'kaos' + Math.random().toString(36).slice(2, 10), password: 'KaosParola123!' }),
    });
    const ilkKayit = await kayit();
    kaydet('1b. saglikli YAZMA', '2xx', ilkKayit.status,
      String(ilkKayit.status).startsWith('2'), 'gercek kalici yazma');

    // ── 2. OKUMA SIRASINDA BAGLANTI KOPMASI ──────────────────────────────
    await killConnections(admin, 'okuma oncesi');
    const okuma = await req('/api/health');
    kaydet('2. okumada baglanti kopmasi', '5xx veya 200 (yeniden baglanti)',
      okuma.status, okuma.status !== 'ASKIDA', okuma.status === 'ASKIDA' ? 'ASKIDA KALDI' : 'askida kalmadi');

    // ── 3. YAZMA SIRASINDA BAGLANTI KOPMASI ──────────────────────────────
    await killConnections(admin, 'yazma oncesi');
    const yazma = await kayit();
    const sahteBasari = String(yazma.status).startsWith('2');
    kaydet('3. yazmada baglanti kopmasi', '5xx (sahte basari YOK)', yazma.status,
      yazma.status !== 'ASKIDA', sahteBasari ? 'basarili gorundu — kaliciligi dogrulanacak' : '');

    // Sahte basari kontrolu: 2xx dondurduyse GERCEKTEN yazildi mi?
    if (sahteBasari) {
      let kullanici = {};
      try { kullanici = JSON.parse(yazma.full || '{}'); } catch { /* JSON degil */ }
      const ad = kullanici?.user?.username || kullanici?.username;
      if (ad) {
        const c = new Client({ connectionString: dbUrl(DB) });
        await c.connect();
        const r = await c.query('SELECT 1 FROM users WHERE username = $1', [ad]);
        await c.end();
        kaydet('3b. 2xx GERCEKTEN kalici mi', 'satir var', r.rowCount ? 'satir VAR' : 'SATIR YOK',
          r.rowCount > 0, r.rowCount ? '' : 'SAHTE BASARI — onaylandi ama yazilmadi');
      }
    }

    // ── 4. IFADE ZAMAN ASIMI ─────────────────────────────────────────────
    // Tek kullanimlik veritabaninda cok kisa bir statement_timeout uygula.
    await admin.query(`ALTER DATABASE ${DB} SET statement_timeout = '1ms'`);
    await killConnections(admin, 'zaman asimi ayari icin');
    // `/api/health` veritabanina GITMEYEBILIR; zaman asimini gercekten
    // sinamak icin KESIN olarak sorgu yapan bir uc kullanilir (kayit, users
    // tablosuna hem SELECT hem INSERT yapar).
    const zamanAsimi = await kayit();
    const zaSahte = String(zamanAsimi.status).startsWith('2');
    kaydet('4. ifade zaman asimi (DB’ye giden uc)', '5xx, askida kalmaz', zamanAsimi.status,
      zamanAsimi.status !== 'ASKIDA', zamanAsimi.ms + 'ms' + (zaSahte ? ' — kaliciligi dogrulanacak' : ''));

    // Zaman asimi altinda 2xx dondurduyse bu SAHTE BASARI olurdu.
    if (zaSahte) {
      let u = {};
      try { u = JSON.parse(zamanAsimi.full || '{}'); } catch { /* JSON degil */ }
      const ad = u?.user?.username || u?.username;
      if (ad) {
        await admin.query(`ALTER DATABASE ${DB} RESET statement_timeout`);
        const c = new Client({ connectionString: dbUrl(DB) });
        await c.connect();
        const r = await c.query('SELECT 1 FROM users WHERE username = $1', [ad]);
        await c.end();
        kaydet('4b. zaman asiminda 2xx GERCEKTEN kalici mi', 'satir var',
          r.rowCount ? 'satir VAR' : 'SATIR YOK', r.rowCount > 0,
          r.rowCount ? '' : 'SAHTE BASARI — onaylandi ama yazilmadi');
      }
    }
    await admin.query(`ALTER DATABASE ${DB} RESET statement_timeout`);
    await killConnections(admin, 'zaman asimi geri alindi');

    // ── 5. HAVUZ TUKENMESI (es zamanli istek firtinasi) ──────────────────
    const firtina = await Promise.all(Array.from({ length: 60 }, () => req('/api/health', {}, 10000)));
    const askida = firtina.filter(r => r.status === 'ASKIDA').length;
    const basarili = firtina.filter(r => r.status === 200).length;
    kaydet('5. es zamanli yuk (60 istek)', 'askida kalan yok',
      `${basarili} ok / ${askida} askida`, askida === 0, '');

    // ── 6. KURTARMA ──────────────────────────────────────────────────────
    await sleep(1500);
    const kurtarma = await waitHealthy(20);
    kaydet('6. kesintiden sonra KURTARMA', 'saglikli', kurtarma ? 'saglikli' : 'KURTARILAMADI', kurtarma,
      'surec hayatta mi: ' + (child.exitCode === null ? 'EVET' : 'HAYIR (' + child.exitCode + ')'));

    const kurtarmaYazma = await kayit();
    kaydet('6b. kurtarmadan sonra YAZMA', '2xx', kurtarmaYazma.status,
      String(kurtarmaYazma.status).startsWith('2'), '');

    // ── 7. BASLANGICTA VERITABANI YOK ────────────────────────────────────
    child.kill(); child = null;
    await sleep(1200);
    const olu = spawn(process.execPath, ['dist/index.js'], {
      cwd: SRV,
      env: { ...process.env, DATABASE_URL: dbUrl(DB).replace(/:(\d+)\//, ':59999/'), PORT: String(PORT + 1), NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Cikti yutulur; olcut CIKIS KODUDUR (askida mi kaldi, temiz mi cikti).
    olu.stdout.on('data', () => {});
    olu.stderr.on('data', () => {});
    const kod = await new Promise(res => {
      const t = setTimeout(() => { olu.kill(); res('ASKIDA'); }, 25000);
      olu.on('exit', c => { clearTimeout(t); res(c); });
    });
    kaydet('7. baslangicta DB yok', 'hizli ve acik cikis', 'exit=' + kod,
      kod !== 'ASKIDA', kod === 'ASKIDA' ? 'SESSIZCE ASKIDA KALDI' : 'temiz cikis');

  } finally {
    if (child) child.kill();
    await sleep(800);
    try { await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`); } catch { /* yoksay */ }
    await admin.end();
    console.log('\ntemizlendi:', DB);
  }

  const kotu = bulgular.filter(b => !b.ok);
  console.log('\n== SONUC ==');
  console.log(`${bulgular.length - kotu.length}/${bulgular.length} beklendigi gibi`);
  for (const b of kotu) console.log('  BULGU:', b.senaryo, '->', b.gercek, b.not);
  process.exit(kotu.length ? 1 : 0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
