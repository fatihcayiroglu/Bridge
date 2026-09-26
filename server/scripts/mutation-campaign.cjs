// server/scripts/mutation-campaign.cjs
//
// ============================================================================
// MUTASYON KAMPANYASI — TESTLER GERCEKTEN KORUYOR MU?
// ============================================================================
// Gecen test sayisi bir sey KANITLAMAZ. Kanit sudur: urun kodunu bilerek
// BOZDUGUMUZDA testler BASARISIZ oluyor mu?
//
// Her mutasyon GERCEK bir guvenlik/dogruluk ozelligini tersine cevirir.
// Bir mutasyon HAYATTA KALIRSA (testler hala gecerse) o ozellik test EDILMIYOR
// demektir — bu, kirmizi bayraktir.
//
// ── SESSIZ BASARISIZLIGA KARSI ──────────────────────────────────────────────
// Aranan metin bulunamazsa mutasyon "gecti" SAYILMAZ; BULUNAMADI olarak
// raporlanir. Aksi halde kampanya hicbir sey yapmadan yesil gorunurdu —
// bu programda daha once tam olarak bu tuzaga dusuldu.
//
// KULLANIM: node scripts/mutation-campaign.cjs

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SRV = path.join(__dirname, '..');

// [dosya, aranan, yerine, aciklama, kosulacak test dosyalari]
const MUTASYONLAR = [
  // ── IP guven modeli (XFF sahtekarligi) ───────────────────────────────────
  ['lib/clientIp.ts', "if (raw === undefined || raw === '') return 0;", "if (raw === undefined || raw === '') return 1;",
    'XFF: varsayilan olarak proxy GUVENILIR sayilir (her istemci IP uydurabilir)',
    ['tests/client-ip-proxy-trust.test.ts']],
  ['lib/clientIp.ts', 'const idx = hops.length - trusted;', 'const idx = 0;',
    'XFF: SALDIRGANIN yazdigi en soldaki hop kullanilir',
    ['tests/client-ip-proxy-trust.test.ts']],
  ['lib/clientIp.ts', 'if (idx < 0) return socketIp(req);', 'if (idx < 0) return normalize(String(hops[0]));',
    'XFF: az hop varsa GUVENSIZ geri dusus (saldirgan degerine)',
    ['tests/client-ip-proxy-trust.test.ts']],

  // ── 2FA ──────────────────────────────────────────────────────────────────
  ['routes/twoFactor.ts', 'return crypto.timingSafeEqual(ab, bb);', 'return ab.equals(bb);',
    '2FA: yedek kod karsilastirmasi ZAMAN SIZDIRIR',
    ['tests/twofactor-backup-codes.test.ts']],
  ['routes/twoFactor.ts', "return crypto.createHash('sha256').update(code.trim(), 'utf8').digest('hex');", 'return code.trim();',
    '2FA: yedek kodlar DUZ METIN saklanir',
    ['tests/twofactor-backup-codes.test.ts']],
  ['routes/twoFactor.ts', 'const gecerli = await bcrypt.compare(password, String(user.password ?? \'\'));', 'const gecerli = true;',
    '2FA: devre disi birakmada PAROLA DOGRULANMAZ',
    ['tests/twofactor-disable-authz.test.ts']],
  ['routes/twoFactor.ts', 'crypto.randomBytes(8).toString(\'hex\')', 'Math.random().toString(16).slice(2, 10)',
    '2FA: yedek kodlar TAHMIN EDILEBILIR ureteciyle olusur',
    ['tests/twofactor-backup-codes.test.ts']],

  // ── Kimlik sahteciligi ───────────────────────────────────────────────────
  ['lib/displayName.ts', 'const MAX_COMBINING_RUN = 2;', 'const MAX_COMBINING_RUN = 9999;',
    'Kimlik: sinirsiz birlestirici isaret (Zalgo ile arayuz bozma)',
    ['tests/display-name-spoofing.test.ts']],
  ['lib/displayName.ts', 'export const DISPLAY_NAME_MAX = 32;', 'export const DISPLAY_NAME_MAX = 100000;',
    'Kimlik: goruntulenen ad uzunluk siniri kalkar',
    ['tests/display-name-spoofing.test.ts']],

  // ── Metrik ucnoktasi ─────────────────────────────────────────────────────
  ['middleware/metrics.ts', 'if (!sabitZamanliEsit(auth, `Bearer ${secret}`)) {', 'if (false) {',
    'Metrik: /metrics jetonu HIC dogrulanmaz',
    ['tests/metrics-endpoint-gating.test.ts']],
  ['middleware/metrics.ts', "const UNMATCHED_ROUTE = '<unmatched>';", "const UNMATCHED_ROUTE = '';",
    'Metrik: eslesmeyen rotalar SINIRSIZ etiket kardinalitesi uretir',
    ['tests/metrics-cardinality.test.ts']],

  // ── Push bildirimi acligi ────────────────────────────────────────────────
  ['lib/notifications.ts', 'const PUSH_MAX_WAIT_MS = 15_000;', 'const PUSH_MAX_WAIT_MS = Number.MAX_SAFE_INTEGER;',
    'Push: azami bekleme kalkar — surekli yazan sohbette bildirim ASLA gitmez',
    ['tests/push-backpressure.test.ts']],

  // ── FAZ 15-17 GARANTILERI ────────────────────────────────────────────────
  // Bunlarin hepsi bu programda OLCULEREK bulunmus kusurlardir. Mutant, kusuru
  // geri getirir: testler gecerse o duzeltme artik korunmuyor demektir.
  ['lib/storedText.ts',
    'if (record.contentFormat === RAW_TEXT_FORMAT) return typeof record.content === \'string\' ? record.content : \'\';',
    'if (false) return \'\';',
    'Kanal metni: HAM saklanan mesaj YINE entity cozumunden gecer (13 girdinin 10\'u bozulurdu)',
    ['tests/stored-text.test.ts', 'tests/message-mutations.test.ts']],

  ['lib/liveMembership.ts',
    "const CHANNEL_SCOPED_PREFIXES = new Set(['channel', 'voice', 'stage', 'canvas', 'draw', 'video-grid', 'watch']);",
    "const CHANNEL_SCOPED_PREFIXES = new Set(['channel', 'voice', 'stage', 'canvas', 'draw', 'video-grid']);",
    'Yetki iptali: `watch:` odalari kalir — gorulemeyen kanalin etkinlik sinyali sizmaya devam eder',
    ['tests/live-membership-eviction.test.ts']],

  ['lib/messageMutations.ts',
    "return { ok: false, code: 'AUTOMOD_UNAVAILABLE' };",
    "return { ok: true, message: null };",
    'Moderasyon: AutoMod degerlendirilemezse duzenleme SERBEST gecer (fail-open)',
    ['tests/message-mutations.test.ts']],

  ['db/repositories/MessageRepository.ts',
    'const query: Record<string,unknown> = { channelId, deletedAt: null };',
    'const query: Record<string,unknown> = { channelId };',
    'Silinen mesaj: kanal listesi tombstone satirlarini GERI getirir (yenilemede mesaj dirilir)',
    ['tests/message-repository-behavior.test.ts']],

  ['lib/serverLocale.ts',
    'return normalizeServerLocale(row?.locale);',
    'return DEFAULT_SERVER_LOCALE;',
    'Push dili: kisinin sakladigi dil YOK SAYILIR, herkese varsayilan dil yazilir',
    ['tests/server-locale.test.ts']],

  ['socket/handlers/infra.ts',
    "emit('typing:update', {",
    "emit('typing:start', {",
    'Yaziyor gostergesi: istemcinin DINLEMEDIGI olay yayilir (gosterge hic gorunmez)',
    ['tests/infra-handlers-behavior.test.ts']],

  // ── WS baglanti limiti / olceklenme ──────────────────────────────────────
  ['socket/middleware/wsConnectionLimit.ts', 'if (ipCount >= MAX_WS_PER_IP) {', 'if (false) {',
    'WS: IP basina baglanti limiti UYGULANMAZ',
    ['tests/ws-connection-limit.test.ts', 'tests/ws-limit-scaling.test.ts']],
  // Tek satirlik hedef: cok satirli desen bosluk farkindan tutmuyordu ve
  // BULUNAMADI olarak raporlanmisti (sessizce "gecti" sayilmadi).
  ['socket/middleware/wsConnectionLimit.ts',
    "return next(new Error('TOO_MANY_UNAUTH_CONNECTIONS_FROM_IP'));",
    '/* mutasyon: limit uygulanmaz */',
    'WS: kimliksiz baglanti limiti UYGULANMAZ (KUME/Redis dali)',
    // Bu dizge dosyada IKI kez gecer ve mutasyon ILKINI, yani REDIS_CONFIGURED dalini
    // bozar. Liste yalnizca YEREL dali olcen paketi adlandirdigi icin mutant HAYATTA
    // kaliyordu (Faz 17). Kume yolunun kendi paketi de kosulmalidir.
    ['tests/ws-connection-limit-shared.test.ts', 'tests/ws-connection-limit.test.ts']],
  ['socket/middleware/wsConnectionLimit.ts', 'if (ipToplam.has(ip) || ipKimliksiz.has(ip)) return;', 'return;',
    'WS: sayaclar gercek durumdan TOHUMLANMAZ (mevcut baglantilar sayilmaz)',
    ['tests/ws-limit-scaling.test.ts', 'tests/ws-connection-limit.test.ts']],

  // ── DB ayricalik denetimi ────────────────────────────────────────────────
  // NOT: onceki hedef yalnizca 'rolsuper' dizesiydi ve dosyadaki ILK esleşme
  // 10. satirdaki YORUMDU. Mutasyon hicbir davranisi degistirmiyordu; buna
  // ragmen "HAYATTA KALDI" olarak raporlandi. Bu bir test bosluğu DEGIL,
  // hatali hedeflemeydi — tek satirlik ve gercekten davranissal bir hedefe
  // cevrildi.
  ['lib/dbPrivilegeCheck.ts',
    'return bayraklar.filter(([k]) => role[k] === true).map(([, ad]) => ad);',
    'return [];',
    'DB: asiri yetki tespiti HICBIR SEY dondurmez (SUPERUSER fark edilmez)',
    ['tests/db-privilege-check.test.ts']],

  // ── Hesap silme: kişinin görünümü (Final21 Faz 19) ─────────────────────────
  ['lib/accountDeletion.ts', 'const snapshot = snapshotAssignments(rule.table, col, cols, 3);',
    "const snapshot = { sql: '', params: [] as Array<string | null> };",
    'Hesap silme: mesajlardaki ad/avatar anlik goruntusu BOSALTILMAZ',
    ['tests/account-route-behavior.test.ts']],
  ['lib/uploadRelease.ts', 'if (await hasLiveUploadReference(queryable, loc.canonicalKey)) { result.stillReferenced++; continue; }',
    'if (false as boolean) { result.stillReferenced++; continue; }',
    'Hesap silme: HALA BASVURULAN profil gorseli de silinir (fail-open)',
    ['tests/account-route-behavior.test.ts']],
  // Uretim mount'u: handler'in okudugu parametre yolda yoksa (moderation/categories/GIF/webhook/
  // uye profili sinifi) genel denetim KIRMIZI olmali.
  ['app/setupRoutes.ts', "mountApi('/servers/:serverId', serverMemberProfileRouter);",
    "mountApi('/servers', serverMemberProfileRouter);",
    'Rota: uye profili routeri :serverId OLMADAN bagli (404)',
    ['tests/route-mount-params-contract.test.ts']],
  // Kapanis: Socket.IO kapatilmazsa bagli istemci HTTP kapanisini engeller (Final21 Faz 19).
  ['lib/gracefulShutdown.ts', '    deps.io.close((err?: Error) => {',
    '    ((_cb: (err?: Error) => void) => undefined)((err?: Error) => {',
    'Kapanis: soketler kapatilmaz, surec zorlamaya (kod 1) duser',
    ['tests/graceful-shutdown-live-sockets.test.ts']],
  // PostgreSQL BIGINT: surucu METIN dondurur; tipler/OpenAPI/test deposu SAYI modeller (Final21 Faz 19, 19-27).
  ['db/postgres/pool.ts', '  return Number.isSafeInteger(n) ? n : value;',
    '  return value;',
    'BIGINT yeniden METIN: gecmis imleci 400, grup DM saatleri "Invalid Date"',
    ['tests/pg-int8-parser.test.ts']],
  // Kanal gecmisi imleci: ts HER ZAMAN sayi yazilir (Final21 Faz 19, 19-27).
  ['routes/messages.ts', 'prevCursor = Buffer.from(JSON.stringify({ ts: Number(oldest.createdAt),',
    'prevCursor = Buffer.from(JSON.stringify({ ts: oldest.createdAt,',
    'Imlec METIN ts tasir: PostgreSQL\'de geri sayfalama 400',
    ['tests/message-history-cursor.test.ts']],
];

// ── ASILI KALMAYA KARSI ─────────────────────────────────────────────────────
// Ilk kosuda `PUSH_MAX_WAIT_MS = MAX_SAFE_INTEGER` mutasyonu jest'i ASILI
// biraktir: mutasyon hicbir zaman atesenmeyen bir zamanlayici yaratti, jest
// acik tutamac yuzunden cikmadi ve kampanya 20+ dakika o mutasyonda kilitli
// kaldi — kaynak agaci da o sure boyunca MUTASYONLU kaldi.
//
// Iki onlem: `--forceExit` (testler bitince tutamaclara ragmen cik) ve
// spawnSync zaman asimi (mutlak ust sinir). Zaman asimi SESSIZCE "gecti"
// sayilmaz; ayri bir sonuc turu olarak raporlanir.
const TEST_ZAMAN_ASIMI_MS = 120_000;

// Final21 Faz 22 (19-41): jest DOGRUDAN `node <jest/bin/jest.js>` ile baslatilir. Eskiden
// `npx` + Windows'ta `shell: true` kullaniliyordu; zaman asiminda SIGKILL yalnizca KABUGU
// olduruyordu, Windows alt surecleri oldurmedigi icin ASILI jest (~1.9 GB) kampanyadan sonra
// da yasiyordu (olculdu: iki yetim surec, makinede bellek tukenmesi — istemci kapsam kapisi
// "Zone Allocation failed" ile dustu). Kabuk olmadan zaman asimi dogrudan asili sureci oldurur.
const JEST_BIN = require.resolve('jest/bin/jest', { paths: [SRV] });

function testKos(dosyalar) {
  const r = spawnSync(process.execPath, [JEST_BIN, ...dosyalar, '--silent', '--ci', '--forceExit'],
    { cwd: SRV, encoding: 'utf8',
      timeout: TEST_ZAMAN_ASIMI_MS, killSignal: 'SIGKILL' });
  const cikti = (r.stdout || '') + (r.stderr || '');
  const m = cikti.match(/Tests:\s+(?:(\d+) failed,\s+)?.*?(\d+) passed/);
  return {
    basarisiz: m && m[1] ? parseInt(m[1], 10) : 0,
    kod: r.status,
    zamanAsimi: Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.signal === 'SIGKILL',
    cikti,
  };
}

(async () => {
  console.log('MUTASYON KAMPANYASI\n');
  console.log(`${MUTASYONLAR.length} mutasyon — her biri GERCEK bir ozelligi tersine cevirir.\n`);

  const oldurulen = [], hayatta = [], bulunamadi = [];

  const BAS = parseInt(process.env.MUT_START || '0', 10);
  const SON = parseInt(process.env.MUT_END || String(MUTASYONLAR.length), 10);
  for (let i = BAS; i < Math.min(SON, MUTASYONLAR.length); i++) {
    const [dosya, aranan, yerine, aciklama, testler] = MUTASYONLAR[i];
    const tam = path.join(SRV, dosya);
    const orijinal = fs.readFileSync(tam, 'utf8');

    if (!orijinal.includes(aranan)) {
      bulunamadi.push({ dosya, aciklama });
      console.log(`${String(i + 1).padStart(2)}. BULUNAMADI  ${aciklama}`);
      console.log(`    ${dosya} icinde aranan metin YOK — mutasyon uygulanmadi.`);
      continue;
    }

    fs.writeFileSync(tam, orijinal.replace(aranan, yerine));
    let sonuc;
    try { sonuc = testKos(testler); }
    finally { fs.writeFileSync(tam, orijinal); }   // HER durumda geri yukle

    if (sonuc.zamanAsimi) {
      // Asilma da bir FARK sinyalidir ama temiz bir "test basarisiz" degildir;
      // ayri raporlanir ki gercek kapsama ile karistirilmasin.
      oldurulen.push(aciklama + '  [ZAMAN ASIMI]');
      console.log(`${String(i + 1).padStart(2)}. ZAMAN ASIMI ${aciklama}`);
      console.log(`    -> mutasyon testleri ASILI biraktı (${TEST_ZAMAN_ASIMI_MS / 1000}s); fark tespit edildi`);
    } else if (sonuc.basarisiz > 0 || sonuc.kod !== 0) {
      oldurulen.push(aciklama);
      console.log(`${String(i + 1).padStart(2)}. OLDURULDU   ${aciklama}`);
      console.log(`    -> ${sonuc.basarisiz} test basarisiz oldu`);
    } else {
      hayatta.push({ dosya, aciklama, testler });
      console.log(`${String(i + 1).padStart(2)}. HAYATTA!!   ${aciklama}`);
      console.log(`    -> ${dosya} bozuldu ama ${testler.join(', ')} HALA GECTI`);
    }
  }

  console.log('\n' + '═'.repeat(70));
  console.log(`OLDURULEN : ${oldurulen.length}/${MUTASYONLAR.length}`);
  console.log(`HAYATTA   : ${hayatta.length}`);
  console.log(`BULUNAMADI: ${bulunamadi.length}`);
  if (hayatta.length) {
    console.log('\nHAYATTA KALANLAR — bu ozellikler TEST EDILMIYOR:');
    hayatta.forEach(h => console.log(`  * ${h.aciklama}  (${h.dosya})`));
  }
  if (bulunamadi.length) {
    console.log('\nBULUNAMAYANLAR — kampanya bunlari OLCMEDI (yesil sayilmaz):');
    bulunamadi.forEach(h => console.log(`  * ${h.aciklama}  (${h.dosya})`));
  }

  // Kaynak agacinin TEMIZ birakildigini dogrula.
  const kirli = MUTASYONLAR.filter(([d, , y]) => fs.readFileSync(path.join(SRV, d), 'utf8').includes(y) &&
    !fs.readFileSync(path.join(SRV, d), 'utf8').includes(MUTASYONLAR.find(m => m[0] === d)[1]));
  console.log(`\nkaynak agaci: ${kirli.length === 0 ? 'TEMIZ (tum mutasyonlar geri alindi)' : 'DIKKAT — kalinti var!'}`);

  process.exit(hayatta.length === 0 && bulunamadi.length === 0 ? 0 : 1);
})();
