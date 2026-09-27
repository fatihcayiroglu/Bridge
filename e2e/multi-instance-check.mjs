// e2e/multi-instance-check.mjs — R-1…R-7 dagitik dogrulama.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU BETIK VAR
// ════════════════════════════════════════════════════════════════════════════
// Redis anahtarlarinin var olmasi YATAY OLCEKLENEBILIRLIK KANITI DEGILDIR.
// Tek surecte `rl:*` ve `security:csrf:*` anahtarlarini gormek, iki AYRI
// surecin birbirinin durumunu gercekten paylastigini soylemez.
//
// Burada IKI gercek Bridge ornegi (A:3000, B:3010) ayni PostgreSQL ve ayni
// Redis'e baglidir. Her kontrol, bir tarafta yapilan islemin DIGER tarafta
// gorulup gorulmedigini olcer.
//
// Calistirma: e2e dizininden `node multi-instance-check.mjs`

import { io } from 'socket.io-client';

const A = process.env.INSTANCE_A || 'http://localhost:3000';
const B = process.env.INSTANCE_B || 'http://localhost:3010';

// Tarayici benzeri basliklar — bot filtresi (server/lib/captcha.ts) baslik
// tabanli skor uretir; Node'un ciplak `fetch`i esigi asar.
const H = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

const results = [];
const record = (id, name, pass, detail = '') => {
  results.push({ id, name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${id}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const rnd = () => Math.random().toString(36).slice(2, 10);

async function register(base) {
  const username = `mi_${rnd()}`;
  const res = await fetch(`${base}/api/register`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ username, email: `${username}@bridge-e2e.test`,
                           password: 'MultiInst123!', displayName: 'MI' }),
  });
  if (!res.ok) throw new Error(`register ${res.status}`);
  const body = await res.json();
  return { username, token: body.token || body.accessToken, id: body.user?._id || body.user?.id };
}

const openSocket = (base, token) => new Promise((resolve, reject) => {
  const s = io(base, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 10_000 });
  // `connect` YETMEZ: sunucu soket→kullanici eslemesini bir DB okumasindan
  // SONRA kurar ve bitince `userAuthenticated` yayar.
  s.once('connect', () => {
    const fb = setTimeout(() => resolve(s), 2_000);
    s.once('userAuthenticated', () => { clearTimeout(fb); resolve(s); });
  });
  s.once('connect_error', reject);
});

const waitFor = (socket, event, ms = 6_000) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  const handler = (payload) => { clearTimeout(timer); resolve(payload); };
  socket.once(event, handler);
});

async function main() {
  console.log(`A = ${A}\nB = ${B}\n`);

  const alice = await register(A);
  const bob   = await register(B);

  // ── R-1: SOCKET — A'daki kullanici, B uzerinden uretilen olayi alir ─────
  const sa = await openSocket(A, alice.token);
  const sb = await openSocket(B, bob.token);
  try {
    const incoming = waitFor(sa, 'dm:call:incoming');
    // DM cagrisi, iki kullanici arasinda sunucudan sunucuya yayilan kanonik
    // bir olaydir; adapter olmadan B'deki emit A'daki sokete ULASMAZ.
    sb.emit('dm:call:start', { toUserId: alice.id, type: 'voice' });
    const ring = await incoming;
    record('R-1', 'socket: B\'de uretilen olay A\'daki istemciye ulasti',
      Boolean(ring), ring ? `callId=${String(ring.callId).slice(0, 8)}…` : 'olay gelmedi');
    if (ring) sb.emit('dm:call:end', { callId: ring.callId });
  } finally {
    sa.disconnect(); sb.disconnect();
  }

  // ── R-3: RATE LIMIT — sayaclar paylasilir ──────────────────────────────
  // Ayni IP'den once A'ya, sonra B'ye istek atilir. Sayac paylasilmiyorsa
  // her ornek kendi penceresini tutar ve limit ETKIN OLARAK IKIYE KATLANIR.
  const probe = await register(A);
  const hit = async (base) => {
    const res = await fetch(`${base}/api/search?q=ab`, {
      headers: { ...H, Authorization: `Bearer ${probe.token}` },
    });
    return { status: res.status, remaining: res.headers.get('ratelimit-remaining') ?? res.headers.get('x-ratelimit-remaining') };
  };
  const first  = await hit(A);
  const second = await hit(B);
  const shared = first.remaining !== null && second.remaining !== null
    && Number(second.remaining) < Number(first.remaining);
  record('R-3', 'rate limit: sayac A ve B arasinda paylasiliyor', shared,
    `A.remaining=${first.remaining} → B.remaining=${second.remaining}`);

  // ── R-4: CSRF — A'da uretilen token B'de gecerli ────────────────────────
  const csrfRes = await fetch(`${A}/api/csrf-token`, {
    headers: { ...H, Authorization: `Bearer ${probe.token}` },
  });
  const csrfToken = (await csrfRes.json())?.token;
  const mutate = await fetch(`${B}/api/servers`, {
    method: 'POST',
    headers: { ...H, Authorization: `Bearer ${probe.token}`, 'X-CSRF-Token': String(csrfToken) },
    body: JSON.stringify({ name: `MI ${rnd()}` }),
  });
  // 403 = CSRF reddi (paylasim YOK). Diger her sonuc token'in kabul
  // edildigini gosterir; sunucu olusturma basarisi bu kontrolun konusu degil.
  record('R-4', 'csrf: A\'da uretilen token B\'de kabul edildi',
    csrfRes.ok && mutate.status !== 403, `csrf=${csrfRes.status} mutate=${mutate.status}`);

  // ── R-5: SESSION — A'da acilan oturum B'de gecerli ─────────────────────
  const meOnB = await fetch(`${B}/api/me`, {
    headers: { ...H, Authorization: `Bearer ${alice.token}` },
  });
  record('R-5', 'session: A\'da alinan token B\'de gecerli', meOnB.ok, `me=${meOnB.status}`);

  // ── R-6/R-7: RECONNECT — istemci DIGER ornege baglanip devam eder ──────
  const reA = await openSocket(A, alice.token);
  reA.disconnect();
  const reB = await openSocket(B, alice.token);
  try {
    const meAfter = await fetch(`${B}/api/me`, {
      headers: { ...H, Authorization: `Bearer ${alice.token}` },
    });
    record('R-6', 'reconnect: istemci diger ornege baglanabildi', reB.connected, `connected=${reB.connected}`);
    record('R-7', 'reconnect sonrasi oturum durumu korunuyor', meAfter.ok, `me=${meAfter.status}`);
  } finally {
    reB.disconnect();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error('HATA:', err.message); process.exit(1); });
