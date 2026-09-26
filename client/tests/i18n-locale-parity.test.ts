// client/tests/i18n-locale-parity.test.ts
//
// STABLE LOCALE BÜTÜNLÜĞÜ + i18n ERİŞİM RATCHET'İ
//
// Bridge production arayüzü 10 stable locale yayınlar. Bu test iki ayrı
// sözleşmeyi korur:
//   1. Her stable locale canonical EN anahtar setiyle birebir paritededir.
//   2. Kullanıcıya görünen Svelte metinleri i18n yolunu atlayıp yeniden
//      hard-code edilmez.
//
// Çeviri tablolarının dilsel kalite/placeholder/fallback oranı için ayrıca
// `scripts/check-i18n-parity.js` release/CI gate'i çalışır. Buradaki kaynak
// taraması ise tamamlanmış i18n göçünün geri alınmasını engelleyen ratchet'tir.

import { describe, it, expect, vi } from 'vitest';
// ── KAYNAK TARAMASI G/Ç BAĞLIDIR ────────────────────────────────────────────
// Bu dosyadaki testler istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik
// VARSAYILAN zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir
// makinede aşılabilir; ölçüm bitmeden test kırmızıya döner ve bu, ürün hakkında
// HİÇBİR ŞEY söylemeyen bir kırılganlıktır. Sözleşme taramanın SONUCUNDA
// olduğu için bu dosyaya açık ve cömert bir zaman aşımı verilir. Hiçbir iddia
// gevşetilmemiştir; yalnızca zamanlama gürültüsü kaldırılmıştır.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import fs from 'fs';
import vm from 'node:vm';

/** Satir ayirici — kabuk kacislarindan etkilenmemesi icin ayri sabit. */
const SPLIT_LINES = new RegExp(String.fromCharCode(92) + 'r?' + String.fromCharCode(92) + 'n');
import path from 'path';

const I18N_DIR = path.join(__dirname, '..', 'js', 'core', 'i18n');
const CLIENT_JS = path.join(__dirname, '..', 'js');

/** Stable locale object literalini gerçek JS olarak okur; regex ile anahtar kaçırmaz. */
function readLocale(name: string): Map<string, string> {
  const src = fs.readFileSync(path.join(I18N_DIR, `${name}.ts`), 'utf8');
  const marker = /const\s+translations\s*:\s*Record<string,\s*string>\s*=\s*/;
  const match = marker.exec(src);
  if (!match) throw new Error(`${name}: translations object bulunamadı`);
  const start = match.index + match[0].length;
  const exportAt = src.indexOf('export default translations', start);
  const end = src.lastIndexOf(';', exportAt);
  const literal = src.slice(start, end).trim();
  const table = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 }) as Record<string, string>;
  return new Map(Object.entries(table));
}

function walkSvelte(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '_archived_legacy' || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkSvelte(p, out);
    else if (e.name.endsWith('.svelte')) out.push(p);
  }
  return out;
}

const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

/** Yalnızca KULLANICIYA GÖRÜNEN metin: şablon gövdesi + erişilebilirlik metni. */
function visibleTurkishStrings(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const tpl = src.includes('</script>') ? src.slice(src.indexOf('</script>')) : src;
  const found: string[] = [];
  for (const m of tpl.matchAll(/>([^<>{}\n]{3,80})</g)) {
    const t = m[1].trim();
    if (t && TURKISH.test(t)) found.push(t);
  }
  for (const m of tpl.matchAll(/(?:aria-label|title|placeholder|alt)="([^"]{3,80})"/g)) {
    if (TURKISH.test(m[1])) found.push(m[1]);
  }
  return found;
}

describe('dil tabloları — bütünlük', () => {
  // Yalnizca GERCEK dil tablolari. Dizinde ayrica `index.ts` (sahip) ve
  // `reactive.svelte.ts` (Svelte baglayicisi) bulunur; bunlar dil tablosu
  // DEGILDIR ve parite/boyut denetimine girmemelidir.
  const locales = fs.readdirSync(I18N_DIR)
    .filter(f => /^[a-z]{2}\.ts$/.test(f))
    .map(f => f.replace(/\.ts$/, ''));

  it('beklenen diller mevcut', () => {
    expect(locales.sort()).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh']);
    expect(locales.length).toBe(10);
  });

  it('10 stable locale canonical EN anahtar setiyle tam PARİTEDE', () => {
    // KANITLAR: stable locale tabloları eksik/ekstra anahtar nedeniyle ham key sızdırmaz.
    // Kullanıcı yüzeylerinin i18n yolunda kalması aşağıdaki sıfır-tavan ratchet ile ayrıca korunur.
    const en = readLocale('en');
    // Bu iddianın amacı AYRIŞTIRMANIN çalıştığını doğrulamaktır, sözlüğün
    // boyutunu DONDURMAK değil. Sabit bir sayı (867) her meşru anahtar
    // eklemesinde kırılıyor ve insanları sayıyı büyütmeye alıştırıyordu —
    // yani kapı, koruduğu şeyi değil kendi sabitini ölçüyordu. Asıl sözleşme
    // aşağıdaki PARİTE döngüsüdür.
    expect(en.size, 'en tablosu boş — ayrıştırma bozuldu').toBeGreaterThan(500);
    for (const loc of locales) {
      const table = readLocale(loc);
      const missing = [...en.keys()].filter(k => !table.has(k));
      const extra = [...table.keys()].filter(k => !en.has(k));
      // Sözleşme: her locale EN ile TAM aynı anahtar kümesine sahiptir.
      // Boyut, EN'in boyutuyla karşılaştırılır — sabit bir sayıyla değil.
      expect({ loc, size: table.size, missing, extra })
        .toEqual({ loc, size: en.size, missing: [], extra: [] });
    }
  });

  it('hiçbir dilde BOŞ çeviri değeri yok', () => {
    for (const loc of locales) {
      const table = readLocale(loc);
      const empty = [...table.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k);
      expect({ loc, empty }).toEqual({ loc, empty: [] });
    }
  });

  it('her dil tablosu ANLAMLI büyüklükte', () => {
    // Boş/bozuk bir tablo sessizce ham anahtar sızdırır.
    for (const loc of locales) {
      const size = readLocale(loc).size;
      expect({ loc, tooSmall: size < 50 }).toEqual({ loc, tooSmall: false });
    }
  });
});

describe('i18n göç ölçeri — sabit kodlu Türkçe TAVANI', () => {
  // ══════════════════════════════════════════════════════════════════════════
  // RATCHET: bu sayı ARTAMAZ.
  // ══════════════════════════════════════════════════════════════════════════
  // ── GOC TAMAMLANDI ────────────────────────────────────────────────────
  // Olculen taban 387 dize / 60 dosya idi; goc bittiginde 0 / 0 oldu.
  // Tavan artik SIFIR: kullaniciya gorunen YENI bir sabit Turkce dize
  // eklenirse bu test DUSER. Ceviri tablosuna tasinmasi gerekir.
  const MAX_HARDCODED_TR = 0;
  const MAX_FILES = 0;

  const files = walkSvelte(CLIENT_JS);
  const perFile = files
    .map(f => ({ file: path.relative(CLIENT_JS, f), hits: visibleTurkishStrings(f).length }))
    .filter(r => r.hits > 0)
    .sort((a, b) => b.hits - a.hits);
  const total = perFile.reduce((s, r) => s + r.hits, 0);

  it(`sabit kodlu Türkçe dize sayısı ${MAX_HARDCODED_TR} tavanını AŞMIYOR`, () => {
    // Başarısızlıkta en yoğun dosyalar görünür olsun.
    const top = perFile.slice(0, 5).map(r => `${r.hits} ${r.file}`);
    expect({ total, top: total > MAX_HARDCODED_TR ? top : [] })
      .toEqual({ total: expect.any(Number), top: [] });
    expect(total).toBeLessThanOrEqual(MAX_HARDCODED_TR);
  });

  it(`etkilenen dosya sayısı ${MAX_FILES} tavanını AŞMIYOR`, () => {
    expect(perFile.length).toBeLessThanOrEqual(MAX_FILES);
  });

  it('t() kullanımı ORTADAN KALKMAMIŞ — i18n yolu canlı', () => {
    // Ratchet tek başına yanıltıcı olabilir: `t()` çağrıları silinip metin
    // sabitlenirse sayı artar ve test düşer; ama tersine, i18n altyapısının
    // sessizce terk edilmediğini de doğrulamak gerekir.
    let tCalls = 0;
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      tCalls += (src.match(/\bt\(\s*['`]/g) ?? []).length;
    }
    expect(tCalls, 'i18n çağrıları azaldı — göç geriye alınmış olabilir')
      .toBeGreaterThanOrEqual(400);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SCRIPT BLOGU KOR NOKTASI — GERILEME KILIDI
// ════════════════════════════════════════════════════════════════════════════
// Bu programda olculen bir olcum hatasi: ilk tarayici yalnizca SABLON
// govdesini (`</script>` sonrasi) inceliyordu ve "%100 tamamlandi" diyordu.
// Oysa kullaniciya gorunen bircok metin script blogunda VERI olarak yasar:
// toast/onay mesajlari, onboarding adimlari, varlik (presence) etiketleri.
//
// Kusur ancak GERCEK TARAYICIDA ortaya cikti: Ingilizce arayuzde Turkce
// metin goruldu. Bu testler o kor noktayi kalici olarak kapatir.
describe('i18n — script blogu kor noktasi', () => {
  // Yalnizca GERCEK cagri: sink'in ILK argumani duz bir dize literali olmali.
  // Yorum icinde gecen `toast()` gibi ifadeler bu desene UYMAZ — onceki
  // surumde yorum siyirma tek basina yetmemis ve yanlis pozitif uretmisti.
  const SINK = /\b(toast|showToast|notify|alert|confirm|showError|setError)\s*\(\s*['"`]/;

  function scriptRegion(file: string): string {
    const src = fs.readFileSync(file, 'utf8');
    const region = file.endsWith('.svelte')
      ? (src.indexOf('</script>') === -1 ? '' : src.slice(0, src.indexOf('</script>')))
      : src;
    // YORUMLARI SOY. Aciklama amaciyla `toast()` gecen ve Turkce iceren bir
    // yorum satiri gercek bir ihlal DEGILDIR. (Bu tam olarak yasandi.)
    return region
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(SPLIT_LINES)
      .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join(String.fromCharCode(10));
  }

  function allSources(): string[] {
    const out: string[] = [];
    (function walk(d: string) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '_archived_legacy' || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|svelte)$/.test(e.name) && !/[\/]i18n[\/]/.test(p)) out.push(p);
      }
    })(CLIENT_JS);
    return out;
  }

  // ── KAYNAK TARAMASI G/Ç BAĞLIDIR, ZAMANLAMA İDDİASI DEĞİLDİR ────────────
  // Bu test tüm istemci ağacını dosya dosya okur. Vitest'in 5 sn'lik varsayılan
  // zaman aşımı, kapsam enstrümantasyonu altında ya da yüklü bir makinede
  // AŞILABİLİR ve tarama bitmeden test kırmızıya döner. Ölçülen sözleşme
  // sürede değil, taramanın SONUCUNDA olduğu için açık ve cömert bir zaman
  // aşımı verilir; hiçbir iddia gevşetilmez.
  it('EKRANA CIKAN cagrilarda sabit Turkce metin YOK', () => {
    // toast/confirm/alert gibi cagrilarin icindeki duz Turkce dizeler,
    // Ingilizce secen kullaniciya Turkce olarak gorunur.
    const offenders: string[] = [];
    for (const f of allSources()) {
      for (const line of scriptRegion(f).split('\n')) {
        if (!TURKISH.test(line) || !SINK.test(line)) continue;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        // Ceviriden geciyorsa sorun yok.
        if (/\bt\(\s*['"`]/.test(line)) continue;
        offenders.push(path.relative(CLIENT_JS, f) + ': ' + line.trim().slice(0, 60));
      }
    }
    expect({ offenders }).toEqual({ offenders: [] });
  }, 60_000);

  it('varlik (presence) etiketleri ceviriden gelir', () => {
    // Bu harita gercek tarayicida "Cevrimici" sizintisinin kaynagiydi.
    const src = fs.readFileSync(path.join(CLIENT_JS, 'core', 'auth-compat.ts'), 'utf8');
    expect(src).toContain("t('presence_online'");
    expect(src).not.toMatch(/online:\s*'Çevrimiçi'/);
  });

  it('onboarding adimlari ceviriden gelir ve dile TEPKI VERIR', () => {
    // Adimlar sabit bir dizi olsaydi ceviriler modul yuklenirken bir kez
    // hesaplanir, dil degisiminde guncellenmezdi.
    const src = fs.readFileSync(path.join(CLIENT_JS, 'core', 'OnboardingWizard.svelte'), 'utf8');
    expect(src).toContain("t('onb_s1_title'");
    expect(src).toContain('const STEPS: Step[] = $derived(');
  });
});
