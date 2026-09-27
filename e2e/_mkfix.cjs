// Yuk ornegi (3300) icin fikstur kullanicisi olusturur ve tokens.json yazar.
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:3300';
const UA = { 'Content-Type': 'application/json', Accept: 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36' };
(async () => {
  const out = {};
  for (const ad of ['alice', 'bob', 'carol']) {
    const u = `load_${ad}_${Date.now().toString(36)}`;
    const r = await fetch(BASE + '/api/register', { method: 'POST', headers: UA,
      body: JSON.stringify({ username: u, password: 'LoadPass123!' }) });
    const j = await r.json().catch(() => ({}));
    if (!j.token) { console.error('kayit basarisiz', ad, r.status, JSON.stringify(j).slice(0,120)); process.exit(2); }
    out[ad] = j.token;
  }
  fs.writeFileSync(__dirname + '/fixtures/tokens.json', JSON.stringify(out, null, 2));
  console.log('fikstur hazir:', Object.keys(out).join(', '));
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
