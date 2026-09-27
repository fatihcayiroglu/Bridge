// e2e/_3node.cjs
//
// DOMAIN 7 — ÜÇ DÜĞÜMLÜ FAN-OUT
//
// İki düğüm arasında fan-out zaten kanıtlandı. Üç düğüm daha sert bir
// sorudur: yayın gerçekten TÜM düğümlere dağılıyor mu, yoksa yalnızca
// çift yönlü bir eşleşme mi çalışıyordu?
//
// Altı yönün TAMAMI ölçülür: A→B, A→C, B→A, B→C, C→A, C→B.

const fs = require('fs');
const io = require('socket.io-client');

const T = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const NODES = { A: 'http://127.0.0.1:3000', B: 'http://127.0.0.1:3010', C: 'http://127.0.0.1:3050' };
const UA = 'Mozilla/5.0 Chrome/120';
const ROUNDS = parseInt(process.env.ROUNDS || '3', 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function hdr(base, tok) {
  const H = { Authorization: 'Bearer ' + tok, Accept: 'application/json', 'User-Agent': UA };
  const c = (await (await fetch(base + '/api/csrf-token', { headers: H })).json()).token || '';
  return { ...H, 'Content-Type': 'application/json', 'X-CSRF-Token': c };
}

function connect(base, tok) {
  return new Promise(res => {
    const s = io(base, { auth: { token: tok }, transports: ['websocket'], reconnection: false, timeout: 15000 });
    const t = setTimeout(() => res(null), 16000);
    s.once('userAuthenticated', () => { clearTimeout(t); res(s); });
    s.on('connect_error', () => { clearTimeout(t); res(null); });
  });
}

(async () => {
  for (const [k, url] of Object.entries(NODES)) {
    const r = await fetch(url + '/api/health').catch(() => null);
    if (!r || !r.ok) { console.log('DUGUM YOK:', k, url); process.exit(2); }
  }

  const AH = await hdr(NODES.A, T.alice);
  const srv = await (await fetch(NODES.A + '/api/servers', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: '3Node ' + Date.now() }),
  })).json();
  const sid = srv._id || srv.id;
  const ch = await (await fetch(NODES.A + '/api/servers/' + sid + '/channels', {
    method: 'POST', headers: AH, body: JSON.stringify({ name: 'n3-' + Date.now(), type: 'text' }),
  })).json();
  const cid = ch._id || ch.id;
  const iv = await (await fetch(NODES.A + '/api/servers/invites', {
    method: 'POST', headers: AH, body: JSON.stringify({ serverId: sid }),
  })).json();
  for (const u of ['bob', 'carol']) {
    await fetch(NODES.A + '/api/servers/invites/' + iv.code + '/use', {
      method: 'POST', headers: await hdr(NODES.A, T[u]), body: '{}',
    });
  }

  // Her dugumde bir istemci: A=alice, B=bob, C=carol
  const who = { A: 'alice', B: 'bob', C: 'carol' };
  const socks = {};
  for (const k of Object.keys(NODES)) {
    socks[k] = await connect(NODES[k], T[who[k]]);
    if (!socks[k]) { console.log('baglanti kurulamadi:', k); process.exit(2); }
    socks[k].emit('channel:join', cid);
  }
  await sleep(2500);

  const PAIRS = [['A', 'B'], ['A', 'C'], ['B', 'A'], ['B', 'C'], ['C', 'A'], ['C', 'B']];
  const results = {};
  let allOk = true;

  for (const [from, to] of PAIRS) {
    let ok = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const content = `n3-${from}${to}-${Math.random().toString(36).slice(2, 8)}`;
      const got = await new Promise(r => {
        const timer = setTimeout(() => r(false), 8000);
        const h = m => {
          if (String(m.content || '') === content) {
            clearTimeout(timer); socks[to].off('message:new', h); r(true);
          }
        };
        socks[to].on('message:new', h);
        socks[from].emit('message:send', { channelId: cid, serverId: sid, content, ackId: 'n' + Date.now() });
      });
      if (got) ok++;
      await sleep(300);
    }
    results[from + '->' + to] = ok;
    if (ok !== ROUNDS) allOk = false;
    console.log(`${from} -> ${to}   ${ok}/${ROUNDS}`);
  }

  for (const s of Object.values(socks)) s.close();

  console.log('\n── SONUC ──');
  console.log(allOk
    ? 'GECTI: uc dugum arasinda ALTI yonun tamami %100 teslim etti.'
    : 'DUSTU: en az bir yon kayip verdi.');
  process.exit(allOk ? 0 : 1);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
