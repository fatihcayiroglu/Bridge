// client/tests/z-index-scale.test.ts
//
// KATMAN SIRASI JETONLARDAN GELİR — SİHİRLİ SAYI TIRMANIŞI YOK
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `tokens.css` temiz bir katman ölçeği tanımlıyordu:
//
//     --z-base 1 · --z-dropdown 100 · --z-sidebar 200 · --z-modal 300
//     --z-toast 400 · --z-tooltip 500 · --z-onboard 600
//
// Ama bileşenler onu KULLANMIYORDU. Bunun yerine klasik tırmanış yarışı
// vardı: 1000 → 1190 → 1200 → 1250 → 1300 → 1450 → 1500 → 2000 → 9000 →
// 9999 → 10000 → 99999. Her yeni yüzey "üstte kalsın" diye bir öncekinden
// büyük bir sayı uyduruyordu.
//
// Bu SOYUT bir temizlik meselesi değildi. Gerçek bir P0 üretti: onboarding
// turu `9999`, boş-sunucu ekranı `10000` kullanıyordu; sunucusu olmayan yeni
// kullanıcıda tur ekranın ALTINDA kalıyor ve `Kapat`/`Atla` düğmeleri FARE
// İLE TIKLANAMIYORDU (Escape çalıştığı için klavye testlerinde görünmüyordu).
//
// ── BU MUHAFIZ NE YAPAR ───────────────────────────────────────────────────
// Ölçeğin TAVANININ üstünde yeni bir sihirli sayı belirmesini engeller.
// Mevcut orta seviye değerler (1000–2000) hâlâ var; hepsini tek seferde
// değiştirmek görsel katmanlanmayı kanıtsız biçimde bozma riski taşırdı.
// Kilitlenen şey: SAYI TIRMANIŞI YENİDEN BAŞLAMASIN.

import { describe, it, expect, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { readFileSync, readdirSync } from 'fs';
import { join, sep } from 'path';

const CLIENT = join(__dirname, '..');

/**
 * "NÜKLEER" eşik: bu ve üstü değerler, her şeyi ezmek için uydurulmuş
 * sayılardır (9000 / 9999 / 10000 / 99999) ve gerçek P0'ı üreten sınıf budur.
 *
 * Eşik 700 (ölçek tavanı) DEĞİL: 1000–2000 aralığında bileşen içi
 * katmanlanma için kullanılan ayrı bir küme var ve hepsini kanıtsız
 * değiştirmek görsel bozulma riski taşır. O küme aşağıdaki SAYI RATCHET'i
 * ile sınırlanır; burada yalnızca tırmanışın tepesi yasaklanır.
 */
const NUCLEAR_THRESHOLD = 9000;

/**
 * Bilinen orta seviye sihirli sayıların TAVANI.
 *
 * Sıfır değil: 1000–2000 aralığındaki mevcut değerler bileşen içi
 * katmanlanma için kullanılıyor ve hepsini kanıtsız değiştirmek görsel
 * bozulma riski taşır. Sayı DÜŞTÜKÇE bu tavan da düşürülmelidir.
 */
const KNOWN_MAGIC_MAX = 53;

interface Hit { file: string; value: number; line: number }

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(svelte|css)$/.test(e.name)) out.push(f);
  }
  return out;
}

function findHardcoded(): Hit[] {
  const hits: Hit[] = [];
  for (const file of [...walk(join(CLIENT, 'js')), ...walk(join(CLIENT, 'css'))]) {
    // Jeton tanımlarının kendisi sayı içerir — dosya muaf.
    if (file.endsWith(join('css', 'tokens.css'))) continue;
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      const m = line.match(/z-index:\s*(\d+)/);
      if (!m) return;
      hits.push({ file: file.replace(CLIENT, '').split(sep).join('/'), value: Number(m[1]), line: i + 1 });
    });
  }
  return hits;
}

// ════════════════════════════════════════════════════════════════════════════
describe('katman ölçeği', () => {
  it('NÜKLEER sihirli sayı YOK (9000+)', () => {
    // Asıl kural bu: 9000/9999/10000/99999 gibi değerler geri gelmemeli.
    const above = findHardcoded().filter(h => h.value >= NUCLEAR_THRESHOLD);
    expect(
      above,
      `ölçek üstü sihirli z-index: ${JSON.stringify(above, null, 2)}`,
    ).toEqual([]);
  });

  it('bilinen sihirli sayı adedi ARTMAZ', () => {
    const hits = findHardcoded();
    expect(
      hits.length,
      `yeni sabit z-index eklendi (${hits.length} > ${KNOWN_MAGIC_MAX})`,
    ).toBeLessThanOrEqual(KNOWN_MAGIC_MAX);
  });

  it('sayı DÜŞTÜĞÜNDE tavan da düşürülmelidir', () => {
    // İlerleme geri alınamaz olsun: iyileşme tavanı da sıkılaştırmalı.
    expect(KNOWN_MAGIC_MAX - findHardcoded().length).toBeLessThanOrEqual(3);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('kritik yüzeyler kanonik jeton kullanır', () => {
  const read = (p: string) => readFileSync(join(CLIENT, p), 'utf8');

  it('ölçek KRİTİK basamağı tanımlar', () => {
    expect(read('css/tokens.css')).toMatch(/--z-critical:\s*\d+/);
  });

  // `--layer-*` jetonları `--z-*` ölçeğinin BELGELİ takma adlarıdır
  // (css/tokens.css: `--layer-modal: var(--z-modal)`), ve canlı yüzeylerde
  // baskın yazımdır. Sözleşme YIĞIN BASAMAĞIdır, hangi yazımın seçildiği
  // değil; tek bir yazımı dayatmak yalnızca yanlış kırmızı üretiyordu.
  const ACCEPTED: Record<string, string[]> = {
    '--z-modal':    ['--z-modal', '--layer-modal'],
    '--z-toast':    ['--z-toast', '--layer-toast'],
    '--z-critical': ['--z-critical'],
  };

  it.each([
    ['js/core/OfflineBanner.svelte',                    '--z-toast'],
    ['js/admin/AdminPanel.svelte',                      '--z-modal'],
    ['js/core/SocketManager.svelte',                    '--z-toast'],
    ['js/core/SearchPanel.svelte',                      '--z-modal'],
    // Faz C2'de `ChannelPermsModal.svelte` KALDIRILDI; kanonik yüzey
    // `ChannelPermsEditor.svelte`. Eski yol testi ENOENT ile düşürüyordu.
    ['js/core/channel-perms/ChannelPermsEditor.svelte', '--z-modal'],
    ['js/core/ErrorBoundary.svelte',                    '--z-critical'],
  ])('%s → %s', (file, token) => {
    const source = read(file);
    const accepted = ACCEPTED[token] ?? [token];
    const hit = accepted.find(name => source.includes(`z-index: var(${name})`));
    expect(hit, `${file} kanonik ${token} basamağını kullanmıyor`).toBeTruthy();
  });

  it('ONBOARDING çakışması geri gelmez', () => {
    // Bu ikisinin ters sırası gerçek P0'ı üretmişti.
    expect(read('js/core/OnboardingWizard.svelte')).toMatch(/z-index:\s*var\(--z-onboard/);
    expect(read('js/core/EmptyServerStart.svelte')).toMatch(/z-index:\s*var\(--z-modal/);
  });
});
