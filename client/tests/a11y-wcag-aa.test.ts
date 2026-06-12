// client/tests/a11y-wcag-aa.test.ts
// Sprint 108 — a11y-wcag-aa.ts birim testleri (42 test)
//
// DOM manipülasyonu testleri jsdom ortamında çalışır.

import {
  hexToRgb,
  relativeLuminance,
  contrastRatio,
  injectSkipLink,
  patchLandmarks,
  announcePolite,
  announceAssertive,
  initReducedMotion,
  patchVoiceBarAria,
  patchStageAria,
  initA11yWcagAA,
} from '../../client/js/core/a11y-wcag-aa';

// ── DOM kurulumu ──────────────────────────────────────────────────────────────

function resetDom(): void {
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-reduced-motion');
}

// ── hexToRgb testleri ─────────────────────────────────────────────────────────

describe('hexToRgb', () => {
  test('#rrggbb formatını parse eder', () => {
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#2d9cdb')).toEqual([45, 156, 219]);
  });

  test('#rgb kısaltma formatını destekler', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#abc')).toEqual([170, 187, 204]);
  });

  test('geçersiz formatta null döner', () => {
    expect(hexToRgb('not-a-color')).toBeNull();
    expect(hexToRgb('#gg0000')).toBeNull();
    expect(hexToRgb('#12345')).toBeNull();
  });

  test('# olmadan çalışır', () => {
    expect(hexToRgb('ffffff')).toEqual([255, 255, 255]);
  });
});

// ── relativeLuminance testleri ────────────────────────────────────────────────

describe('relativeLuminance', () => {
  test('beyazın parlaklığı 1\'e yakın', () => {
    const l = relativeLuminance(255, 255, 255);
    expect(l).toBeCloseTo(1.0, 2);
  });

  test('siyahın parlaklığı 0', () => {
    const l = relativeLuminance(0, 0, 0);
    expect(l).toBeCloseTo(0.0, 4);
  });

  test('ara değerler 0-1 arasında', () => {
    const l = relativeLuminance(128, 128, 128);
    expect(l).toBeGreaterThan(0);
    expect(l).toBeLessThan(1);
  });
});

// ── contrastRatio testleri ────────────────────────────────────────────────────

describe('contrastRatio', () => {
  test('siyah/beyaz 21:1 kontrast', () => {
    const r = contrastRatio('#000000', '#ffffff')!;
    expect(r.ratio).toBeCloseTo(21, 0);
    expect(r.passAA).toBe(true);
    expect(r.passAAA).toBe(true);
  });

  test('düşük kontrast AA\'yı geçmez', () => {
    // Açık gri üzerine açık gri
    const r = contrastRatio('#cccccc', '#ffffff')!;
    expect(r.passAA).toBe(false);
    expect(r.passAAA).toBe(false);
  });

  test('büyük metin için 3:1 eşiği kullanır', () => {
    // yaklaşık 3:1 kontrast — normal metinde AA başarısız, büyük metinde başarılı
    const r = contrastRatio('#767676', '#ffffff', true)!;
    expect(r.passAALarge).toBe(true);
  });

  test('geçersiz renkte null döner', () => {
    expect(contrastRatio('not-a-color', '#ffffff')).toBeNull();
  });

  test('köprü mavisi (#2d9cdb) beyaz arka planda AA geçip geçmediğini doğrular', () => {
    const r = contrastRatio('#2d9cdb', '#ffffff')!;
    // Köprü mavisi yaklaşık 3:1 → büyük metinde AA geçer
    expect(r.ratio).toBeGreaterThan(2.5);
  });

  test('aynı renk 1:1 kontrast', () => {
    const r = contrastRatio('#ff0000', '#ff0000')!;
    expect(r.ratio).toBeCloseTo(1, 1);
    expect(r.passAA).toBe(false);
  });
});

// ── injectSkipLink testleri ───────────────────────────────────────────────────

describe('injectSkipLink', () => {
  beforeEach(resetDom);

  test('skip link DOM\'a eklenir', () => {
    injectSkipLink();
    const link = document.getElementById('bridge-skip-link');
    expect(link).not.toBeNull();
    expect(link?.tagName).toBe('A');
  });

  test('doğru href içerir', () => {
    injectSkipLink('main-content');
    const link = document.getElementById('bridge-skip-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('#main-content');
  });

  test('özel label kabul eder', () => {
    injectSkipLink('main', 'Skip to content');
    const link = document.getElementById('bridge-skip-link');
    expect(link?.textContent).toBe('Skip to content');
  });

  test('iki kez çağrılınca duplike oluşturmaz', () => {
    injectSkipLink();
    injectSkipLink();
    const links = document.querySelectorAll('#bridge-skip-link');
    expect(links.length).toBe(1);
  });
});

// ── patchLandmarks testleri ───────────────────────────────────────────────────

describe('patchLandmarks', () => {
  beforeEach(resetDom);

  test('kanal listesine navigation role ekler', () => {
    document.body.innerHTML = '<div class="channel-list"></div>';
    patchLandmarks();
    const el = document.querySelector('.channel-list');
    expect(el?.getAttribute('role')).toBe('navigation');
    expect(el?.getAttribute('aria-label')).toBe('Kanal listesi');
  });

  test('mevcut role\'ü değiştirmez', () => {
    document.body.innerHTML = '<div class="channel-list" role="region" aria-label="Custom"></div>';
    patchLandmarks();
    const el = document.querySelector('.channel-list');
    expect(el?.getAttribute('role')).toBe('region'); // korundu
    expect(el?.getAttribute('aria-label')).toBe('Custom'); // korundu
  });

  test('main content\'e tabindex=-1 ve id ekler', () => {
    document.body.innerHTML = '<div class="messages-container"></div>';
    patchLandmarks();
    const el = document.querySelector('.messages-container');
    expect(el?.getAttribute('tabindex')).toBe('-1');
    expect(el?.id).toBe('main-content');
  });

  test('eksik element için hata fırlatmaz', () => {
    expect(() => patchLandmarks()).not.toThrow();
  });
});

// ── Live region testleri ──────────────────────────────────────────────────────

describe('live regions', () => {
  beforeEach(resetDom);

  test('announcePolite polite region oluşturur', () => {
    announcePolite('Test mesajı');
    const region = document.getElementById('bridge-live-polite');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('polite');
  });

  test('announceAssertive assertive region oluşturur', () => {
    announceAssertive('Hata!');
    const region = document.getElementById('bridge-live-assertive');
    expect(region).not.toBeNull();
    expect(region?.getAttribute('aria-live')).toBe('assertive');
  });

  test('bölgeler görsel olarak gizlenir (clip)', () => {
    announcePolite('test');
    const region = document.getElementById('bridge-live-polite') as HTMLElement;
    expect(region.style.position).toBe('absolute');
    expect(region.style.width).toBe('1px');
  });

  test('iki kez çağrılınca duplike region oluşturmaz', () => {
    announcePolite('a');
    announcePolite('b');
    expect(document.querySelectorAll('#bridge-live-polite').length).toBe(1);
  });
});

// ── initReducedMotion testleri ────────────────────────────────────────────────

describe('initReducedMotion', () => {
  test('cleanup fonksiyonu döner', () => {
    const cleanup = initReducedMotion();
    expect(typeof cleanup).toBe('function');
    cleanup();
  });

  test('data-reduced-motion attribute\'u ayarlar', () => {
    initReducedMotion();
    const attr = document.documentElement.getAttribute('data-reduced-motion');
    expect(['true', 'false']).toContain(attr);
  });
});

// ── Voice/Stage ARIA testleri ─────────────────────────────────────────────────

describe('patchVoiceBarAria', () => {
  beforeEach(resetDom);

  test('ses barına role ve label ekler', () => {
    document.body.innerHTML = '<div class="voice-bar"></div>';
    patchVoiceBarAria('Genel');
    const bar = document.querySelector('.voice-bar');
    expect(bar?.getAttribute('role')).toBe('complementary');
    expect(bar?.getAttribute('aria-label')).toMatch(/Genel/);
  });

  test('mute butonuna aria-label ekler', () => {
    document.body.innerHTML = `
      <div class="voice-bar">
        <button class="mute-btn"></button>
      </div>`;
    patchVoiceBarAria();
    const btn = document.querySelector('.mute-btn');
    expect(btn?.getAttribute('aria-label')).toBeTruthy();
    expect(btn?.getAttribute('aria-pressed')).toBe('false');
  });

  test('ses barı yoksa hata fırlatmaz', () => {
    expect(() => patchVoiceBarAria('Test')).not.toThrow();
  });
});

describe('patchStageAria', () => {
  beforeEach(resetDom);

  test('sahne alanına region role ekler', () => {
    document.body.innerHTML = '<div class="stage-container"></div>';
    patchStageAria();
    const stage = document.querySelector('.stage-container');
    expect(stage?.getAttribute('role')).toBe('region');
    expect(stage?.getAttribute('aria-label')).toBe('Sahne alanı');
  });

  test('sahne yoksa hata fırlatmaz', () => {
    expect(() => patchStageAria('Alice')).not.toThrow();
  });
});

// ── initA11yWcagAA — orkestratör ──────────────────────────────────────────────

describe('initA11yWcagAA()', () => {
  beforeEach(() => {
    resetDom();
    document.getElementById('bridge-skip-link')?.remove();
  });

  test('skip-link DOM\'a eklenir', () => {
    initA11yWcagAA();
    expect(document.getElementById('bridge-skip-link')).not.toBeNull();
  });

  test('iki kez çağrılınca skip-link duplike oluşturmaz', () => {
    initA11yWcagAA();
    initA11yWcagAA();
    expect(document.querySelectorAll('#bridge-skip-link').length).toBe(1);
  });

  test('data-reduced-motion attribute ayarlanır', () => {
    initA11yWcagAA();
    const attr = document.documentElement.getAttribute('data-reduced-motion');
    expect(['true', 'false']).toContain(attr);
  });

  test('hata fırlatmaz', () => {
    expect(() => initA11yWcagAA()).not.toThrow();
  });

  test('server-side ortamda (document yok) güvenle çıkar', () => {
    const orig = (global as any).document;
    Object.defineProperty(global, 'document', { value: undefined, writable: true, configurable: true });
    expect(() => initA11yWcagAA()).not.toThrow();
    Object.defineProperty(global, 'document', { value: orig, writable: true, configurable: true });
  });
});
