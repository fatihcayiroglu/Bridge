// server/scripts/sfu-media-proof.cjs
//
// SFU MEDYA DUZLEMI KANITI — GERCEK RTP AKISI
//
// ============================================================================
// TRANSPORT KANITINDAN FARKI
// ============================================================================
// `sfu-runtime-proof.cjs` worker/router/transport'un GERCEK oldugunu kanitladi.
// Bu betik bir sonraki soruyu yanitlar:
//
//     SFU'DAN GERCEKTEN MEDYA GECIYOR MU?
//
// Yani: producer -> router -> consumer yolundan GERCEK RTP paketleri akiyor mu?
//
// ============================================================================
// NEDEN DirectTransport
// ============================================================================
// Tarayici olmadan gercek RTP uretmenin temiz yolu mediasoup'un
// `DirectTransport`udur: Node icinden `producer.send(rtpPaketi)` ile paket
// enjekte edilir ve `consumer.on('rtp')` ile router'in DIGER ucundan alinir.
//
// Boylece akis TAMAMEN gercek mediasoup router'indan gecer — sahte bir
// kopya veya mock degildir.
//
// ============================================================================
// DURUSTLUK
// ============================================================================
// Bu MAKINE duzeyinde medya duzlemi kanitidir:
//   • gercek RTP paketleri
//   • gercek router yonlendirmesi
//   • gercek consumer teslimi
// AMA insan isitsel kalitesi DEGILDIR. Sentetik Opus yuku kullanilir.

const path = require('path');
const SRV = path.join(__dirname, '..');

let mediasoup;
try { mediasoup = require('mediasoup'); }
catch { console.error('mediasoup kurulu degil — SFU_REAL_RTP: NOT_PROVEN'); process.exit(3); }

const sonuc = [];
const kaydet = (ad, gercek, ok, not = '') => {
  sonuc.push({ ad, ok });
  console.log(`${ok ? 'OK  ' : 'HATA'} | ${ad.padEnd(44)} | ${String(gercek).padEnd(22)} ${not}`);
};

const OPUS = {
  kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2,
  preferredPayloadType: 100,
};

/** Minimal ama GECERLI bir RTP paketi kurar (12 bayt basliK + yuk). */
function rtpPaketi(seq, ts, ssrc, payloadType = 100, yukBoyu = 80) {
  const b = Buffer.alloc(12 + yukBoyu);
  b[0] = 0x80;                       // V=2, P=0, X=0, CC=0
  b[1] = payloadType & 0x7f;         // M=0, PT
  b.writeUInt16BE(seq & 0xffff, 2);
  b.writeUInt32BE(ts >>> 0, 4);
  b.writeUInt32BE(ssrc >>> 0, 8);
  // Sentetik Opus yuku — deterministik, sessizlik benzeri.
  b.fill(0xfc, 12);
  return b;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('mediasoup :', require(path.join(SRV, 'node_modules/mediasoup/package.json')).version);
  console.log('platform  :', process.platform, process.arch, '\n');

  const worker = await mediasoup.createWorker({ logLevel: 'error', rtcMinPort: 41000, rtcMaxPort: 41200 });
  const router = await worker.createRouter({ mediaCodecs: [OPUS] });
  kaydet('router Opus ile hazir', router.rtpCapabilities.codecs.length + ' codec',
    router.rtpCapabilities.codecs.length > 0);

  // ── URETICI TARAFI ───────────────────────────────────────────────────────
  const sendTransport = await router.createDirectTransport();
  kaydet('DirectTransport (gonderen)', sendTransport.id.slice(0, 10) + '...', !!sendTransport.id);

  const SSRC = 111222;
  const producer = await sendTransport.produce({
    kind: 'audio',
    rtpParameters: {
      codecs: [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2, parameters: {} }],
      encodings: [{ ssrc: SSRC }],
    },
  });
  kaydet('PRODUCER olusturuldu', producer.id.slice(0, 10) + '...', !!producer.id);
  kaydet('producer kind', producer.kind, producer.kind === 'audio');

  // ── TUKETICI TARAFI ──────────────────────────────────────────────────────
  const recvTransport = await router.createDirectTransport();
  const consumer = await recvTransport.consume({
    producerId: producer.id,
    rtpCapabilities: router.rtpCapabilities,
  });
  kaydet('CONSUMER olusturuldu', consumer.id.slice(0, 10) + '...', !!consumer.id);
  kaydet('consumer producer’a bagli', consumer.producerId === producer.id,
    consumer.producerId === producer.id);
  // NOT: bu iddia DUZELTILDI. Ilk yazimda consumer'in baslangicta
  // `paused: true` olmasini bekledim — bu WebRTC consumer'lari icin yaygin
  // bir kalip, ama DirectTransport consumer'i varsayilan olarak DURAKLI
  // DEGILDIR. Yanlis olan urun degil, benim beklentimdi.
  // Anlamli olan sey duraklatma/devam etmenin GERCEKTEN calismasidir:
  await consumer.pause();
  kaydet('consumer duraklatilabiliyor', consumer.paused, consumer.paused === true);
  await consumer.resume();
  kaydet('consumer devam ettirilebiliyor', !consumer.paused, consumer.paused === false);

  // ── GERCEK RTP AKISI ─────────────────────────────────────────────────────
  let alinan = 0;
  let ilkAlinanMs = 0;
  const t0 = Date.now();
  consumer.on('rtp', () => {
    if (alinan === 0) ilkAlinanMs = Date.now() - t0;
    alinan++;
  });

  const GONDER = 200;
  for (let i = 0; i < GONDER; i++) {
    producer.send(rtpPaketi(i, i * 960, SSRC));
    if (i % 20 === 0) await sleep(2);      // gercekci tempo
  }
  await sleep(600);

  kaydet('RTP paketleri AKTI', `${alinan}/${GONDER}`, alinan > 0,
    alinan > 0 ? `(ilk paket ${ilkAlinanMs}ms)` : '');
  kaydet('teslim orani makul (>%50)',
    '%' + ((alinan / GONDER) * 100).toFixed(0), alinan / GONDER > 0.5);

  // ── ISTATISTIKLER ────────────────────────────────────────────────────────
  const pStats = await producer.getStats();
  const cStats = await consumer.getStats();
  const pByte = pStats[0]?.byteCount ?? 0;
  const cByte = (cStats.find(s => s.type === 'outbound-rtp') || cStats[0])?.byteCount ?? 0;
  kaydet('producer istatistigi bayt sayiyor', pByte, pByte > 0);
  kaydet('consumer istatistigi bayt sayiyor', cByte, cByte > 0);

  // ── IKINCI TUKETICI (cok aliciya dagitim) ────────────────────────────────
  const recv2 = await router.createDirectTransport();
  const consumer2 = await recv2.consume({ producerId: producer.id, rtpCapabilities: router.rtpCapabilities });
  await consumer2.resume();
  let alinan2 = 0;
  consumer2.on('rtp', () => { alinan2++; });
  for (let i = 0; i < 100; i++) producer.send(rtpPaketi(1000 + i, (1000 + i) * 960, SSRC));
  await sleep(600);
  kaydet('IKINCI consumer de RTP aliyor', alinan2, alinan2 > 0, '(fan-out)');

  // ── ODA IZOLASYONU (medya duzleminde) ────────────────────────────────────
  const router2 = await worker.createRouter({ mediaCodecs: [OPUS] });
  let capraz;
  try {
    const yabanciTransport = await router2.createDirectTransport();
    await yabanciTransport.consume({ producerId: producer.id, rtpCapabilities: router2.rtpCapabilities });
    capraz = true;                       // BASARILI OLMAMALI
  } catch { capraz = false; }
  kaydet('BASKA router producer’i tuketemez', capraz ? 'TUKETTI' : 'REDDEDILDI', !capraz,
    '(medya kiracı sınırı)');

  // ── KAPANIS YAYILIMI ─────────────────────────────────────────────────────
  let consumerKapandi = false;
  consumer.on('producerclose', () => { consumerKapandi = true; });
  producer.close();
  await sleep(300);
  kaydet('producer kapanisi consumer’a yayildi', consumerKapandi, consumerKapandi === true);

  // ── TEMIZLIK ─────────────────────────────────────────────────────────────
  await router2.close();
  await router.close();
  await worker.close();
  kaydet('temizlik tamam', 'kapandi', true);

  const kotu = sonuc.filter(x => !x.ok);
  console.log('\n== SONUC ==');
  console.log(`${sonuc.length - kotu.length}/${sonuc.length} dogrulama gecti`);
  for (const k of kotu) console.log('  BASARISIZ:', k.ad);
  console.log(kotu.length ? 'SFU_REAL_RTP: KISMI' : 'SFU_REAL_RTP: PROVEN_LOCAL');
  console.log('NOT: sentetik Opus yuku — insan isitsel kalitesi KANITLANMAZ.');
  process.exit(kotu.length ? 1 : 0);
})().catch(e => { console.error('HATA', e && e.message, '\n', e && e.stack); process.exit(2); });
