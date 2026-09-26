// e2e/_conndiag.cjs
//
// BAGLANTI REDDI TANISI
//
// SORU: 500 soket denendiginde neden yalnizca bir kismi baglaniyor?
// Reddedilenlerin GERCEK sebebini toplar — tahmin etmez.
//
// Socket.IO `connect_error` mesajlari middleware'in dondugu Error mesajidir
// (ornegin TOO_MANY_CONNECTIONS_FROM_IP). Ayrica zaman asimi, taşıma hatasi
// ve kimlik hatalari ayri ayri sayilir.

const fs = require('fs');
const io = require('socket.io-client');

const BASE  = process.env.BASE || 'http://127.0.0.1:3300';
const N     = parseInt(process.env.N || '500', 10);
const RAMP  = parseInt(process.env.RAMP_MS || '10', 10);  // soketler arasi gecikme
const TIMEOUT = parseInt(process.env.TIMEOUT_MS || '25000', 10);

const POOL = JSON.parse(fs.readFileSync(__dirname + '/fixtures/load-users.json', 'utf8'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const users = POOL.users.slice(0, N);
  console.log(`BAGLANTI TANISI  hedef=${N}  rampa=${RAMP}ms/soket  zamanasimi=${TIMEOUT}ms\n`);

  const sebepler = new Map();
  const say = k => sebepler.set(k, (sebepler.get(k) || 0) + 1);
  const socks = [];
  let basarili = 0;

  const t0 = Date.now();
  const isler = users.map((u, i) => new Promise(async res => {
    await sleep(i * RAMP);
    const s = io(BASE, {
      auth: { token: u.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: TIMEOUT,
    });
    const zamanlayici = setTimeout(() => { say('ZAMANASIMI (userAuthenticated gelmedi)'); try { s.close(); } catch {} res(); }, TIMEOUT);
    s.once('userAuthenticated', () => {
      clearTimeout(zamanlayici); basarili++; socks.push(s); res();
    });
    s.on('connect_error', e => {
      clearTimeout(zamanlayici);
      say('connect_error: ' + String(e && e.message || e).slice(0, 60));
      try { s.close(); } catch {}
      res();
    });
    s.on('error', e => { say('error: ' + String(e && e.message || e).slice(0, 60)); });
  }));

  await Promise.all(isler);
  const sure = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`BAGLANDI : ${basarili}/${N}   (${sure}s)`);
  console.log(`BASARISIZ: ${N - basarili}\n`);
  if (sebepler.size) {
    console.log('sebep dagilimi:');
    [...sebepler.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${k}`));
  } else {
    console.log('(hicbir hata sebebi kaydedilmedi)');
  }

  // Baglantilar hala AYAKTA mi? (kabul edilip sonra dusuruluyor olabilir)
  await sleep(3000);
  const ayakta = socks.filter(s => s.connected).length;
  console.log(`\n3sn sonra hala bagli: ${ayakta}/${basarili}`);
  socks.forEach(s => { try { s.close(); } catch {} });
  process.exit(0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
