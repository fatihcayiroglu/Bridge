import { io } from 'socket.io-client';
const A = 'http://localhost:3000', B = 'http://localhost:3010';
const H = { 'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json', 'Accept-Language': 'en-US', 'Accept-Encoding': 'gzip', 'Connection': 'keep-alive' };
const rnd = () => Math.random().toString(36).slice(2, 10);
async function reg(base) {
  const u = `p2_${rnd()}`;
  const r = await fetch(`${base}/api/register`, { method: 'POST', headers: H,
    body: JSON.stringify({ username: u, email: `${u}@bridge-e2e.test`, password: 'ProbePass123!', displayName: 'P' }) });
  const b = await r.json();
  return { token: b.token || b.accessToken, id: b.user?._id || b.user?.id };
}
const open = (base, token, tag) => new Promise((res, rej) => {
  const s = io(base, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 10000 });
  s.onAny((ev, p) => console.log(`  [${tag}] <=`, ev, JSON.stringify(p ?? null).slice(0, 90)));
  s.once('connect', () => { const fb = setTimeout(() => res(s), 2000); s.once('userAuthenticated', () => { clearTimeout(fb); res(s); }); });
  s.once('connect_error', rej);
});
const alice = await reg(A), bob = await reg(B);
console.log('alice', alice.id, '\nbob  ', bob.id);
const sa = await open(A, alice.token, 'A/alice');
const sb = await open(B, bob.token,   'B/bob');
console.log('\n-- emit dm:call:start IMMEDIATELY (no delay) --');
sb.emit('dm:call:start', { toUserId: alice.id, type: 'voice' });
await new Promise(r => setTimeout(r, 6000));
console.log('\n-- emit dm:send --');
sb.emit('dm:send', { toUserId: alice.id, content: 'selam' });
await new Promise(r => setTimeout(r, 4000));
sa.disconnect(); sb.disconnect(); process.exit(0);
