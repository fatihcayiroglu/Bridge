// Arama bağlam önizlemesi — GERÇEK sunucuya karşı uçtan uca doğrulama.
// Kayıtlı iki kullanıcı, gerçek kanal, gerçek mesajlar, gerçek yetki.
//
// Mesajlar KANONİK yoldan gönderilir: `message:send` soket olayı. Bridge'in
// mesaj oluşturma için REST ucu YOKTUR; testin gerçek üretim yolunu
// kullanması şart, aksi halde indeksleme yolu doğrulanmamış olurdu.
import { io as ioc } from 'socket.io-client';

const A = 'http://localhost:3000';
const H = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json', 'Accept-Language': 'en-US', 'Accept-Encoding': 'gzip', 'Connection': 'keep-alive',
};
const rnd = () => Math.random().toString(36).slice(2, 10);
const out = [];
const rec = (name, pass, detail = '') => {
  out.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function reg() {
  const u = `ctx_${rnd()}`;
  const r = await fetch(`${A}/api/register`, { method: 'POST', headers: H,
    body: JSON.stringify({ username: u, email: `${u}@bridge-e2e.test`, password: 'CtxPass123!', displayName: `U-${u.slice(4)}` }) });
  const b = await r.json();
  return { token: b.token || b.accessToken, id: b.user?._id || b.user?.id, username: u };
}
async function csrf(token) {
  const r = await fetch(`${A}/api/csrf-token`, { headers: { ...H, Authorization: `Bearer ${token}` } });
  return (await r.json())?.token;
}
async function post(path, token, body) {
  const t = await csrf(token);
  const r = await fetch(`${A}${path}`, { method: 'POST',
    headers: { ...H, Authorization: `Bearer ${token}`, 'X-CSRF-Token': String(t) },
    body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const get = async (path, token) => {
  const r = await fetch(`${A}${path}`, { headers: { ...H, Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const alice = await reg();
const bob   = await reg();

// Sunucu + kanal
const srv = await post('/api/servers', alice.token, { name: `Ctx ${rnd()}` });
const serverId = srv.body?.server?._id || srv.body?._id;
const ch = await post(`/api/servers/${serverId}/channels`, alice.token, { name: 'genel', type: 'text' });
const channelId = ch.body?.channel?._id || ch.body?._id;
console.log(`server=${String(serverId).slice(0, 8)} channel=${String(channelId).slice(0, 8)}\n`);

// Beş mesaj — ortadaki benzersiz terimi taşır.
const TERM = `zebrakod${rnd()}`;
const lines = ['ilk mesaj burada', 'ikinci mesaj', `${TERM} tam ortada`, 'dorduncu mesaj', 'besinci mesaj'];

const sock = await new Promise((resolve, reject) => {
  const s = ioc(A, { auth: { token: alice.token }, transports: ['websocket'], reconnection: false, timeout: 10000 });
  s.once('connect', () => s.once('userAuthenticated', () => resolve(s)));
  s.once('connect_error', reject);
});
sock.emit('channel:join', { channelId, serverId });
await new Promise(r => setTimeout(r, 300));

for (const content of lines) {
  sock.emit('message:send', { channelId, serverId, content });
  await new Promise(res => setTimeout(res, 150));   // farkli createdAt + sira
}
await new Promise(r => setTimeout(r, 600));
sock.disconnect();

// 1) Arama isabeti
const s = await get(`/api/search/unified?q=${TERM}`, alice.token);
const hit = s.body?.results?.[0];
rec('arama isabeti bulundu', s.status === 200 && !!hit, `status=${s.status} n=${s.body?.results?.length ?? 0}`);
if (!hit) process.exit(1);

// 2) Bağlam
const c = await get(`/api/search/context?id=${hit._id}&source=channel&radius=2`, alice.token);
const msgs = c.body?.messages ?? [];
rec('baglam donuyor', c.status === 200 && msgs.length > 1, `status=${c.status} n=${msgs.length}`);
rec('capa isaretli ve TEK', msgs.filter(m => m.isAnchor).length === 1);
rec('capa DOGRU mesaj', msgs.find(m => m.isAnchor)?._id === hit._id);
rec('cevre mesajlar geldi', msgs.some(m => m.content === 'ikinci mesaj') && msgs.some(m => m.content === 'dorduncu mesaj'));
rec('ZAMAN sirasinda', JSON.stringify(msgs.map(m => m.createdAt)) === JSON.stringify([...msgs.map(m => m.createdAt)].sort((a, b) => a - b)));
rec('sunucu HTML URETMIYOR', !/<mark|<b>|<span/i.test(JSON.stringify(c.body)));

// 3) Yetki — Bob sunucunun ÜYESİ DEĞİL
const denied = await get(`/api/search/context?id=${hit._id}&source=channel&radius=2`, bob.token);
rec('UYE OLMAYAN baglam ALAMAZ', denied.status === 404, `status=${denied.status}`);
rec('reddedilen yanitta icerik YOK', !JSON.stringify(denied.body ?? {}).includes(TERM));

// 4) Girdi sözleşmesi
const badSource = await get(`/api/search/context?id=${hit._id}&source=admin`, alice.token);
rec('kaynak allowlist', badSource.status === 400, `status=${badSource.status}`);
const noId = await get('/api/search/context?source=channel', alice.token);
rec('kimlik zorunlu', noId.status === 400, `status=${noId.status}`);
const wide = await get(`/api/search/context?id=${hit._id}&source=channel&radius=9999`, alice.token);
rec('yaricap kelepceli', (wide.body?.messages?.length ?? 0) <= 11, `n=${wide.body?.messages?.length}`);

const failed = out.filter(x => !x).length;
console.log(`\n${out.length - failed}/${out.length} PASS`);
process.exit(failed ? 1 : 0);
