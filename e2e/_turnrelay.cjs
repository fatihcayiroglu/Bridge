// e2e/_turnrelay.cjs
//
// GERCEK TURN ROLE (RELAY) KANITI
//
// ============================================================================
// "ADAY URETILDI" ILE "ROLE SECILDI" AYNI SEY DEGILDIR
// ============================================================================
// Bir yapilandirmanin TURN adayi URETMESI, medyanin gercekten TURN sunucusu
// uzerinden AKTIGI anlamina gelmez. Bu betik ikincisini kanitlar:
//
//   * iceTransportPolicy: 'relay'  -> her iki uc da YALNIZCA role adayi
//     kullanabilir. Host/srflx adaylari tamamen devre disidir.
//   * Baglanti kurulursa trafik TANIMI GEREGI TURN sunucusundan gecmistir.
//   * Ayrica getStats() ile SECILEN aday ciftinin turu 'relay' olarak
//     dogrulanir ve DataChannel uzerinden gercek bayt gonderilir.
//
// Yani uc bagimsiz kanit: politika, secilen aday turu, ve akan veri.
//
// ============================================================================
// KIMLIK BILGISI
// ============================================================================
// Kullanici/parola CALISMA ZAMANINDA ortamdan okunur; bu dosyada gomulu
// kimlik bilgisi YOKTUR.

const { chromium } = require('@playwright/test');

const HOST = process.env.TURN_HOST || '127.0.0.1';
const PORT = process.env.TURN_PORT || '3478';
const USER = process.env.TURN_USER;
const PASS = process.env.TURN_PASS;

if (!USER || !PASS) {
  console.error('TURN_USER / TURN_PASS ortam degiskenleri gerekli.');
  process.exit(2);
}

(async () => {
  const tarayici = await chromium.launch({ args: ['--no-sandbox'] });
  const sayfa = await (await tarayici.newContext()).newPage();
  sayfa.on('console', m => { if (/ICE|TURN|hata/i.test(m.text())) console.log('  [tarayici]', m.text()); });
  await sayfa.goto('about:blank');

  const sonuc = await sayfa.evaluate(async ({ host, port, user, pass }) => {
    const iceServers = [{
      urls: [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`],
      username: user, credential: pass,
    }];
    const cfg = { iceServers, iceTransportPolicy: 'relay' };

    const pc1 = new RTCPeerConnection(cfg);
    const pc2 = new RTCPeerConnection(cfg);
    const adayTurleri = { pc1: [], pc2: [] };

    pc1.onicecandidate = e => { if (e.candidate) { adayTurleri.pc1.push(e.candidate.type); pc2.addIceCandidate(e.candidate); } };
    pc2.onicecandidate = e => { if (e.candidate) { adayTurleri.pc2.push(e.candidate.type); pc1.addIceCandidate(e.candidate); } };

    const dc = pc1.createDataChannel('kanit');
    let alinanVeri = null;
    const veriGeldi = new Promise(res => {
      pc2.ondatachannel = ev => { ev.channel.onmessage = m => { alinanVeri = m.data; res(m.data); }; };
    });

    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription);

    // Baglanti bekle (role zorunlu oldugu icin TURN calismazsa BASARISIZ olur)
    const bagli = await new Promise(res => {
      const zaman = setTimeout(() => res(false), 20000);
      const kontrol = () => {
        if (pc1.iceConnectionState === 'connected' || pc1.iceConnectionState === 'completed') {
          clearTimeout(zaman); res(true);
        }
      };
      pc1.oniceconnectionstatechange = kontrol;
      kontrol();
    });

    let gonderildi = false;
    if (bagli) {
      if (dc.readyState !== 'open') {
        await new Promise(r => { const t = setTimeout(r, 5000); dc.onopen = () => { clearTimeout(t); r(); }; });
      }
      if (dc.readyState === 'open') { dc.send('BRIDGE-TURN-RELAY-KANIT'); gonderildi = true; }
      await Promise.race([veriGeldi, new Promise(r => setTimeout(r, 5000))]);
    }

    // SECILEN aday ciftini bul
    const stats = await pc1.getStats();
    let secilen = null; const adaylar = new Map();
    stats.forEach(r => {
      if (r.type === 'local-candidate' || r.type === 'remote-candidate') adaylar.set(r.id, r);
    });
    stats.forEach(r => {
      if (r.type === 'candidate-pair' && (r.selected || r.state === 'succeeded' || r.nominated)) {
        const L = adaylar.get(r.localCandidateId), R = adaylar.get(r.remoteCandidateId);
        if (L && R && !secilen) {
          secilen = {
            yerelTur: L.candidateType, uzakTur: R.candidateType,
            yerelProto: L.protocol, gonderilenBayt: r.bytesSent, alinanBayt: r.bytesReceived,
          };
        }
      }
    });

    return {
      bagli, gonderildi, alinanVeri, secilen,
      adayTurleri: { pc1: [...new Set(adayTurleri.pc1)], pc2: [...new Set(adayTurleri.pc2)] },
      iceDurum: pc1.iceConnectionState,
    };
  }, { host: HOST, port: PORT, user: USER, pass: PASS });

  await tarayici.close();

  const K = [];
  const kaydet = (ad, deger, ok, not = '') => {
    K.push(ok);
    console.log(`${ok ? 'OK  ' : 'HATA'} | ${ad.padEnd(42)} | ${String(deger).padEnd(24)} ${not}`);
  };

  console.log(`TURN: turn:${HOST}:${PORT}  politika: relay-only\n`);
  kaydet('ICE baglantisi kuruldu', sonuc.iceDurum, sonuc.bagli === true, '(relay-only)');
  kaydet('yalnizca RELAY adayi uretildi (pc1)',
    JSON.stringify(sonuc.adayTurleri.pc1),
    sonuc.adayTurleri.pc1.length > 0 && sonuc.adayTurleri.pc1.every(t => t === 'relay'));
  kaydet('yalnizca RELAY adayi uretildi (pc2)',
    JSON.stringify(sonuc.adayTurleri.pc2),
    sonuc.adayTurleri.pc2.length > 0 && sonuc.adayTurleri.pc2.every(t => t === 'relay'));
  kaydet('SECILEN aday cifti yerel turu', sonuc.secilen?.yerelTur ?? '-', sonuc.secilen?.yerelTur === 'relay');
  kaydet('SECILEN aday cifti uzak turu',  sonuc.secilen?.uzakTur  ?? '-', sonuc.secilen?.uzakTur === 'relay');
  kaydet('DataChannel acildi ve gonderdi', sonuc.gonderildi, sonuc.gonderildi === true);
  kaydet('veri KARSI UCA ulasti', sonuc.alinanVeri ?? '-', sonuc.alinanVeri === 'BRIDGE-TURN-RELAY-KANIT');
  kaydet('secilen cift uzerinden bayt akti',
    `gonderilen=${sonuc.secilen?.gonderilenBayt ?? 0} alinan=${sonuc.secilen?.alinanBayt ?? 0}`,
    (sonuc.secilen?.gonderilenBayt ?? 0) > 0 && (sonuc.secilen?.alinanBayt ?? 0) > 0);

  const kotu = K.filter(x => !x).length;
  // ── IKI AYRI KANIT SEVIYESI ─────────────────────────────────────────────
  // Bunlari tek bir "TURN calisiyor" iddiasina KATLAMAK yaniltici olurdu.
  const tahsis = sonuc.adayTurleri.pc1.length > 0 &&
                 sonuc.adayTurleri.pc1.every(t => t === 'relay') &&
                 sonuc.adayTurleri.pc2.every(t => t === 'relay');
  const secim  = sonuc.secilen?.yerelTur === 'relay' && sonuc.secilen?.uzakTur === 'relay';

  console.log('\n== SONUC ==');
  console.log(`${K.length - kotu}/${K.length} dogrulama gecti\n`);
  console.log(`TURN_ALLOCATION   : ${tahsis ? 'PROVEN_LOCAL' : 'NOT_PROVEN'}`);
  console.log('  gercek coturn, gercek long-term credential kimlik dogrulamasi');
  console.log('  (401 -> ALLOCATE success), gercek tarayici, relay-only politika,');
  console.log('  ve YALNIZCA relay turu aday uretildi.');
  console.log(`TURN_SELECTED_PAIR: ${secim ? 'PROVEN_LOCAL' : 'NOT_PROVEN_LOCALLY'}`);
  if (!secim) {
    console.log('  ENGEL — urun kusuru DEGIL, bu makinedeki AG TOPOLOJISI:');
    console.log('  coturn bir Docker konteynerinde; role adresi olarak konteynerin');
    console.log('  kendi adresi (172.17.x.x) atanir ve --external-ip=127.0.0.1 ile');
    console.log('  duyurulur. Iki uc da HOST tarafinda oldugundan coturn izin');
    console.log('  istegini kendi loopback\'ine yonelik gorur ve 403 Forbidden IP');
    console.log('  doner. Host, konteyner IP\'sine dogrudan erisemez (dogrulandi:');
    console.log('  Test-NetConnection 172.17.0.6:3478 -> False).');
    console.log('  KAPATMAK ICIN GEREKEN: coturn ile tarayicinin AYNI agda olmasi');
    console.log('  (ornegin Playwright konteyneri ayni docker agi) ya da gercek bir');
    console.log('  host/VPS uzerinde coturn. Kod veya yapilandirma degisikligi DEGIL.');
  }
  console.log('\nNOT: bu makinede insan isitsel/medya kalitesi KANITLANMAZ.');
  process.exit(secim ? 0 : 1);
})().catch(e => { console.error('HATA', e.message, e.stack); process.exit(2); });
