// server/scripts/ws-limit-scaling.cjs
//
// BAGLANTI KABUL MALIYETI — OLCEKLENME PROFILI
//
// SORU: N eszamanli soket varken YENI bir baglantiyi kabul etmek kac islem
// gerektiriyor? Sabit mi, yoksa N ile mi buyuyor?
//
// Bu, kitlesel yeniden baglanma (deploy, ag kesintisi) senaryosunun
// belirleyicisidir: maliyet O(N) ise toplam firtina maliyeti O(N^2)'dir.
//
// Gercek middleware kaynagi derlenip olculur — kopya DEGIL.

const path = require('path');
require('ts-node/register/transpile-only');
process.env.MAX_WS_PER_IP = '100000';
process.env.MAX_UNAUTH_WS_PER_IP = '100000';
process.env.MAX_WS_PER_USER = '100000';

const { wsConnectionLimitMiddleware } =
  require(path.join(__dirname, '../socket/middleware/wsConnectionLimit.ts'));

/** Gercekci sahte soket — middleware'in dokundugu her alani tasir. */
function sahteSoket(i) {
  return {
    id: 's' + i,
    userId: undefined,
    handshake: {
      auth: { token: 'tok' + i },
      headers: {},
      address: '127.0.0.1',
      time: Date.now(),
    },
    once() {}, emit() {}, disconnect() {},
  };
}

function olc(N) {
  const harita = new Map();
  const io = { sockets: { sockets: harita } };
  const mw = wsConnectionLimitMiddleware(io);

  // N soketi RAMPA halinde ekle; her birini middleware'den gecir.
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const s = sahteSoket(i);
    mw(s, () => { harita.set(s.id, s); });
  }
  const t1 = process.hrtime.bigint();
  const toplamMs = Number(t1 - t0) / 1e6;

  // N doluyken TEK bir ek baglantinin maliyeti
  const ORNEK = 200;
  const t2 = process.hrtime.bigint();
  for (let k = 0; k < ORNEK; k++) {
    const s = sahteSoket(N + k);
    mw(s, () => {});
  }
  const t3 = process.hrtime.bigint();
  const tekUs = Number(t3 - t2) / 1e3 / ORNEK;

  return { N, toplamMs, tekUs };
}

console.log('BAGLANTI KABUL MALIYETI (gercek wsConnectionLimit middleware)\n');
console.log('N        rampa(ms)   N doluyken TEK kabul(us)   N basina');
console.log('─'.repeat(66));
const sonuc = [];
for (const N of [100, 250, 500, 1000, 2000]) {
  const r = olc(N);
  sonuc.push(r);
  console.log(
    String(r.N).padEnd(9) + r.toplamMs.toFixed(1).padEnd(12) +
    r.tekUs.toFixed(2).padEnd(27) + (r.tekUs / r.N * 1000).toFixed(3) + ' ns');
}

// OLCEKLENME SINIFI: tek kabul maliyeti N ile dogrusal buyuyorsa O(N).
const ilk = sonuc[0], son = sonuc[sonuc.length - 1];
const nKat = son.N / ilk.N;
const maliyetKat = son.tekUs / ilk.tekUs;
console.log('\n── OLCEKLENME ──');
console.log(`N ${ilk.N} → ${son.N} (${nKat}x) iken TEK kabul maliyeti ${maliyetKat.toFixed(1)}x`);
console.log(`rampa toplami: ${ilk.toplamMs.toFixed(1)}ms → ${son.toplamMs.toFixed(1)}ms ` +
            `(${(son.toplamMs / Math.max(ilk.toplamMs, 0.001)).toFixed(1)}x)`);
if (maliyetKat > nKat * 0.5) {
  console.log('\nSINIF: O(N) kabul basina  →  FIRTINA TOPLAMI O(N^2)');
  console.log('Kitlesel yeniden baglanmada bu, kabul yolunu olay dongusunde tikar.');
} else {
  console.log('\nSINIF: yaklasik SABIT kabul basina  →  firtina toplami O(N)');
}
