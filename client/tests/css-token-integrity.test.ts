// client/tests/css-token-integrity.test.ts
// Tasarım Fazı 2 — CSS token bütünlüğü kapısı.
//
// NEDEN VAR: Denetimde kod tabanında 231 yerde TANIMSIZ CSS değişkeni
// kullanıldığı bulundu (--text-3 ×84, --text-1 ×49 …). CSS'te
// `color: var(--tanimsiz)` bildirimi sessizce `inherit`e döner; hiçbir hata
// üretmez. Zincirin kökü `body { color: var(--text-1) }` olduğu için koyu
// temada TÜM metin siyaha düşmüştü (yazar adı 1.40:1 kontrast).
//
// Bu test o sınıf hatayı bir daha sessizce geçirmez. CI/release kapısına
// bağlanabilecek şekilde saf dosya okumasıyla çalışır (tarayıcı gerekmez).

import { describe, it, expect, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'css');

/**
 * Tarayıcının/harici sistemin sağladığı, bizim tanımlamadığımız değişkenler.
 * Buraya ekleme yapmak BİLİNÇLİ bir karardır: değişkenin gerçekten dışarıdan
 * geldiğini veya her kullanımında güvenli bir fallback bulunduğunu doğrula.
 */
const ALLOWLIST = new Set<string>([
  // Svelte bileşenlerinden gelen, kendi scope'unda tanımlı olanlar yok;
  // şu an dışarıdan beslenen bir değişken bulunmuyor.
]);

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return cssFiles(full);
    return full.endsWith('.css') ? [full] : [];
  });
}

interface Usage { token: string; file: string; hasFallback: boolean }

/**
 * Yorumlar taranmaz: dokümantasyon içinde geçen `var(--ornek)` gibi metinler
 * gerçek kullanım değildir ve testi yanlış yere düşürür.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function collect(): { defined: Set<string>; usages: Usage[] } {
  const defined = new Set<string>();
  const usages: Usage[] = [];

  for (const file of cssFiles(CSS_ROOT)) {
    const text = stripComments(readFileSync(file, 'utf8'));

    // Tanımlar: `--ad: değer` (bildirim konumunda).
    for (const m of text.matchAll(/(--[\w-]+)\s*:/g)) defined.add(m[1]);

    // Kullanımlar: `var(--ad)` veya `var(--ad, fallback)`.
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      usages.push({ token: m[1], file: file.slice(CSS_ROOT.length + 1), hasFallback: Boolean(m[2]) });
    }
  }

  return { defined, usages };
}

const { defined, usages } = collect();

describe('CSS token bütünlüğü', () => {
  it('production CSS\'te TANIMSIZ değişken kalmamalı', () => {
    const missing = new Map<string, Set<string>>();

    for (const { token, file, hasFallback } of usages) {
      if (defined.has(token) || ALLOWLIST.has(token)) continue;
      // Fallback'li kullanım (`var(--x, #fff)`) çökmez ama yine de bir
      // tasarım borcudur; burada FAIL saymıyoruz, ayrı testte sayıyoruz.
      if (hasFallback) continue;
      if (!missing.has(token)) missing.set(token, new Set());
      missing.get(token)!.add(file);
    }

    const report = [...missing.entries()]
      .map(([token, files]) => `${token} → ${[...files].slice(0, 3).join(', ')}`)
      .sort();

    expect(report).toEqual([]);
  });

  it('metin ve yüzey seviyeleri her temada tanımlı olmalı', () => {
    // Regresyonun tam merkezindeki değişkenler — biri düşerse hiyerarşi çöker.
    for (const token of ['--text-primary', '--text-2', '--text-muted', '--text-1', '--text-3',
                         '--bg-0', '--bg-1', '--bg-2', '--bg-3', '--bg-4', '--bg-5']) {
      expect(defined.has(token), `${token} tanımlı değil`).toBe(true);
    }
  });

  it('gövde metin rengi tanımlı bir değişkene bağlanmalı', () => {
    // Kök neden buydu: reset-base.css `var(--text-1)` kullanıyordu ve o
    // tanımsızdı → body rengi html'den miras alınıp SİYAH oldu.
    const reset = readFileSync(join(CSS_ROOT, 'modules', 'reset-base.css'), 'utf8');
    const match = reset.match(/body\s*\{[^}]*?color:\s*var\(\s*(--[\w-]+)/s);

    expect(match, 'reset-base.css içinde body color bildirimi bulunamadı').not.toBeNull();
    expect(defined.has(match![1]), `body rengi tanımsız ${match![1]} kullanıyor`).toBe(true);
  });

  it('tanımlı her tema bloğu çekirdek yüzeyleri eksiksiz vermeli', () => {
    const tokens = readFileSync(join(CSS_ROOT, 'tokens.css'), 'utf8');
    const themes = [...tokens.matchAll(/\[data-theme="([a-z]+)"\]/g)].map(m => m[1]);
    const unique = [...new Set(themes)];

    expect(unique.length).toBeGreaterThan(0);

    for (const theme of unique) {
      // Tema bloğunu kabaca ayıkla: selektörden ilk kapanan süslü paranteze.
      const block = tokens.match(new RegExp(`\\[data-theme="${theme}"\\][^{]*\\{([^}]*)\\}`, 's'));
      if (!block) continue;
      // Alias bloğu (birden çok temayı birlikte hedefler) yüzey tanımlamaz;
      // yalnız gerçek tema bloklarını denetle.
      if (!/--bg-0\s*:/.test(block[1])) continue;

      for (const token of ['--bg-0', '--bg-2', '--text-primary', '--text-2', '--text-muted']) {
        expect(new RegExp(`${token}\\s*:`).test(block[1]), `${theme} temasında ${token} yok`).toBe(true);
      }
    }
  });
});

describe('CSS token borç ölçümü', () => {
  it('fallback\'li kullanım sayısı raporlanır (bilgi amaçlı, kapı değil)', () => {
    const withFallback = usages.filter(u => !defined.has(u.token) && u.hasFallback);
    // Kapı değil: yalnızca sayının patlamadığını görmek için üst sınır.
    expect(withFallback.length).toBeLessThan(80);
  });
});
