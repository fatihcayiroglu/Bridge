// server/scripts/dependency-chaos.cjs
//
// BAGIMLILIK KAOS TESTI — REDIS ve NESNE DEPOSU
//
// ============================================================================
// NEDEN VAR
// ============================================================================
// `db-chaos.cjs` PostgreSQL kesintilerini kapsar. Redis ve nesne deposu (MinIO)
// icin esdeger bir kanit YOKTU — oysa ikisi de yapilandirildiginda HAZIRLIK
// (readiness) sozlesmesinin parcasidir:
//
//   routes/health.ts → REDIS_URL tanimliysa Redis erisilemezse /health/ready
//   503 DONMELIDIR. Aksi halde yuk dengeleyici, kume-duyarli degismezleri
//   (hiz siniri, ses/sahne kilitleri, SFU sahipligi) YERINE GETIREMEYEN bir
//   node'a trafik gonderir.
//
// Bu betik o sozlesmeyi GERCEK konteynerleri durdurup baslatarak dogrular.
//
// ============================================================================
// GUVENLIK
// ============================================================================
// · Yalnizca ADI ACIKCA VERILEN konteynerlere dokunur (--redis, --minio).
// · Kendi Bridge surecini AYRI bir portta baslatir; calisan bir kuruluma
//   dokunmaz.
// · Konteynerleri her durumda (hata dahil) yeniden baslatmaya calisir.
//
// ============================================================================
// OLCULEN SENARYOLAR
// ============================================================================
//   1. Saglikli taban cizgisi        → /health/ready 200 (pozitif kontrol)
//   2. Redis durdurulur              → /health/ready 503 (KAPALI BASARISIZ)
//   3. Redis durdurulmusken canlilik → /health/live 200 (surec YASIYOR)
//   4. Redis geri gelir              → /health/ready 200 (KURTARMA + sure)
//   5. Nesne deposu durdurulur       → /health/ready 503
//   6. Nesne deposu geri gelir       → /health/ready 200 (KURTARMA + sure)
//   7. Kesinti boyunca surec         → COKMEDI, yeniden baslatilmadi
//
// BEKLENTI: sistem ONGORULEBILIR bicimde basarisiz olur — askida kalmaz,
// sahte yesil vermez, kalici olarak cokmez.
//
// KULLANIM
//   node scripts/dependency-chaos.cjs --redis f18-redis --minio f18-minio
'use strict';

require('dotenv/config');
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
function argOf(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const REDIS_CONTAINER = argOf('--redis');
const MINIO_CONTAINER = argOf('--minio');
const PORT = Number(argOf('--port') || 3211);
const BASE = `http://127.0.0.1:${PORT}`;
const SRV  = path.join(__dirname, '..');

if (!REDIS_CONTAINER && !MINIO_CONTAINER) {
  console.error('En az bir konteyner verin: --redis <ad> ve/veya --minio <ad>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(...cmd) {
  const r = spawnSync('docker', cmd, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** Zaman asimli istek — ASKIDA KALMA da bir bulgudur, basarisizlik degil. */
async function req(pathname, timeoutMs = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(BASE + pathname, { signal: ac.signal });
    // GOVDE de okunur: 503 GORMEK yetmez, DOGRU SEBEPLE 503 gormek gerekir.
    // Kuresel hiz siniri da Redis yokken 503 doner; onu "hazirlik kapali
    // basarisiz oldu" sanmak, testin YANLIS SEBEPLE gecmesi olurdu.
    let body = null;
    try { body = await res.json(); } catch { /* govde JSON degil */ }
    return { status: res.status, ms: Date.now() - started, hung: false, body };
  } catch (err) {
    return {
      status: 0,
      ms: Date.now() - started,
      hung: String(err && err.name) === 'AbortError',
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Bir kosul saglanana kadar bekler; saglanmazsa null doner (askida kalmaz). */
async function waitFor(fn, budgetMs, stepMs = 400) {
  const deadline = Date.now() + budgetMs;
  const started = Date.now();
  while (Date.now() < deadline) {
    if (await fn()) return Date.now() - started;
    await sleep(stepMs);
  }
  return null;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

let child = null;
let childExited = null;

async function startServer() {
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    // Redis YAPILANDIRILMIS olmali: hazirlik sozlesmesi ancak o zaman gecerli.
    REDIS_URL: process.env.REDIS_URL,
    ALLOWED_ORIGINS: BASE,
    INSTANCE_URL: BASE,
  };
  child = spawn(process.execPath, [path.join(SRV, 'dist', 'index.js')], {
    env, cwd: SRV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  childExited = null;
  child.on('exit', (code, signal) => { childExited = { code, signal }; });
  // Gurultuyu yutma: cikti sadece hata ayiklama icin biriktirilir.
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  child.__log = log;

  const up = await waitFor(async () => (await req('/api/health/live', 4000)).status === 200, 60_000);
  if (up === null) {
    console.error('Sunucu ayaga kalkmadi. Son cikti:\n' + log.slice(-20).join(''));
    throw new Error('server did not start');
  }
  return up;
}

async function main() {
  console.log('== Bagimlilik kaos testi ==');
  console.log(`   redis=${REDIS_CONTAINER || '(atlandi)'} minio=${MINIO_CONTAINER || '(atlandi)'} port=${PORT}`);

  const bootMs = await startServer();
  console.log(`   sunucu hazir (${bootMs} ms)`);

  // 1. Saglikli taban cizgisi — POZITIF KONTROL.
  // Bu gecmezse sonraki 503'ler hicbir sey KANITLAMAZ: her sey zaten kirmizidir.
  {
    const ready = await req('/api/health/ready');
    record('1. saglikli taban cizgisi /health/ready = 200', ready.status === 200,
      `status=${ready.status} ${ready.ms}ms`);
  }

  if (REDIS_CONTAINER) {
    // 2. Redis durdurulur → hazirlik KAPALI BASARISIZ olmali.
    docker('stop', REDIS_CONTAINER);
    let readyBody = null;
    const wentUnready = await waitFor(async () => {
      const r = await req('/api/health/ready');
      readyBody = r.body;
      // Sebep dogrulamasi: govde HAZIRLIK kontrolunu gostermeli. Hiz
      // sinirlayicinin 503'u `{ error: 'Rate limit service ...' }` doner.
      return r.status === 503 && r.body && r.body.check === 'readiness';
    }, 30_000);
    record('2. Redis kapaliyken /health/ready = 503 (HAZIRLIK sebebiyle)', wentUnready !== null,
      wentUnready !== null
        ? `${wentUnready} ms icinde, check=${readyBody && readyBody.check}`
        : `30 sn icinde hazirlik-sebepli 503 donmedi (son govde: ${JSON.stringify(readyBody)})`);

    // 3. Canlilik AYRI kalmali: surec yasiyor, yalnizca trafik almamali.
    {
      const live = await req('/api/health/live');
      // CANLILIK bagimliliga BAGLI OLMAMALIDIR: 503 donerse orkestratör
      // konteyneri oldurur ve yeniden baslatma Redis'i onarmaz — gecici
      // bir arizanin filo capinda yeniden baslatma dongusune donusmesi.
      record('3. Redis kapaliyken /health/live = 200 (surec yasiyor)',
        live.status === 200 && live.body && live.body.check === 'liveness',
        `status=${live.status} check=${live.body && live.body.check} hung=${live.hung}`);
    }

    // 4. Redis geri gelir → KURTARMA (elle mudahale olmadan).
    docker('start', REDIS_CONTAINER);
    const recovered = await waitFor(async () => (await req('/api/health/ready')).status === 200, 90_000);
    record('4. Redis geri gelince /health/ready = 200 (kurtarma)', recovered !== null,
      recovered !== null ? `${recovered} ms icinde` : '90 sn icinde kurtarmadi');
  }

  if (MINIO_CONTAINER) {
    // ── ON KOSUL: NESNE DEPOSU GERCEKTEN YAPILANDIRILMIS OLMALI ────────────
    // Saglayici `CDN_PROVIDER` / `PRIVATE_STORAGE_PROVIDER` ile secilir ve
    // VARSAYILANI `local`dir. Yalnizca MINIO_* degiskenlerini vermek MinIO'yu
    // ETKINLESTIRMEZ; o durumda adaptor yerel diski kullanir ve MinIO'yu
    // durdurmak hazirligi HAKLI OLARAK etkilemez.
    //
    // Bunu "urun kusuru" saymak, testin YANLIS SEBEPLE dusmesi olurdu. Bu
    // yuzden kosulamayan senaryo ATLANIR ve nedeni ACIKCA yazilir — sessizce
    // yesil de, yaniltici kirmizi da uretilmez.
    const publicProvider  = (process.env.CDN_PROVIDER ?? 'local').toLowerCase();
    const privateProvider = (process.env.PRIVATE_STORAGE_PROVIDER ?? 'local').toLowerCase();
    if (publicProvider !== 'minio' && privateProvider !== 'minio') {
      console.log('SKIP  5-6. nesne deposu senaryolari — saglayici minio degil '
        + `(CDN_PROVIDER=${publicProvider}, PRIVATE_STORAGE_PROVIDER=${privateProvider}). `
        + 'Kosmak icin CDN_PROVIDER=minio verin.');
      return finish();
    }
    docker('stop', MINIO_CONTAINER);
    let storeBody = null;
    const wentUnready = await waitFor(async () => {
      const r = await req('/api/health/ready');
      storeBody = r.body;
      return r.status === 503 && r.body && r.body.check === 'readiness';
    }, 30_000);
    record('5. Nesne deposu kapaliyken /health/ready = 503 (HAZIRLIK sebebiyle)', wentUnready !== null,
      wentUnready !== null
        ? `${wentUnready} ms icinde`
        : `30 sn icinde hazirlik-sebepli 503 donmedi (son govde: ${JSON.stringify(storeBody)})`);

    docker('start', MINIO_CONTAINER);
    const recovered = await waitFor(async () => (await req('/api/health/ready')).status === 200, 90_000);
    record('6. Nesne deposu geri gelince /health/ready = 200 (kurtarma)', recovered !== null,
      recovered !== null ? `${recovered} ms icinde` : '90 sn icinde kurtarmadi');
  }

  return finish();
}

function finish() {
  // 7. Surec kesintiler boyunca AYAKTA kaldi mi?
  record('7. surec kesintiler boyunca cokmedi', childExited === null,
    childExited ? `cikis code=${childExited.code} signal=${childExited.signal}` : 'ayakta');

  const failed = results.filter((r) => !r.ok);
  console.log(`\n== Sonuc: ${results.length - failed.length}/${results.length} gecti ==`);
  if (failed.length) {
    console.log('Son sunucu ciktisi:\n' + ((child && child.__log) || []).slice(-25).join(''));
  }
  return failed.length === 0 ? 0 : 1;
}

let exitCode = 1;
main()
  .then((code) => { exitCode = code; })
  .catch((err) => { console.error('Kaos testi hatasi:', err && err.message); exitCode = 2; })
  .finally(() => {
    // Konteynerler HER DURUMDA geri getirilir; kaos testi ortami bozuk birakmaz.
    if (REDIS_CONTAINER) docker('start', REDIS_CONTAINER);
    if (MINIO_CONTAINER) docker('start', MINIO_CONTAINER);
    if (child && childExited === null) child.kill('SIGTERM');
    setTimeout(() => process.exit(exitCode), 1500);
  });
