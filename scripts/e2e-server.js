#!/usr/bin/env node
/**
 * scripts/e2e-server.js — E2E ICIN DETERMINISTIK SUNUCU BASLATICI
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NEDEN VAR
 * ════════════════════════════════════════════════════════════════════════════
 * E2E paketi, ELLE baslatilmis bir sunucuya bagimliydi. Playwright yalnizca
 * `reuseExistingServer: true` ile onu yeniden kullaniyordu. O surec durdugunda
 * ortam kayboldu ve tarayici paketi 303/2'den 82/146'ya dustu — cunku surecin
 * ortam degiskenleri hicbir yerde YAZILI DEGILDI.
 *
 * Playwright'in kendi `webServer` blogu da kullanilamiyordu: `NODE_ENV=test`
 * ayarliyor, derlenmis sunucu ise o modda `dist` icinde BULUNMAYAN bir test
 * mock veritabani yuklemeye calisip aninda cikiyor:
 *     Error: [DB] Test mock DB could not be loaded
 *
 * Bu betik o bosluğu kapatir: gereken ortam ACIKCA burada yazilidir.
 *
 * ── OLCULEN ASIL SORUN: IPv6 GERI DUSME GECIKMESI ─────────────────────────
 * `server/.env` `HOST=127.0.0.1` (yalnizca IPv4) tanimlar. Playwright ise
 * varsayilan olarak `http://localhost:3000` kullanir ve Windows'ta `localhost`
 * ONCE `::1` (IPv6) olarak cozulur. Sunucu orada dinlemedigi icin her baglanti
 * once basarisiz bir IPv6 denemesi yapar:
 *
 *     http://localhost:3000   connect = 0.211 s
 *     http://127.0.0.1:3000   connect = 0.001 s      ← 211 kat fark
 *
 * Uygulama acilisi ~40 istek yapar (10 script etiketi, 27 CSS dosyasi, API
 * cagrilari, Socket.IO). Istek basina ~210 ms bosa giden baglanti suresi
 * saniyelerce gecikme demektir; olculen acilis ~27 sn'ye ciktı ve testlerin
 * 25 sn'lik `#app` beklemesi asildi. Tam kosumda 58 test tam olarak
 * "#app gorunur olmadi" ile dustu.
 *
 * COZUM: sunucu IPv4'te kalir (ag yuzeyi GENISLETILMEZ) ve E2E tarafi ayni
 * adresi kullanir. Boylece IPv6 denemesi HIC olmaz.
 *
 * ── GUVENLIK ──────────────────────────────────────────────────────────────
 * · Joker (wildcard) CORS YOK — izinli kaynaklar TAM olarak yazilir.
 * · Kimlik dogrulama/yetkilendirme DEGISTIRILMEZ.
 * · Sahte/in-memory bir urun yolu KURULMAZ; gercek Bridge arka ucu calisir.
 * · `NODE_ENV=test` KULLANILMAZ (test mock DB yolunu tetikler).
 * · Gizli degerler burada tanimlanmaz; `server/.env` uzerinden gelir.
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SERVER_DIR = path.join(__dirname, '..', 'server');
const ENTRY = path.join(SERVER_DIR, 'dist', 'index.js');

if (!fs.existsSync(ENTRY)) {
  console.error('[e2e-server] dist/index.js yok — once `cd server && npm run build` calistirin.');
  process.exit(1);
}

// ── ACIK ORTAM ────────────────────────────────────────────────────────────
// Her deger BURADA gorunur. Gorunmez bir ust-kabuk ortamina bagimlilik YOK.
const HOST = process.env.E2E_HOST || '127.0.0.1';
const PORT = process.env.E2E_PORT || '3000';
const ORIGIN = `http://${HOST}:${PORT}`;
const LOOPBACK_ORIGINS = [...new Set([
  ORIGIN,
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
])];
const WEBAUTHN_RP_ID = process.env.E2E_WEBAUTHN_RP_ID || 'localhost';
const WEBAUTHN_ORIGIN = process.env.E2E_WEBAUTHN_ORIGIN || `http://localhost:${PORT}`;

const env = {
  ...process.env,

  // Uygulama 3000'de kosar; `server/.env` 3001 icindir (gelistirici kurulumu).
  PORT,
  // IPv4'te kalinir. `localhost` (IPv6 `::1`) KULLANILMAZ — yukaridaki olcum.
  HOST,

  // TAM kaynak listesi. Joker YOK. Her ikisi de yazilir cunku farkli
  // arac/istemci yollari iki gosterimi de uretebiliyor.
  ALLOWED_ORIGINS: process.env.E2E_ALLOWED_ORIGINS || LOOPBACK_ORIGINS.join(','),

  // ── FEDERASYON KIMLIGI SUNULAN KAYNAKLA AYNI OLMALIDIR ──────────────────
  // `INSTANCE_URL` tanimli degilse sunucu `http://localhost:PORT` varsayar
  // (routes/federation/activitypub.ts). E2E ise 127.0.0.1 uzerinden konusur.
  // WebFinger, istenen alan adini KENDI alan adiyla karsilastirir; iki
  // gosterim ayrisinca mesru sorgu "bu ornege ait degil" diye 400 dondu.
  //
  // Sunucunun 400 dondurmesi DOGRUDUR: baska bir ornegin kullanicisini
  // kendi kullanicisi gibi yanitlamak federasyonda kimlik sahteciligidir.
  // Yanlis olan, betigin kimligi ACIKCA yazmamasiydi — bu dosyanin kendi
  // ilkesi "her deger BURADA gorunur". Deger, zaten hesaplanmis olan
  // ORIGIN'dir; dogrulama GEVSETILMEZ.
  INSTANCE_URL: process.env.E2E_INSTANCE_URL || ORIGIN,

  // ── PASSKEY KAYNAGI AYRI YAZILIR (127.0.0.1 DEGIL, localhost) ──────────
  // WebAuthn, `rpId`nin sayfa origin'inin KAYITLI ALAN ADI SONEKI olmasini
  // sart kosar. `127.0.0.1` bir alan adi degil bir IP'dir; `rpId=localhost`
  // ile ASLA eslesemez. Bu yuzden passkey paketi (`webauthn-virtual.spec.ts`)
  // sayfayi bilerek `http://localhost:PORT` uzerinden acar.
  //
  // `INSTANCE_URL` tek basina birakilirsa `routes/webauthn.ts` izinli kaynak
  // listesini ONDAN turetir ve passkey kaydi "Origin mismatch" ile 400 doner
  // (olculdu). Kaynak denetimi GEVSETILMEZ — TAM esitlik korunur; yalnizca
  // dogru kaynak ACIKCA yazilir.
  WEBAUTHN_RP_ID,
  WEBAUTHN_ORIGIN,

  // `test` KULLANILMAZ: derlenmis sunucuda mock DB yukleyip cikiyor.
  NODE_ENV: process.env.E2E_NODE_ENV || 'development',

  // ── ERISIM TOKEN OMRU ───────────────────────────────────────────────────
  // Uretim varsayilani 15 dakikadir (`middleware/auth.ts`). Tam E2E paketi
  // 15 dakikayi ASIYOR; global setup'ta uretilen tokenlar kosum ORTASINDA
  // suresi doluyor, sonraki testler giris ekranina dusuyor ve `#app` gizli
  // kaliyor. Her basarisizlik 25 sn'lik bir bekleme yaktigi icin kosum daha
  // da uzuyor ve daha cok token doluyor — kendini besleyen bir dongu.
  //
  // OLCULEN KORELASYON:
  //   8.5 dk suren kosum  → 20 adet "#app gorunmedi"
  //   15.2-15.5 dk kosum  → 59-61 adet (uc kosumda birebir tekrarlandi)
  // Izole acilis ise 374 ms; yani uygulama YAVAS DEGIL, token GECERSIZ.
  //
  // Bu YALNIZCA test ortamidir ve ACIKCA burada yazilidir. Uretim varsayilani
  // DEGISMEZ; kimlik dogrulama/yetkilendirme mantigina dokunulmaz.
  ACCESS_TOKEN_TTL: process.env.E2E_ACCESS_TOKEN_TTL || '2h',

  // ── SFU ADRESI: TARAYICI VE SUNUCU AYNI MAKINEDE ────────────────────────
  // Duyurulan adres yoksa mediasoup 0.0.0.0'i ICE adayi olarak verir ve
  // tarayici baglanamaz: `voice-media` projesinde RTP hic akmadi (olculdu:
  // 8 test, P2 medya dogrulamasi). Uretimde bu deger dagitimin isidir ve
  // tanimsizsa sunucu uyarir; burada tarayicilar ayni makinededir.
  MEDIASOUP_LISTEN_IP: process.env.MEDIASOUP_LISTEN_IP || '127.0.0.1',
  MEDIASOUP_ANNOUNCED_IP: process.env.MEDIASOUP_ANNOUNCED_IP || '127.0.0.1',

  // ── HIZ SINIRLARI: YALNIZCA VERIM, YALNIZCA E2E ─────────────────────────
  // OLCULEN SORUN: uygulama her acilista 17 API cagrisi yapar. Kuresel sinir
  // varsayilan 200 istek/dakikadir (`RL_GLOBAL_MAX`; kimlikli istekte kullanici
  // basina, anonimde IP basina). Bu, dakikada yaklasik 11 sayfa yuklemesi
  // demektir. Tarayici paketi bunun cok uzerindedir:
  //
  //   · klavye paketi   : ~18-20 yukleme / ~90 sn
  //   · medya paketi    : test basina 2-3 baglam → ~34-51 cagri
  //   · tam non-media   : 365 test × 17 ≈ 6200 cagri
  //
  // Sinir asilinca HER UC 429 doner; istemci oturum dogrulamasini yapamaz ve
  // GIRIS EKRANINA duser. Olculen belirti tam olarak buydu:
  //   token: true, #app display:none, sayfa "Giris Yap / Hesap Olustur",
  //   429: /api/me, /api/servers, /api/dm, /api/friends, /api/gdm, ...
  //
  // Bu, testlerin GERCEK bir kullanicinin uretemeyecegi hizda istek
  // uretmesinden kaynaklanir; sunucu DOGRU davranmaktadir.
  //
  // ── NE DEGISTI, NE DEGISMEDI ────────────────────────────────────────────
  // DEGISEN (yalnizca bu betikte, yalnizca VERIM sinirlari):
  //   RL_GLOBAL_MAX   — genel istek hacmi
  //   RL_SERVERS_MAX  — fikstur sunucu olusturma/silme
  //
  // DEGISMEYEN (kotuye kullanim / kimlik korumalari AYNEN kalir):
  //   MAX_REG_PER_HOUR      — hesap acma kotasi
  //   MAX_FAILED_LOGINS     — giris kilidi
  //   RL_LOGIN_MAX          — giris hizi
  //   RL_REGISTER_MAX       — kayit hizi
  //   bot filtresi, CAPTCHA, CSRF, CORS, yetkilendirme
  //
  // `server/.env` ve uretim varsayilanlari DOKUNULMADAN kalir; bu degerler
  // yalnizca Playwright'in baslattigi test sunucusunda gecerlidir. Deger
  // SONSUZ degildir: kacak bir dongu hala yakalanir.
  RL_GLOBAL_MAX: process.env.E2E_RL_GLOBAL_MAX || '20000',
  RL_SERVERS_MAX: process.env.E2E_RL_SERVERS_MAX || '2000',

  // OLCULEN: `channels.spec.ts` icindeki iki test 429 aldi. Kanal ucu ayri
  // bir kovadir (`RL_CHANNELS_MAX`, varsayilan 20/dk) ve yukaridaki iki
  // degerden BAGIMSIZDIR. Paket kanal olustur/sil dongusunu fikstur olarak
  // defalarca kosar; gercek bir kullanicinin uretmeyecegi hizdir.
  // `RL_ROLES_MAX` ve `RL_API_MAX` ayni sebeple yukseltilir: rol atama ve
  // federation/webfinger uclari da fikstur trafigi tasir.
  // Bunlar YALNIZCA VERIM kovalaridir; yetkilendirme, ban esigi ve kimlik
  // korumalarina DOKUNULMAZ.
  RL_CHANNELS_MAX: process.env.E2E_RL_CHANNELS_MAX || '2000',
  RL_ROLES_MAX: process.env.E2E_RL_ROLES_MAX || '2000',
  RL_API_MAX: process.env.E2E_RL_API_MAX || '5000',

  // ── SOKET BAGLANTI HIZI: OTOMATIK IP BANININ GERCEK SEBEBI ──────────────
  // KESIN OLCUM. Gruplu kosumda TUM uclar 403 dondu ve `#app` hic gorunmedi.
  // Sebep tahmin DEGIL, sunucunun kendi yanitiydi:
  //
  //   403 {"error":"IP adresiniz engellenmistir.",
  //        "reason":"Otomatik ban: socket connect rate limit 5x asildi",
  //        "remainingSeconds":742}
  //
  // MEKANIZMA (server/socket/ipRateLimit.ts):
  //   · IP basina 20 soket baglantisi/dk  (RL_SOCKET_CONNECT_MAX)
  //   · 5 ihlal → 15 dakika OTOMATIK IP BANI (RL_AUTO_BAN_THRESHOLD)
  //
  // Her tarayici testi bir sayfa acar, her sayfa bir Socket.IO baglantisi
  // kurar. 42 test / ~2 dk ≈ 21 baglanti/dk — esik tam olarak burada asilir.
  // Ban bir kez dustugunde HER istek 403 olur; belirti "uygulama acilmiyor"
  // gibi gorunur ama sebep tamamen farklidir.
  //
  // ── NE DEGISTI, NE DEGISMEDI ────────────────────────────────────────────
  // DEGISEN  : yalnizca VERIM esikleri (kac baglanti/dk kabul edilir).
  // DEGISMEYEN: BAN MANTIGI. `RL_AUTO_BAN_THRESHOLD` ve
  //             `RL_AUTO_BAN_DURATION` ELLENMEZ — esik asilirsa otomatik
  //             ban HALA calisir. Yani kacak bir dongu yine yakalanir;
  //             yalnizca mesru test hacmi artik ihlal sayilmaz.
  //
  // ── URUN NOTU — Final21 Faz 19'da KAPATILDI ────────────────────────────
  // Eskiden: TEK bir NAT/kurumsal IP arkasindaki 20+ kullanici ayni dakika icinde
  // Bridge'i acarsa o ofisin TAMAMI 15 dakika banlanirdi. Artik imzasi dogrulanan
  // jetonla gelen baglanti KENDI kotasindan duser (socket/ipRateLimit.ts
  // ipRateCheckFor, F21-11-04 modeli). Buradaki yukseltme yalniz tek-IP yuk olcumu icindir.
  RL_SOCKET_CONNECT_MAX: process.env.E2E_RL_SOCKET_CONNECT_MAX || '5000',
  RL_SOCKET_HS_MAX: process.env.E2E_RL_SOCKET_HS_MAX || '5000',

  // ── ES ZAMANLI SOKET TAVANI: YUK OLCUMU ICIN ─────────────────────────────
  // `MAX_WS_PER_IP` uretimde 10'dur ve DOGRU bir korumadir: tek bir IP'nin
  // sunucuyu soket acarak tuketmesini engeller.
  //
  // Ama yuk olcumunde TUM istemciler 127.0.0.1'den gelir. Bu tavan, olculen
  // seyi kapasiteden KORUMANIN KENDISINE cevirir: kac soket istenirse
  // istensin bagli sayisi 10'da sabitlenir ve "100 es zamanli kullanici"
  // olcumu ANLAMSIZ olur.
  //
  // Yalnizca E2E/olcum surecinde yukseltilir. URETIM VARSAYILANI
  // DEGISTIRILMEDI — bu dosya yalnizca test surecinin ortamini kurar.
  // Kullanici basina tavan (`MAX_WS_PER_USER`) da ayni nedenle yukseltilir:
  // olcumde bir kullanici birden cok sanal istemciyi temsil eder.
  MAX_WS_PER_IP: process.env.E2E_MAX_WS_PER_IP || '500',
  // FAZ 18 (uyari sifir): 200 istemek, urunun KENDI ortam dogrulamasinin ustundeydi
  // (`MAX_WS_PER_USER` icin max 100) ve her acilista bir uyari basiyordu. Tavan
  // YUKSELTILMEDI — uretim korumasini zayiflatirdi; harness artik urunun makul saydigi
  // en yuksek degeri istiyor. Yuk/soak araclari zaten kullanici basina bir avuc soket
  // aciyor; onlari sinirlayan MAX_WS_PER_IP (500) degismedi.
  MAX_WS_PER_USER: process.env.E2E_MAX_WS_PER_USER || '100',

  // ── KAYIT HIZI: YUK FIKSTURU URETIMI ICIN ────────────────────────────────
  // Uretimde `register` dakikada 5'tir (IP bazli) — kayit spam'ine karsi
  // DOGRU bir varsayilan.
  //
  // Yuk olcumu icin gercek bir KALABALIK gerekir: anti-spam korumasi
  // kullanici basina 4 saniyede 5 mesaja izin verdiginden, tek kullanicili
  // bir yuk testi kapasiteyi degil anti-spam esigini olcer. Kalabaligi
  // uretmek de dakikada 5 kayitla saatler surerdi.
  //
  // Yalnizca E2E/olcum surecinde yukseltilir. URETIM VARSAYILANI
  // DEGISTIRILMEDI ve anti-spam korumasi KAPATILMADI — yuk testi o esigin
  // ALTINDA kalarak calisir.
  RL_REGISTER_MAX: process.env.E2E_RL_REGISTER_MAX || '2000',
  RL_LOGIN_MAX: process.env.E2E_RL_LOGIN_MAX || '2000',

  // ── SAATLIK HESAP ACMA TAVANI (AYRI BIR KORUMA KATMANI) ──────────────────
  // `RL_REGISTER_MAX` hiz sinirlayicidir; bu ise `lib/captcha.ts` icindeki
  // BAGIMSIZ bir kotudur: `MAX_REG_PER_HOUR` varsayilan olarak IP basina
  // SAATTE 3 hesaptir (`registrationThrottleMiddleware`).
  //
  // Ikisi ayri katmandir: hiz sinirini yukseltmek bunu ACMAZ. Olcum
  // sirasinda 60 fikstur kullanicisi uretmek gerektigi icin burada da
  // yukseltilir.
  //
  // Yalnizca E2E/olcum surecinde. URETIM VARSAYILANI (saatte 3)
  // DEGISTIRILMEDI — kayit spam'ine karsi dogru bir esiktir.
  MAX_REG_PER_HOUR: process.env.E2E_MAX_REG_PER_HOUR || '1000',

  // ── CSRF TOKEN URETIM HIZI: MEDYA COKUSUNUN GERCEK SEBEBI ───────────────
  // KESIN OLCUM. Medya paketi "birikimli bozulma" gibi gorunuyordu: 1. ve 2.
  // kosum geciyor, 3.'den itibaren KALICI olarak dusuyordu. Sebep tahmin
  // DEGIL, dogrudan uc probu ile bulundu:
  //
  //   GET /api/csrf-token            → 429
  //   POST /api/servers              → 403 {"error":"CSRF token missing"}
  //   → createTestServer null doner  → srvId = ''
  //   → locator('.server-icon[data-id=""]') → 25 sn zaman asimi
  //
  // MEKANIZMA (server/middleware/rateLimit.ts:79):
  //   csrf: { max: 20, windowMs: 300_000 }   // 5 DAKIKADA 20 token / IP
  //
  // Her `playwright test` cagrisi global setup + fikstur kurulumu icin ~7
  // token uretir. Arka arkaya ucuncu cagri 20'yi asar ve TUM mutasyonlar
  // 403 olur. Belirti "ses kurulmuyor" gibi gorunur; sebep tamamen farklidir.
  //
  // BUTUN GOZLEMLER BU MEKANIZMAYLA TUTARLI:
  //   · 100 sn bosta beklemek DUZELTMEDI  → pencere 60 sn degil, 300 sn
  //   · sunucu yeniden baslatmak ANINDA duzeltti → sayac bellekte
  //   · /api/me 200 donmeye devam etti    → ban yok, kuresel sinir saglam
  //   · RSS 111→113 MB sabit              → sizinti YOK
  //   · sunucu logunda hata YOK           → sessizce reddediliyor
  //
  // ── NE DEGISTI, NE DEGISMEDI ────────────────────────────────────────────
  // DEGISEN  : yalnizca token URETIM HIZI (dakikada kac token verilir).
  // DEGISMEYEN: CSRF KORUMASININ KENDISI. Token hala ZORUNLU, hala
  //             dogrulaniyor, mutasyonlar hala tokensiz reddediliyor.
  //             `middleware/csrf.ts` ELLENMEDI. Koruma ATLANMIYOR.
  //
  // ── URUN NOTU ───────────────────────────────────────────────────────────
  // Gercek istemci tokeni ONBELLEKLER (client/js/core/api-fetch.ts: tek
  // `_csrfToken` + tek ucus promise), yani normal kullanici oturum basina
  // bir token alir. Uretim varsayilani bu nedenle makuldur ve BILINCLI
  // olarak DEGISTIRILMEDI. Yine de ayni NAT arkasindaki cok sayida
  // kullanici 5 dakikada 20 acilisi asarsa mutasyonlar 403 olur — bu
  // raporlanan bir bulgudur, burada bir karar degildir.
  RL_CSRF_MAX: process.env.E2E_RL_CSRF_MAX || '5000',

  // ── SOKET OLAY BUTCESI: MEDYA PAKETININ SON GERCEK SEBEBI ───────────────
  // KESIN OLCUM (tek degisken: KULLANICI KIMLIGI):
  //
  //   ayni kimlikle 1-3. tur ekran paylasimi → her biri 10.6 sn  SAGLIKLI
  //   ayni kimlikle 4. tur                   → 70.4 sn, ses yolu 1/2 EKSIK
  //   ayni kimlikle 5. tur                   → hic eslesme (pcStates=NO_PC)
  //   BASKA kimlikle 4-5. tur                → yine 10.6 sn  SAGLIKLI
  //
  // Tarayici, sunucu, kanal ve kod AYNIYDI. Yalnizca hesap degisti.
  //
  // MEKANIZMA (server/socket/socketRateLimit.ts):
  //   '*': kullanici basina DAKIKADA 200 soket olayi
  //
  // WebRTC sinyallesmesi olay yogundur (ICE adaylari, offer/answer, yeniden
  // pazarlik). Medya paketi 33 agir testi YALNIZCA IKI hesapla kosar; gercek
  // kullanicilar bu yogunlugu tek hesapta uretmez. Sinir asilinca olaylar
  // SESSIZCE dusurulur — HTTP tarafinda hicbir hata gorunmez, bu yuzden
  // belirti uzun sure "birikimli bozulma" gibi yorumlandi.
  //
  // ── NE DEGISTI, NE DEGISMEDI ────────────────────────────────────────────
  // DEGISEN  : yalnizca bu test sunucusundaki olay butcesi.
  // DEGISMEYEN: uretim varsayilani 200'DUR ve KOD ICINDE OYLE KALDI.
  //             `socketRateLimit.ts` yalnizca ENV DESTEGI kazandi; degisken
  //             tanimlanmazsa davranis bit duzeyinde AYNIDIR. Projedeki
  //             diger TUM sinirlar zaten boyle calisiyordu.
  RL_SOCK_EVENT_MAX: process.env.E2E_RL_SOCK_EVENT_MAX || '20000',
  RL_SOCK_SIGNAL_MAX: process.env.E2E_RL_SOCK_SIGNAL_MAX || '5000',
  // Ayni sinif: kullanici basina olay VERIMI. Paralel iscilerle kosan tam
  // paket TEK bir kimlikle (alice) coklu spec'ten mesaj gonderip kanala
  // katiliyor; urun sinirlari `message:send` 20/10sn ve `channel:join`
  // 20/10sn'dir. Olculen belirtiler:
  //   · "channel:join dogrulanamadi — socket <id> odasina giremedi"
  //   · optimistic mesaj hic uzlasmadi (ack gelmedi, 20 sn zaman asimi)
  // Ikisi de kosumdan kosuma YER DEGISTIRIYORDU — klasik cekisme imzasi.
  // Gercek bir kullanici 10 saniyede 20 mesaj gondermez; bu yalnizca
  // harness hacmidir. SPAM/kimlik korumalari (kayit, giris, 2FA, oto-ban)
  // AYNEN korunur.
  RL_SOCK_MSG_MAX: process.env.E2E_RL_SOCK_MSG_MAX || '2000',
  RL_SOCK_JOIN_MAX: process.env.E2E_RL_SOCK_JOIN_MAX || '2000',

  // ── PROFIL/AYAR YAZMA HIZI ──────────────────────────────────────────────
  // OLCUM: `settings` siniri dakikada 10 istektir. Tam paket PARALEL
  // isciyle kosarken ayni IP'den bu asiliyor:
  //   tests/settings.spec.ts → "API: profil guncelleme" → 429
  // Ayni dosya TEK BASINA 6/6 geciyor — yani urun degil, es zamanlilik.
  // Gercek bir kullanici dakikada 10 profil guncellemesi yapmaz.
  RL_SETTINGS_MAX: process.env.E2E_RL_SETTINGS_MAX || '2000',

  // ── WEBHOOK YONETIMI ────────────────────────────────────────────────────
  // `webhooks` siniri dakikada 15 istektir. SSRF guvenlik paketi TEK BASINA
  // 12 farkli kotu hedefi dener (loopback, metadata, IPv4-mapped, NAT64,
  // 6to4, file: ...) ve REDDEDILEN istekler de sayaci tuketir — sinir
  // isleyiciden ONCE calisir. Gercek bir yonetici dakikada 15 webhook
  // olusturmaz; bu yalnizca guvenlik testinin hacmidir.
  RL_WEBHOOKS_MAX: process.env.E2E_RL_WEBHOOKS_MAX || '2000',
};

console.log('[e2e-server] baslatiliyor');
console.log('[e2e-server]   HOST            = ' + HOST);
console.log('[e2e-server]   PORT            = ' + PORT);
console.log('[e2e-server]   ALLOWED_ORIGINS = ' + env.ALLOWED_ORIGINS);
console.log('[e2e-server]   INSTANCE_URL    = ' + env.INSTANCE_URL);
console.log('[e2e-server]   WEBAUTHN_RP_ID  = ' + env.WEBAUTHN_RP_ID);
console.log('[e2e-server]   WEBAUTHN_ORIGIN = ' + env.WEBAUTHN_ORIGIN);
console.log('[e2e-server]   NODE_ENV        = ' + env.NODE_ENV);
console.log('[e2e-server]   DATABASE_URL    = ' + (process.env.DATABASE_URL ? '<ortamdan>' : '<server/.env>'));

const child = spawn(process.execPath, [ENTRY], {
  cwd: SERVER_DIR,
  env,
  stdio: 'inherit',
});

// Playwright sureci sonlandirdiginda cocuk surec de kapanir.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(sig); } catch { /* zaten kapali */ } });
}
child.on('exit', (code) => process.exit(code ?? 0));
