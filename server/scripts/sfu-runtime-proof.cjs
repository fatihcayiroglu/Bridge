// server/scripts/sfu-runtime-proof.cjs
//
// SFU GERCEK CALISMA ZAMANI KANITI
//
// ============================================================================
// NEDEN JEST DISINDA
// ============================================================================
// `server/package.json` icinde su esleme var:
//
//     moduleNameMapper: { "^mediasoup$": "<rootDir>/tests/__mocks__/mediasoup.ts" }
//
// Yani jest ortaminda mediasoup HER ZAMAN saplamadir; `jest.unmock` ve
// `jest.requireActual` bunu ASAMAZ (moduleNameMapper daha ustte calisir).
// Bu dogru bir tercihtir: birim testleri hizli ve deterministik kalir.
//
// Ama o yuzden "SFU calisiyor" iddiasi jest icinden KANITLANAMAZ. Bu betik
// DB kaosu ve yuk kanitlari gibi jest DISINDA calisir ve DERLENMIS URETIM
// KODUNU gercek mediasoup ile surer.
//
// ============================================================================
// KANITLANAN
// ============================================================================
//   • worker GERCEK bir alt surec (pid)
//   • router olusur ve codec yetenekleri doner
//   • WebRtcTransport gercek ICE adaylari + DTLS parmak izi uretir
//   • ODA IZOLASYONU: farkli kanal -> farkli router
//   • transport kimlik bilgileri BENZERSIZ
//   • temizlik kalici oda birakmaz
//   • 10/25/50/100 odada kapasite olcumu
//
// ============================================================================
// DURUSTLUK
// ============================================================================
// Bu TASIMA KATMANI kanitidir. Insan isitsel kalitesi DEGILDIR.

const path = require('path');
const SRV = path.join(__dirname, '..');

let mediasoup;
try { mediasoup = require('mediasoup'); }
catch { console.error('mediasoup kurulu degil — SFU_RUNTIME: NOT_PROVEN'); process.exit(3); }

const W = require(path.join(SRV, 'dist/socket/handlers/mediasoup/workers.js'));
const R = require(path.join(SRV, 'dist/socket/handlers/mediasoup/rooms.js'));

const sonuc = [];
function kaydet(ad, beklenen, gercek, ok, not = '') {
  sonuc.push({ ad, ok });
  console.log(`${ok ? 'OK  ' : 'HATA'} | ${ad.padEnd(46)} | ${String(gercek).padEnd(26)} ${not}`);
}

const mb = b => Math.round(b / 1048576);

(async () => {
  console.log('mediasoup surumu :', require(path.join(SRV, 'node_modules/mediasoup/package.json')).version);
  console.log('platform         :', process.platform, process.arch, '\n');

  // ── Worker ───────────────────────────────────────────────────────────────
  const t0 = Date.now();
  const basladi = await W.initMediasoup(mediasoup, undefined, 1);
  const initMs = Date.now() - t0;
  kaydet('worker havuzu baslatildi', 'true', basladi, basladi === true, `(${initMs}ms)`);
  kaydet('isSFUReady', 'true', W.isSFUReady(), W.isSFUReady() === true);

  const { worker, index } = W.getNextWorkerWithIndex();
  kaydet('worker GERCEK alt surec (pid)', 'sayi', worker.pid,
    typeof worker.pid === 'number' && worker.pid > 0);
  kaydet('round-robin gecerli indeks', '>=0', index, index >= 0);

  // ── Oda / router ─────────────────────────────────────────────────────────
  const oda1 = await R.getOrCreateRoom('ch-proof-1');
  kaydet('router olusturuldu', 'id', oda1.router.id.slice(0, 12) + '...',
    typeof oda1.router.id === 'string' && oda1.router.id.length > 10);
  kaydet('router codec yetenekleri', '>0', oda1.router.rtpCapabilities.codecs.length,
    oda1.router.rtpCapabilities.codecs.length > 0);

  const oda1b = await R.getOrCreateRoom('ch-proof-1');
  kaydet('ayni kanal AYNI oda', 'true', oda1b === oda1, oda1b === oda1);

  const oda2 = await R.getOrCreateRoom('ch-proof-2');
  kaydet('ODA IZOLASYONU (farkli router)', 'farkli',
    oda1.router.id === oda2.router.id ? 'AYNI' : 'FARKLI',
    oda1.router.id !== oda2.router.id);

  // ── Transport — gercek ICE/DTLS ──────────────────────────────────────────
  const tr1 = await R.createWebRtcTransport(oda1.router);
  kaydet('WebRtcTransport ICE adaylari', '>0', tr1.iceCandidates.length,
    tr1.iceCandidates.length > 0);
  kaydet('DTLS parmak izi', '>0', tr1.dtlsParameters.fingerprints.length,
    tr1.dtlsParameters.fingerprints.length > 0);
  kaydet('ICE ufrag mevcut', 'string', typeof tr1.iceParameters.usernameFragment,
    typeof tr1.iceParameters.usernameFragment === 'string');

  const tr2 = await R.createWebRtcTransport(oda1.router);
  kaydet('transport kimlik bilgileri BENZERSIZ', 'farkli',
    tr1.iceParameters.password === tr2.iceParameters.password ? 'AYNI' : 'FARKLI',
    tr1.iceParameters.password !== tr2.iceParameters.password);

  // ── Temizlik ─────────────────────────────────────────────────────────────
  R.cleanupRoom('ch-proof-1');
  R.cleanupRoom('ch-proof-2');
  kaydet('cleanupRoom odalari kaldirdi', '0',
    R.sfuRooms.size, R.sfuRooms.size === 0);

  const oncekiOda = R.sfuRooms.size;
  for (let i = 0; i < 50; i++) {
    await R.getOrCreateRoom('ch-cycle-' + i);
    R.cleanupRoom('ch-cycle-' + i);
  }
  kaydet('50 oda ac/kapa kalici oda birakmaz', '0',
    R.sfuRooms.size - oncekiOda, R.sfuRooms.size - oncekiOda === 0);

  // ── KAPASITE ─────────────────────────────────────────────────────────────
  console.log('\n── ODA KAPASITESI (gercek router + transport) ──');
  console.log('oda   router  transport  kurulum(ms)  RSS(MB)  worker RSS(MB)');
  console.log('─'.repeat(66));

  for (const N of [10, 25, 50, 100]) {
    const _basRss = mb(process.memoryUsage().rss);
    const t = Date.now();
    const odalar = [];
    let transportSayisi = 0;
    for (let i = 0; i < N; i++) {
      const o = await R.getOrCreateRoom(`cap-${N}-${i}`);
      odalar.push(`cap-${N}-${i}`);
      // Her odaya iki transport: gonderen + alan.
      await R.createWebRtcTransport(o.router);
      await R.createWebRtcTransport(o.router);
      transportSayisi += 2;
    }
    const sure = Date.now() - t;
    const rss = mb(process.memoryUsage().rss);
    let wRss = 'n/a';
    try {
      const u = await worker.getResourceUsage();
      wRss = u && typeof u.ru_maxrss === 'number' ? Math.round(u.ru_maxrss / 1024) : 'n/a';
    } catch { /* platformda yok */ }
    console.log(
      String(N).padEnd(6) + String(N).padEnd(8) + String(transportSayisi).padEnd(11) +
      String(sure).padEnd(13) + String(rss).padEnd(9) + String(wRss));
    for (const c of odalar) R.cleanupRoom(c);
  }

  // ── Kapanis ──────────────────────────────────────────────────────────────
  for (const w of W.sfuWorkers) { try { w.close(); } catch { /* yoksay */ } }

  const kotu = sonuc.filter(x => !x.ok);
  console.log('\n== SONUC ==');
  console.log(`${sonuc.length - kotu.length}/${sonuc.length} dogrulama gecti`);
  for (const k of kotu) console.log('  BASARISIZ:', k.ad);
  console.log(kotu.length ? 'SFU_RUNTIME: KISMI' : 'SFU_RUNTIME: PROVEN_LOCAL (tasima katmani)');
  console.log('NOT: insan isitsel kalitesi bu betikle KANITLANMAZ.');
  process.exit(kotu.length ? 1 : 0);
})().catch(e => { console.error('HATA', e && e.message, e && e.stack); process.exit(2); });
