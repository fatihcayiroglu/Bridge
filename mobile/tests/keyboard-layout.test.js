// mobile/tests/keyboard-layout.test.js
//
// ════════════════════════════════════════════════════════════════════════════
// KLAVYE AÇIKKEN DÜZEN — klavye yüksekliği İKİ KEZ telafi edilmez
// ════════════════════════════════════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR (Final21 Faz 19, gerçek emülatörde, WebView DevTools ile):
// Capacitor Keyboard `resize: 'body'` (iOS) ve Android'in pencere yeniden
// boyutlandırması WebView'i klavye kadar ZATEN küçültür. Mobil kabuk bir de
// `body.keyboard-open .msg-input-wrap { margin-bottom: var(--keyboard-height) }`
// ekliyor ve alt gezinmeyi klavye kadar yukarı ötelediyordu. Tablet profili
// (2560x1600): görünüm 408 px, klavye 368 px, besteci `margin-bottom: 368px` →
// mesaj listesi 6 px'e çöktü, besteci başlığın hemen altına kaçtı; marj
// kaldırılınca liste 293 px, besteci klavyenin hemen üstünde (345–408).
// Final20 şablonunda da aynıydı. İşlevsel testlerin hiçbiri düzeni ölçmediği
// için görünmedi (IME adımı yalnızca klavyenin açıldığını denetliyordu).
//
// Kural yapılandırmaya BAĞLIDIR: klavye WebView'i küçültüyorsa (`resize` ≠
// 'none') CSS, `--keyboard-height`i düzen için kullanamaz.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, 'mobile', 'index.template.html');

function templateCss() {
  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  // Yorumlar kural sayılmaz (açıklama metni `var(--keyboard-height)` geçebilir).
  return blocks.join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

function keyboardResizeModes() {
  // eslint-disable-next-line global-require
  const rootConfig = require(path.join(ROOT, 'capacitor.config.js'));
  const tsConfig = fs.readFileSync(path.join(ROOT, 'mobile', 'capacitor.config.ts'), 'utf8');
  const tsResize = (tsConfig.match(/Keyboard:\s*\{[^}]*resize:\s*'([^']+)'/) || [])[1];
  return [rootConfig.plugins?.Keyboard?.resize, tsResize];
}

describe('mobil kabuk — klavye açıkken düzen', () => {
  test('iki Capacitor yapılandırması da klavyede WebView\'i küçültür (resize ≠ none)', () => {
    const modes = keyboardResizeModes();
    expect(modes).toHaveLength(2);
    for (const mode of modes) {
      expect(typeof mode).toBe('string');
      expect(mode).not.toBe('none');
    }
  });

  test('WebView zaten küçülürken hiçbir kural klavye yüksekliğini düzene İKİNCİ KEZ eklemez', () => {
    const offenders = rules(templateCss())
      .flatMap(({ selector, body }) => body.split(';')
        .map((d) => d.trim())
        .filter((d) => /var\(--keyboard-height\)/.test(d))
        .filter((d) => /^(margin|padding|transform|translate|top|bottom|inset|height|max-height|min-height)\b/i.test(d))
        .map((d) => `${selector} { ${d} }`));
    expect(offenders).toEqual([]);
  });

  test('klavye açıkken alt gezinme GİZLENİR (içeriğin üstüne ötelenmez)', () => {
    const nav = rules(templateCss()).filter(({ selector }) => /body\.keyboard-open\s+\.mobile-nav/.test(selector));
    expect(nav.length).toBeGreaterThan(0);
    expect(nav.some(({ body }) => /display\s*:\s*none/.test(body))).toBe(true);
    expect(nav.some(({ body }) => /transform/.test(body))).toBe(false);
  });

  test('gizlenen gezinme için ayrılan .app alt boşluğu da kalkar (besteci klavyeye oturur)', () => {
    // Ölçüldü (küçük telefon): gezinme gizlenince `.app` 60 px alt boşluğu koruyordu; web kabuğunun
    // `html.bridge-keyboard-open .app` kuralı uygulamada hiç devreye girmez (Android'de innerHeight
    // da küçülür, görsel görünüm farkı 0'dır). Yerel sinyal `body.keyboard-open` bunu üstlenir.
    const app = rules(templateCss()).filter(({ selector }) => /body\.keyboard-open\s+\.app\b/.test(selector));
    expect(app.length).toBeGreaterThan(0);
    expect(app.some(({ body }) => /padding-bottom\s*:\s*(0|env\(safe-area-inset-bottom\))\s*$/.test(body.trim().replace(/;$/, '')))).toBe(true);
  });
});
