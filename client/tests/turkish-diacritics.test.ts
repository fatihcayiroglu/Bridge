// client/tests/turkish-diacritics.test.ts
//
// GÖRÜNEN TÜRKÇE METİN, TÜRKÇE KARAKTERLERİYLE YAZILIR
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Arama panelinde kullanıcıya gösterilen metinler ASCII'ye indirgenmişti:
//
//     "Sonuc bulunamadi"
//     "Farkli bir kelime deneyin. Arama yalnizca gorebildiginiz
//      konusmalari kapsar."
//     "Daha fazla sonuc var — aramanizi daraltin."
//
// Doğrusu: "Sonuç bulunamadı", "Farklı", "yalnızca", "görebildiğiniz",
// "konuşmaları", "aramanızı", "daraltın".
//
// Bu bir kod kusuru değil, ÜRÜN KALİTESİ kusurudur: Türkçe arayüz kullanan
// birine yarım yazılmış bir dil gösterir ve ürünü özensiz hissettirir. Aynı
// hata bot pazaryerinde de vardı ("Yukleniyor...", "Sonuc bulunamadi").
//
// ── KAPSAM ────────────────────────────────────────────────────────────────
// Yalnızca ŞABLONDAKİ GÖRÜNEN metin taranır. `<script>` blokları ve yorumlar
// hariç tutulur: kaynak yorumlarının ASCII yazılması bir ürün kusuru değildir
// ve taramaya karışırsa muhafız gürültüye boğulup işe yaramaz hale gelir.
//
// Kelime listesi KASITLI OLARAK dar: yalnızca DOĞRU yazımı Türkçe karakter
// GEREKTİREN kelimeler. "deneyin" gibi zaten ASCII olan doğru kelimeler
// listeye girmez — aksi halde doğru metni kusur sayardık.

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

/** Doğru yazımı Türkçe karakter GEREKTİREN kelimeler. */
const ASCII_STRIPPED = [
  'Sonuc', 'sonuc', 'bulunamadi', 'Farkli', 'farkli', 'yalnizca',
  'gorebildiginiz', 'konusmalari', 'yanitlarinda', 'aramanizi', 'daraltin',
  'sirasinda', 'olustu', 'kullanilamiyor', 'Yukleniyor', 'yukleniyor',
  'Baglanti', 'baglanti', 'Cikis', 'Gonder', 'gonder', 'Duzenle', 'duzenle',
  'Kullanici', 'kullanici', 'Basarili', 'basarisiz', 'Secili', 'secili',
  'Dogrula', 'dogrula', 'Uyeler', 'uyeler', 'Ayrildi', 'ayrildi',
  // Final21 Phase 14: found in the Turkish dictionary (bot marketplace header/sort/plugins).
  'guclendir', 'Populer', 'populer', 'Yuksek', 'yuksek', 'Yuklu', 'yuklu',
];

/** `<script>` ve `<style>` bloklarını ve yorumları atar; şablon kalır. */
function templateOnly(src: string): string {
  return src
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Şablondaki görünen metin düğümleri. */
function visibleText(src: string): string[] {
  const out: string[] = [];
  for (const m of templateOnly(src).matchAll(/>([^<>{}]+)</g)) {
    const text = m[1].trim();
    if (!text) continue;
    if (/^[\s\d.,:;!?()[\]/|—–-]*$/.test(text)) continue;   // noktalama/sayı
    out.push(text);
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (f.endsWith('.svelte')) out.push(f);
  }
  return out;
}

interface Offence { file: string; text: string; word: string }

function findOffences(): Offence[] {
  const out: Offence[] = [];
  for (const file of walk(join(CLIENT, 'js'))) {
    const src = readFileSync(file, 'utf8');
    for (const text of visibleText(src)) {
      const word = ASCII_STRIPPED.find((w) => text.includes(w));
      if (word) {
        out.push({ file: file.replace(CLIENT, '').split(sep).join('/'), text: text.slice(0, 80), word });
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
describe('görünen Türkçe metin doğru yazılır', () => {
  it('ASCII\'ye indirgenmiş Türkçe kelime YOK', () => {
    const offences = findOffences();
    expect(
      offences,
      `ASCII'ye indirgenmiş Türkçe: ${JSON.stringify(offences, null, 2)}`,
    ).toEqual([]);
  });

  it('Türkçe SÖZLÜK değerlerinde de ASCII\'ye indirgenmiş kelime YOK', () => {
    // Şablon metni t() çağrılarına taşındıkça görünen Türkçe artık tr.ts'te yaşıyor;
    // yalnız şablonu tarayan muhafız "Sunucunu guclendir", "En Populer" gibi değerleri
    // göremedi (Final21 Faz 14, pazaryeri ekran görüntüsünde bulundu).
    const dictionary = readFileSync(join(CLIENT, 'js/core/i18n/tr.ts'), 'utf8');
    const offences: string[] = [];
    for (const m of dictionary.matchAll(/^\s*["']([\w.-]+)["']\s*:\s*(["'])((?:\\.|(?!\2).)*)\2/gm)) {
      // Identifier-shaped values are examples of usernames/handles, which are ASCII by rule
      // (FriendsPanel placeholder "kullanici_adi"); they are not prose.
      if (/^[a-z0-9_.-]+$/.test(m[3])) continue;
      const word = ASCII_STRIPPED.find((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'u').test(m[3]));
      if (word) offences.push(`${m[1]} = ${m[3]} (${word})`);
    }
    expect(offences, `tr.ts ASCII'ye indirgenmiş: ${offences.join('; ')}`).toEqual([]);
    // Pozitif kontrol: aynı eşleştirici kusurlu değeri yakalar, doğrusunu yakalamaz.
    const flags = (value: string) => ASCII_STRIPPED.some((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, 'u').test(value));
    expect(flags('Sunucunu guclendir')).toBe(true);
    expect(flags('Sunucunu güçlendir')).toBe(false);
  });

  it('MUHAFIZ ÇALIŞIYOR — kusurlu metin yakalanır', () => {
    // Pozitif kontrol: tarayıcı bozulursa yukarıdaki test boş liste görüp
    // sessizce geçerdi.
    const bad = '<p class="x">Sonuc bulunamadi</p>';
    const found = visibleText(bad).some((t) => ASCII_STRIPPED.some((w) => t.includes(w)));
    expect(found, 'muhafız kusurlu metni kaçırıyor').toBe(true);
  });

  it('DOĞRU Türkçe işaretlenmez', () => {
    const good = '<p>Sonuç bulunamadı. Farklı bir kelime deneyin.</p>';
    const flagged = visibleText(good).some((t) => ASCII_STRIPPED.some((w) => t.includes(w)));
    expect(flagged, 'doğru yazım yanlışlıkla işaretlendi').toBe(false);
  });

  it('KAYNAK YORUMLARI taranmaz', () => {
    // Yorumların ASCII yazılması ürün kusuru değildir; taranırsa muhafız
    // gürültüye boğulur ve gerçek kusurlar kaybolur.
    const withComment = `
      <!-- Sonuc bulunamadi durumunda ne olur -->
      <script>const x = 'Sonuc bulunamadi';</script>
      <p>Sonuç bulunamadı</p>
    `;
    const flagged = visibleText(withComment).some((t) => ASCII_STRIPPED.some((w) => t.includes(w)));
    expect(flagged).toBe(false);
  });

  it('DÜZELTİLEN yüzeyler temiz', () => {
    const fixed = findOffences().map((o) => o.file);
    expect(fixed).not.toContain('/js/core/GlobalSearchPanel.svelte');
    expect(fixed).not.toContain('/js/core/bot-marketplace/BotMarketplace.svelte');
  });
});
