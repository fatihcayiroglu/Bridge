// e2e/_loadprobe.cjs
//
// DARBOGAZ IZOLASYONU — SUNUCU MU, URETEC MI?
//
// ============================================================================
// NEDEN
// ============================================================================
// 500 sokette %56 mesaj kaybi ve p95=12.7s olculdu. Bu, Bridge'in kapasite
// tavani OLABILIR — ya da yuk URETECININ tavani olabilir.
//
// Ayrim onemlidir: 500 socket.io istemcisi TEK bir Node surecinde calisir ve
// her gonderim 500 alicıya dagilir. 15 saniyede ~2 milyon teslimat, TEK bir
// istemci olay dongusunde ayristirilir. Uretecin once doymasi beklenir.
//
// Bu betik yuk kosarken HER IKI surecin CPU'sunu ornekler. Sunucu rahatken
// uretec doymussa, sonuc "Bridge 500'de coker" DEGILDIR.

const { spawn, execSync } = require('child_process');
const path = require('path');

const BASE = process.env.BASE || 'http://127.0.0.1:3300';
const LEVEL = process.env.LEVEL || '500';
const PORT = new URL(BASE).port;

/** Belirtilen portu dinleyen surecin PID'i. */
function pidOfPort(p) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    for (const l of out.split('\n')) {
      if (l.includes(':' + p) && l.includes('LISTENING')) {
        return l.trim().split(/\s+/).pop();
      }
    }
  } catch { /* yoksay */ }
  return null;
}

/** Anlik CPU yuzdesi ve calisma kumesi (MB). */
function sample(pid) {
  try {
    const ps = execSync(
      `powershell -NoProfile -Command "$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){'{0};{1}' -f $p.CPU,[math]::Round($p.WorkingSet64/1MB,1)}"`,
      { encoding: 'utf8' },
    ).trim();
    const [cpu, rss] = ps.split(';');
    return { cpu: parseFloat(cpu), rssMb: parseFloat(rss) };
  } catch { return { cpu: NaN, rssMb: NaN }; }
}

(async () => {
  const serverPid = pidOfPort(PORT);
  if (!serverPid) { console.error('Sunucu PID bulunamadi (port ' + PORT + ')'); process.exit(2); }
  console.log('sunucu PID :', serverPid);

  const ilkSunucu = sample(serverPid);

  const child = spawn(process.execPath, ['_load.cjs'], {
    cwd: __dirname,
    env: { ...process.env, BASE, LEVELS: LEVEL, ROUND_MS: process.env.ROUND_MS || '15000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  console.log('uretec PID :', child.pid, '\n');

  let cikti = '';
  child.stdout.on('data', d => { cikti += d.toString(); });
  child.stderr.on('data', d => { cikti += d.toString(); });

  const ilkUretec = sample(child.pid);
  const ornekler = [];
  let sonGecerliUretec = ilkUretec;
  const t = setInterval(() => {
    const s = sample(serverPid);
    const u = sample(child.pid);
    // Uretec ornekleri surec olmeden ONCE toplanmali; en yuksek gecerli
    // degeri sakla (son ornek cocuk cikmis olabilecegi icin NaN gelir).
    if (!Number.isNaN(s.cpu)) ornekler.push({ s, u });
    if (!Number.isNaN(u.cpu)) sonGecerliUretec = u;
  }, 2000);

  await new Promise(res => child.on('exit', res));
  clearInterval(t);

  const sonSunucu = sample(serverPid);
  const sonUretec = sonGecerliUretec;

  const sunucuCpu = (sonSunucu.cpu - ilkSunucu.cpu);
  const uretecCpu = (sonUretec.cpu - ilkUretec.cpu);

  console.log(cikti.split('\n').filter(l => /soket|kayip|─|^\s*\d/.test(l)).join('\n'));
  console.log('\n── DARBOGAZ ──');
  console.log('sunucu CPU saniyesi :', sunucuCpu.toFixed(1), ' RSS:', sonSunucu.rssMb, 'MB');
  console.log('uretec CPU saniyesi :', uretecCpu.toFixed(1), ' RSS:', sonUretec.rssMb, 'MB');
  const oran = uretecCpu / (sunucuCpu || 1);
  console.log('uretec/sunucu orani :', oran.toFixed(2));
  console.log(oran > 1.5
    ? 'SONUC: URETEC daha cok CPU yakti — tavan buyuk olasilikla ISTEMCI tarafinda.'
    : oran < 0.67
      ? 'SONUC: SUNUCU daha cok CPU yakti — tavan sunucu tarafinda olabilir.'
      : 'SONUC: BENZER — tek makinede ikisi de doymus; ayrim net degil.');
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
