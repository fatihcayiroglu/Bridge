// mobile/tests/shell-composition.test.js
//
// ════════════════════════════════════════════════════════════════════════════
// MOBIL KABUK — URETILEN HTML SOZLESMESI
// ════════════════════════════════════════════════════════════════════════════
//
// OLCULEN KUSUR (Final20, uygulama gercekten calistirilarak bulundu):
// `mobile/index.template.html` web istemcisinin ELLE KOPYALANMIS eski bir
// surumunu tasiyordu ve uc bagimsiz sekilde bozuktu.
//
//   1. 62 adet `<script src="js/core/*.js">` etiketi. Istemci coktan tek bir
//      ESM paketine gecmisti; bu dosyalarin HICBIRI `www/` icinde yoktu.
//      Uygulama splash ekranindan sonra HIC acilmiyordu.
//
//   2. Paket `client/dist/js` -> `www/js` olarak DUZLESTIRILIYORDU; oysa
//      esbuild `publicPath = '/dist/js/'` ile derleniyor ve tembel yuklenen
//      chunk adresleri pakete GOMULU. Olculdu: 12 chunk 404 veriyordu (SFU
//      sesli gorusme dahil, cunku mediasoup talebe gore yuklenir).
//
//   3. 48 adet satir ici `onclick="..."` ozniteligi. Web kabugu delege edilmis
//      `data-bridge-action` desenine gecmis, mobil kopya geride kalmisti.
//      Tarayicida olculdu: `ReferenceError: switchAuthTab is not defined`,
//      `ReferenceError: login is not defined` — giris ekranindaki dugmeler
//      hicbir sey yapmiyordu.
//
// Hicbiri statik incelemeyle gorunmuyordu ve `setup.js`in tek saglik olcusu
// "www/ icinde en az 3 dosya var mi" idi — yani kapi her zaman YESIL yaniyordu.
//
// Bu testler URETILEN kabugu olcer, sablonun niyetini degil.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const WWW = path.join(ROOT, 'mobile', 'www');
const DIST_JS = path.join(ROOT, 'client', 'dist', 'js');

/** Derleme ciktisi yoksa kabuk uretilemez; test durustce atlanir. */
function bundleAvailable() {
  return fs.existsSync(DIST_JS)
    && fs.readdirSync(DIST_JS).some((name) => /^app-[A-Z0-9]+\.js$/i.test(name));
}

function buildShell() {
  execFileSync(process.execPath, [path.join(ROOT, 'mobile', 'scripts', 'setup.js')], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  return fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
}

const available = bundleAvailable();
const describeIfBuilt = available ? describe : describe.skip;

if (!available) {
  // Sessiz atlama YOK: neden atlandigi loglanir.
  // eslint-disable-next-line no-console
  console.warn('[mobile shell] client/dist/js/app-<hash>.js yok — once `npm run build`. Testler atlaniyor.');
}

describeIfBuilt('mobil kabuk — uretilen www/index.html', () => {
  /** @type {string} */
  let html;

  beforeAll(() => {
    html = buildShell();
  });

  test('her yerel betik ve stil referansi www/ icinde GERCEKTEN vardir', () => {
    const refs = [];
    for (const pattern of [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g]) {
      let match;
      while ((match = pattern.exec(html)) !== null) refs.push(match[1]);
    }
    expect(refs.length).toBeGreaterThan(0);

    const missing = refs.filter((ref) => {
      if (/^(?:https?:)?\/\//.test(ref) || ref.startsWith('data:')) return false;
      // Sunucudan gelen ve `npx cap sync` tarafindan yerlestirilen varliklar.
      if (ref === '/socket.io/socket.io.js' || ref === 'capacitor.js') return false;
      const clean = ref.split('?')[0].split('#')[0].replace(/^\.?\//, '');
      return !fs.existsSync(path.join(WWW, clean));
    });
    expect(missing).toEqual([]);
  });

  test('paketin GOMULU chunk adresleri de cozulur (duzlestirme regresyonu)', () => {
    const entry = fs.readdirSync(path.join(WWW, 'dist', 'js'))
      .find((name) => /^app-[A-Z0-9]+\.js$/i.test(name));
    expect(entry).toBeDefined();

    const bundle = fs.readFileSync(path.join(WWW, 'dist', 'js', entry), 'utf8');
    const baked = [...new Set(bundle.match(/dist\/js\/chunk-[A-Z0-9]+\.js/gi) || [])];
    // Tembel yuklenen chunk'lar var olmali; yoksa bu iddia anlamsizlasir.
    expect(baked.length).toBeGreaterThan(0);

    const missing = baked.filter((rel) => !fs.existsSync(path.join(WWW, rel)));
    expect(missing).toEqual([]);
  });

  test('kabuk UCUNCU TARAF bir kaynaktan varlik YUKLEMEZ', () => {
    const external = [];
    for (const pattern of [/<script[^>]+src="([^"]+)"/g, /<link[^>]+href="([^"]+)"/g]) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        if (/^(?:https?:)?\/\//.test(match[1])) external.push(match[1]);
      }
    }
    // Mobil uygulama calisma zamaninda uzak betik CALISTIRMAMALIDIR:
    // cevrimdisi kirilir, tedarik zinciri riski tasir, CSP'yi zayiflatir.
    expect(external).toEqual([]);
  });

  test('satir ici `onclick` YOKTUR — eylemler delege edilir', () => {
    // `onclick` global fonksiyon arar; ESM paketinde global yoktur. Web kabugu
    // bu gecisi yapti (`data-bridge-action`), mobil kabuk da yapmis olmali.
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
    expect(withoutComments).not.toMatch(/\son(?:click|change|input|submit)=/i);
    expect(withoutComments).toMatch(/data-bridge-action=/);
  });

  test('CSP joker karakter ve `unsafe-eval` ICERMEZ', () => {
    const meta = html.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([\s\S]*?)"/i);
    expect(meta).not.toBeNull();
    const policy = meta[1].replace(/\s+/g, ' ').trim();

    expect(policy).not.toMatch(/-src\s+\*/);
    expect(policy).not.toContain("'unsafe-eval'");
    // Sunucunun web icin uyguladigi sertlestirmelerin mobilde de olmasi beklenir.
    for (const directive of ["object-src 'none'", "base-uri 'self'", "form-action 'self'"]) {
      expect(policy).toContain(directive);
    }
  });

  test('kullanici yakinlastirmasi ENGELLENMEZ (WCAG 2.1 SC 1.4.4)', () => {
    const viewport = html.match(/<meta[^>]+name="viewport"[^>]+content="([^"]+)"/i);
    expect(viewport).not.toBeNull();
    expect(viewport[1]).not.toMatch(/user-scalable\s*=\s*no/i);
    expect(viewport[1]).not.toMatch(/maximum-scale\s*=\s*1(\.0)?\b/i);
    // Guvenli alan (notch) dolgusu buna bagli oldugu icin korunmali.
    expect(viewport[1]).toContain('viewport-fit=cover');
  });

  test('mobil kabuk parcalari ve uygulama govdesi BIRLIKTE bulunur', () => {
    // Mobil-ozgu kabuk
    expect(html).toContain('id="native-splash"');
    expect(html).toContain('id="push-permission-banner"');
    // Web kabugundan devralinan uygulama govdesi
    expect(html).toContain('id="auth-screen"');
    expect(html).toContain('id="mobile-nav"');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Faz 19 (19-28): PAKETLENMİŞ UYGULAMA SUNUCUYA ULAŞABİLİR Mİ?
// ════════════════════════════════════════════════════════════════════════════
// İstemci API tabanını `globalThis.BRIDGE_API`den alır; bu derleme onu hiç atamıyordu ve
// emülatörde uygulama her isteği KENDİ kökenine (https://localhost) yapıp açılış ekranında kaldı.
describeIfBuilt('mobil kabuk — BRIDGE_API_URL sunucu adresi', () => {
  const run = (apiUrl) => require('node:child_process').spawnSync(process.execPath,
    [path.join(ROOT, 'mobile', 'scripts', 'setup.js')],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, BRIDGE_API_URL: apiUrl } });

  test('adres verilince bridge-config.js üretilir ve uygulama paketinden ÖNCE yüklenir', () => {
    const res = run('http://localhost:3000/');
    expect(res.status).toBe(0);
    const config = fs.readFileSync(path.join(WWW, 'js', 'bridge-config.js'), 'utf8');
    expect(config).toContain('globalThis.BRIDGE_API = "http://localhost:3000";');   // sondaki / atılır
    const sandbox = {};
    require('node:vm').runInNewContext(config, { globalThis: sandbox });
    expect(sandbox.BRIDGE_API).toBe('http://localhost:3000');

    const shell = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
    const configAt = shell.indexOf('<script src="js/bridge-config.js"></script>');
    const moduleAt = shell.indexOf('<script type="module"');
    expect(configAt).toBeGreaterThan(-1);
    expect(moduleAt).toBeGreaterThan(configAt);
    // Görsel/ses API kökeninden gelir; genel `https:` izni http geliştirme sunucusunu kapsamaz.
    expect(shell).toMatch(/img-src[^;]*http:\/\/localhost:3000;/);
    expect(shell).toMatch(/media-src[^;]*http:\/\/localhost:3000;/);
    expect(shell).toMatch(/connect-src[^;]*http:\/\/localhost:3000/);
  });

  test('https üretim adresi kabul edilir', () => {
    const res = run('https://chat.example.com');
    expect(res.status).toBe(0);
    expect(fs.readFileSync(path.join(WWW, 'js', 'bridge-config.js'), 'utf8')).toContain('"https://chat.example.com"');
  });

  // Uygulama kökeni https://localhost: loopback olmayan ws:// KARIŞIK İÇERİK diye engellenir (ölçüldü)
  // ve jetonlar açık metinle taşınırdı. Sessizce yarı çalışan bir derleme yerine derleme durur.
  test.each(['http://10.0.2.2:3000', 'http://192.168.1.20:3000', 'http://chat.example.com'])(
    'loopback olmayan düz http derlemeyi DURDURUR: %s', (insecure) => {
      const res = run(insecure);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/https olmalı/);
    });

  test.each(['javascript:alert(1)', 'ftp://example.com', 'https://example.com/?x=1', 'https://u:p@example.com', 'not a url'])(
    'geçersiz adres derlemeyi DURDURUR: %s', (bad) => {
      const res = run(bad);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(/BRIDGE_API_URL/);
    });

  test('adres yoksa yapılandırma üretilmez ve açık uyarı verilir', () => {
    const res = run('');
    expect(res.status).toBe(0);
    expect(res.stderr + res.stdout).toMatch(/HİÇBİR sunucuya ulaşamaz/);
    expect(fs.existsSync(path.join(WWW, 'js', 'bridge-config.js'))).toBe(false);
    expect(fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')).not.toContain('bridge-config.js');
  });
});

describe('Capacitor yapılandırması — yerel HTTP katmanı (19-28)', () => {
  test('REST ve çerezler yerel HTTP üzerinden (SameSite=strict yenileme çerezi çapraz kökende düşmez)', () => {
    // eslint-disable-next-line global-require
    const root = require(path.join(ROOT, 'capacitor.config.js'));
    expect(root.plugins.CapacitorHttp).toEqual({ enabled: true });
    expect(root.plugins.CapacitorCookies).toEqual({ enabled: true });
    const ts = fs.readFileSync(path.join(ROOT, 'mobile', 'capacitor.config.ts'), 'utf8');
    expect(ts).toMatch(/CapacitorHttp: \{ enabled: true \}/);
    expect(ts).toMatch(/CapacitorCookies: \{ enabled: true \}/);
  });
});

// Final21 Faz 19 (19-28): web kabuğundaki bir HTML yorumu `<script>` METNİ taşıyordu; çıkarım
// düzenli ifadesi yorumun içinden eşleşti ve mobil kabukta "Unexpected identifier 'nonce'" ile
// patlayan bozuk bir satır içi betik üretti — tema önyüklemesi hiç çalışmıyordu (emülatörde ölçüldü).
describeIfBuilt('mobil kabuk — satır içi betikler geçerli JavaScript', () => {
  test('her satır içi betik ayrıştırılabilir ve tema önyüklemesi eksiksiz taşınır', () => {
    const res = require('node:child_process').spawnSync(process.execPath,
      [path.join(ROOT, 'mobile', 'scripts', 'setup.js')], { cwd: ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    // Tarayıcı gibi okunur: düzgün kapanmış yorumlar yok sayılır (şablonun kendi açıklamaları).
    const shell = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const inline = [...shell.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    expect(inline.length).toBeGreaterThan(0);
    for (const code of inline) {
      expect(() => new (require('node:vm').Script)(code)).not.toThrow();
      expect(code).not.toMatch(/etiketine nonce/);
    }
    expect(inline.some((code) => code.includes("var THEMES = ['dark', 'light', 'amoled', 'aurora', 'midnight'];"))).toBe(true);
  });

  // Tema betiğindeki "// <body> henüz yok" yorumu gövde ifadesini yanıltıyordu: betiğin kuyruğu
  // mobil ekranın TEPESİNDE düz metin olarak göründü (emülatör ekran görüntüsüyle ölçüldü).
  test('betik ve yorumlar çıkarılınca sayfa metninde JavaScript KALMAZ', () => {
    // Kabuk BU testte üretilir: başka bir testin bıraktığı dosyaya güvenmek sırayla eski çıktıyı ölçerdi.
    const res = require('node:child_process').spawnSync(process.execPath,
      [path.join(ROOT, 'mobile', 'scripts', 'setup.js')], { cwd: ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    const visible = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '');
    expect(visible).not.toMatch(/document\.addEventListener|\}\)\(\);|henüz yok; hazır olur/);
  });
});

// Final21 Faz 19 (19-28): kabuk `/socket.io/socket.io.js` istiyordu — web'de onu Socket.IO SUNUCUSU verir,
// paketlenmiş uygulamada yol uygulamanın kendi kökenine çözülür ve dosya YOKTUR: `io` tanımsız kaldı,
// gerçek zamanlı her şey öldü ve mesajlar "Bağlantı bekleniyor" durumunda asılı kaldı (emülatörde ölçüldü).
describeIfBuilt('mobil kabuk — Socket.IO istemcisi paketin içinde', () => {
  test('istemci www/js altında, gerçekten `io` tanımlar ve kabuk ona yerel yoldan bağlanır', () => {
    const res = require('node:child_process').spawnSync(process.execPath,
      [path.join(ROOT, 'mobile', 'scripts', 'setup.js')], { cwd: ROOT, encoding: 'utf8' });
    expect(res.status).toBe(0);
    const shell = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    expect(shell).toContain('<script src="js/socket.io.min.js"></script>');
    // Kök-mutlak betik (`src="/…"`) paketlenmiş uygulamada HİÇBİR zaman çözülmez.
    expect(shell).not.toMatch(/<script[^>]+src="\/[^/]/);
    const code = fs.readFileSync(path.join(WWW, 'js', 'socket.io.min.js'), 'utf8');
    const sandbox = { self: {}, window: {}, globalThis: {} };
    sandbox.self = sandbox; sandbox.window = sandbox; sandbox.globalThis = sandbox;
    require('node:vm').runInNewContext(code, sandbox);
    expect(typeof sandbox.io).toBe('function');
  });

  test('istemci sürümü sunucunun KİLİTLİ socket.io sürümüyle aynıdır (protokol eşliği)', () => {
    // eslint-disable-next-line global-require
    const mobile = require(path.join(ROOT, 'mobile', 'package.json')).dependencies['socket.io-client'];
    // eslint-disable-next-line global-require
    const serverLock = require(path.join(ROOT, 'server', 'package-lock.json'));
    expect(mobile).toBe(serverLock.packages['node_modules/socket.io'].version);
  });
});
