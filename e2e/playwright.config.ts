// e2e/playwright.config.ts — Sprint 14: TypeScript dönüşümü
// e2e/playwright.config.js — Bridge E2E Test Konfigürasyonu
// Playwright ile kritik akışları test eder: login, mesaj, kanal, DM
//
// Kurulum:
//   npm install -D @playwright/test
//   npx playwright install --with-deps chromium
//
// Çalıştırma:
//   npx playwright test                    # tüm testler
//   npx playwright test --headed           # tarayıcı görünür
//   npx playwright test tests/auth.spec.js # tek dosya
//   npx playwright show-report             # HTML rapor

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // tests-legacy/ KASITLI OLARAK DIŞLANMIŞTIR: sevk edilmemiş özelliklerin
  // testleri (RTL, dış Mastodon federasyonu, mock-peer federasyon CI).
  // Silinmezler; ayrı bir config ile çalıştırılabilirler.
  // Gerekçeler: tests-legacy/README.md · Config: playwright.legacy.config.ts
  testIgnore: ['**/tests-legacy/**'],
  // global.setup.ts default export'lu bir globalSetup'tır — test() çağrısı içermez.
  // Proje bağımlılığı olarak bağlanınca Playwright "no tests" görüp sessizce atlıyor
  // ve fixtures/auth-state.json hiç üretilmiyordu. Doğru kanca globalSetup'tır.
  globalSetup: require.resolve('./global.setup.ts'),
  fullyParallel: false, // Bridge'in shared DB'si nedeniyle sıralı çalış
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // ══════════════════════════════════════════════════════════════════════════
  // TEK İŞÇİ — ÖLÇÜLMÜŞ BİR KARAR, KEYFİ DEĞİL
  // ══════════════════════════════════════════════════════════════════════════
  // Yerelde `workers: 2` idi ve paket DÖNÜŞÜMLÜ olarak bir test düşürüyordu —
  // her koşumda BAŞKA bir test. Ölçüm:
  //
  //     workers: 2  →  330-334 geçti, koşumların ~yarısında 1 düşüş
  //     workers: 1  →  332 geçti, 0 düşüş  (tam paket, tekrarlanabilir)
  //
  // SEBEP KANITLANDI: spec'lerin çoğu AYNI kimliği (alice) sürer. Ürünün
  // anti-spam politikası kullanıcı bazlıdır
  // (server/lib/security.ts → maxMessages: 5, windowMs: 4000) ve eşik
  // aşılınca kullanıcı 30 SANİYE susturulur; susturulan gönderim `error:spam`
  // döner ve HİÇ `message:ack` üretmez. Belirtiler tam olarak bunlardı:
  //   · "channel:join doğrulanamadı — socket <id> odasına giremedi"
  //   · optimistic mesaj hiç uzlaşmadı → waitForFunction zaman aşımı
  //
  // `helpers/socket.ts` içindeki `paceSends` artık süreçler arasında kilitle
  // koordine ediliyor; ancak TARAYICI ÜZERİNDEN yazılan mesajlar (kullanıcı
  // #msg-input'a yazıp Enter'a basıyor) o yardımcıdan GEÇMEZ ve
  // paced edilemez. Yani iki işçi kaldıkça çekişme tümüyle kapanmaz.
  //
  // ÜRÜN SINIRI DOĞRUDUR ve DEĞİŞTİRİLMEZ: gerçek bir kullanıcı 4 saniyede
  // 5 mesajı aşmaz. Determinizm hızdan önce gelir — dönüşümlü düşen bir
  // paket, 2 dakika daha hızlı koşmasına değmez.
  //
  // Maliyet: ~2.5 dk → ~4.5 dk. Paralel koşmak isteyen `--workers=2`
  // geçebilir; kalıcı çözüm, tarayıcı sürücülü spec'lere İŞÇİ BAŞINA AYRI
  // kimlik vermektir.
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'playwright-results.xml' }],
  ],

  use: {
    // 127.0.0.1 KULLANILIR, `localhost` DEGIL.
    // Sunucu `HOST=127.0.0.1` ile yalnizca IPv4'te dinler; Windows'ta
    // `localhost` ONCE `::1` (IPv6) olarak cozulur ve her baglanti basarisiz
    // bir IPv6 denemesiyle baslar. OLCULDU:
    //     http://localhost:3000  connect = 0.211 s
    //     http://127.0.0.1:3000  connect = 0.001 s
    // Acilis ~40 istek yaptigi icin bu, saniyelerce gecikme ve 25 sn'lik
    // `#app` beklemesinin asilmasi demekti (tam kosumda 58 test dustu).
    baseURL: process.env.BASE_URL || 'http://127.0.0.1:3000',

    // ── TARAYICI DILI: TURKCE ────────────────────────────────────────────
    // Bridge TURKCE-ONCELIKLI bir urundur ve bu paketteki secicilerin buyuk
    // bolumu Turkce erisilebilir ADLARA dayanir (ornegin
    // `getByRole('dialog', { name: 'Onboarding sihirbazi' })`).
    //
    // i18n gocu tamamlanana kadar bu gorunmuyordu: metinler sabit kodlu
    // Turkce oldugu icin tarayici dili ne olursa olsun Turkce geliyordu.
    // Metinler ceviriye tasinir tasinmaz Playwright'in varsayilan `en-US`
    // dili devreye girdi, arayuz INGILIZCE render edildi ve Turkce adlara
    // bakan 14 test dustu.
    //
    // Dil burada ACIKCA sabitlenir: testler DAVRANIS testidir, dil testi
    // degil. Dili gercekten sinayan `locale-journey.spec.ts` kendi icinde
    // `localStorage` ile bunu ezer.
    locale: 'tr-TR',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Her test için temiz state
    storageState: undefined,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    {
      name: 'api-smoke',
      use: {
        ...devices['Desktop Chrome'],
        storageState: undefined,
      },
      testMatch: /smoke-health\.spec\.ts/,
    },
    // ── CAPRAZ TARAYICI ────────────────────────────────────────────────
    // Paketin tamami Chromium'a gore yazildi. "Chromium'da geciyor" ile
    // "uründe calisiyor" ayni sey degildir: Firefox ve WebKit farkli CSS,
    // odak, depolama ve medya davranisi getirir.
    //
    // Kapsam DAR tutulur (cekirdek akislar) cunku mevcut secicilerin buyuk
    // bolumu Chromium'a gore yazilmistir; hepsini uc motorda kosmak gercek
    // uyumluluk degil, secici kirilganligi olcerdi.
    //
    // NOT: Playwright WebKit GERCEK Safari donanimi DEGILDIR.
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        locale: 'tr-TR',
        // `storageState` bu projede PROJE BAZINDA verilir (ust duzeyde yok).
        // Ilk denemede atlandigi icin testler OTURUMSUZ kosmus ve giris
        // ekraninda takilmisti.
        storageState: 'fixtures/auth-state.json',
      },
      testMatch: /cross-browser-(core|journeys|product)\.spec\.ts/,
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        locale: 'tr-TR',
        storageState: 'fixtures/auth-state.json',
      },
      testMatch: /cross-browser-(core|journeys|product)\.spec\.ts/,
    },
    // Ana testler (Chromium)
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Auth state'i globalSetup'tan al (login akışı)
        storageState: 'fixtures/auth-state.json',
      },
      // `a11y.smoke.spec.ts` AYRI bir projeye aittir (asagida) ve oturumsuz
      // calisir. Chromium projesi `storageState` tasidigi icin ayni dosyayi
      // burada da calistirmak, giris/kayit formlarini OTURUM ACIKKEN taramak
      // demekti — iki proje birbirinin varsayimini bozuyordu.
      // `media-automation.spec.ts` de sahte medya bayraklarina ihtiyac duyar;
      // yalnizca `voice-media` projesinde kosar.
      testIgnore: [/global\.setup\.ts/, /a11y\.smoke\.spec\.ts/, /voice-media\.spec\.ts/, /media-automation\.spec\.ts/, /mobile\.spec\.ts/, /visual-review\.spec\.ts/, /perf-benchmark\.spec\.ts/, /a11y-keyboard-journeys\.spec\.ts/],
    },
    // Mobile viewport testleri
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        storageState: 'fixtures/auth-state.json',
      },
      testMatch: /mobile\.spec\.ts/,
    },
    {
      // ── GERCEK MEDYA ─────────────────────────────────────────────────────
      // Iki tarayici baglami, sahte medya cihazi ve gercek WebRTC. Ayri bir
      // proje: bu bayraklar diger projelerin davranisini degistirmemeli
      // (sahte cihaz izin sormaz ve ton uretir).
      name: 'voice-media',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            // Ekran paylasimi on kontrolu: secim penceresi otomatik yanitlanir.
            // Sahte masaustu kaynagi SES track'i vermez — bu KASITLIDIR:
            // testler "ses gercekten duyuldu" iddiasinda BULUNAMAZ, yalnizca
            // platform ses vermediginde urunun DURUST davrandigini olcer.
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
      testMatch: /(voice-media|media-automation)\.spec\.ts/,
    },
    {
      // ── GORSEL INCELEME URETICISI ────────────────────────────────────────
      // Test degil, ekran goruntusu uretir. Kendi projesindedir ki normal
      // gecitleri yavaslatmasin ve yanlislikla "kapsam" sayilmasin.
      // Calistirma: npx playwright test --project=visual
      name: 'visual',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'fixtures/auth-state.json',
      },
      testMatch: /(visual-review|overlay-family|perf-probe)\.spec\.ts/,
    },
    {
      name: 'a11y',
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: /a11y\.smoke\.spec\.ts/,
    },
    {
      // ── MOBİL GÖRÜNÜM ERİŞİLEBİLİRLİK TARAMASI ───────────────────────────
      // ÖLÇÜLEN BOŞLUK (Final20): `a11y` ve `a11y-keyboard` projelerinin İKİSİ
      // de `Desktop Chrome` kullanıyordu. Oysa erişilebilirlik kusurlarının
      // önemli bir bölümü YALNIZCA dar görünümde ortaya çıkar: yeniden akış
      // (1.4.10), dokunma hedefi boyutu, mobil gezinmenin ARIA sözleşmesi,
      // yakınlaştırma engeli. Mobil yüzey hiç taranmıyordu.
      //
      //   npx playwright test --project=a11y-mobile
      name: 'a11y-mobile',
      use: {
        ...devices['Pixel 7'],
      },
      testMatch: /a11y\.smoke\.spec\.ts/,
    },
    {
      // ── KLAVYE-YALNIZ YOLCULUKLAR ────────────────────────────────────────
      // `a11y` projesi KASITLI olarak oturumsuzdur (giris/kayit formlarini
      // tarar). Bu yolculuklar ise uygulama KABUGUNU gerektirir: odak
      // geri yukleme, focus trap, klavyeyle mesaj gonderme. Bu yuzden
      // storageState tasiyan AYRI bir projede kosar.
      //
      //   npx playwright test --project=a11y-keyboard
      name: 'a11y-keyboard',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'fixtures/auth-state.json',
      },
      testMatch: /a11y-keyboard-journeys\.spec\.ts/,
    },
    {
      // ── TEKRARLANABILIR PERFORMANS OLCUMU ────────────────────────────────
      // `perf-probe` her adimi BIR KEZ olcer ve hatalari yutar; gurultu
      // sinyalden buyuk oldugu icin gerileme yakalayamaz. Bu proje N tekrarli,
      // hata yutmayan, sabit uykusuz ve JSON cikti veren harness'i calistirir.
      //
      //   npx playwright test --project=perf
      //   PERF_ITERATIONS=11 PERF_LABEL=after npx playwright test --project=perf
      //
      // Normal gecitlerden AYRIDIR: olcum uzun surer ve makine yukune
      // duyarlidir; kapsam sayilmamalidir.
      name: 'perf',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'fixtures/auth-state.json',
      },
      testMatch: /perf-benchmark\.spec\.ts/,
    },
  ],

  // Test çalışmadan önce sunucuyu başlat (CI'da zaten ayakta olacak)
  // ══════════════════════════════════════════════════════════════════════════
  // SUNUCU ARTIK REPRODUKE EDILEBILIR SEKILDE BASLATILIR
  // ══════════════════════════════════════════════════════════════════════════
  // ESKI HALI iki nedenle CALISMIYORDU:
  //
  //   1. `NODE_ENV: 'test'` ayarliyordu; derlenmis sunucu o modda `dist`
  //      icinde bulunmayan bir test mock DB yuklemeye calisip aninda cikiyor:
  //          Error: [DB] Test mock DB could not be loaded
  //      Bu yuzden `webServer` hicbir zaman ayaga kalkmiyor, yalnizca
  //      `reuseExistingServer` sayesinde ELLE baslatilmis bir surec
  //      kullaniliyordu. O surecin ortami hicbir yerde yazili degildi ve
  //      durduruldugunda ortam kayboldu.
  //
  //   2. Kaynak (origin) ve host ayari eksikti; `server/.env` 3001 icindir.
  //
  // `scripts/e2e-server.js` gereken ortami ACIKCA tanimlar ve gercek Bridge
  // arka ucunu calistirir (sahte/in-memory yol YOK, joker CORS YOK).
  webServer: {
    command: 'node ../scripts/e2e-server.js',
    url: 'http://127.0.0.1:3000/api/health',
    // Ayakta bir sunucu varsa yeniden kullanilir; yoksa BURADAN baslatilir.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
