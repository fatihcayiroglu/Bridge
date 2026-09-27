// client/tests/i18n-consistency.test.ts
//
// ARAYÜZ DİLİ TUTARLILIĞI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Uygulama Türkçe çalışıyordu ama bazı yüzeyler İNGİLİZCE sabit kodluydu.
// En kötüsü AYNI BİLEŞENİN İÇİNDEYDİ:
//
//   MemberListPanel — başlık "Members", boş durum "No members to show yet.",
//   hata "Members could not be loaded." … ama aria-label'lar "Profili aç".
//   Aynı panelde iki dil.
//
//   SavedPanel — başlık "Saved" / "FOLLOW-UP", gövde Türkçe.
//
// Kullanıcı bunu ses arayüzünde bildirmişti; aynı sınıf kusur başka
// yüzeylerde de duruyordu.
//
// ── BU PAKET NEYİ KİLİTLER ────────────────────────────────────────────────
//   1. `t()` ile kullanılan HER anahtar tr.ts VE en.ts içinde tanımlıdır.
//      Tanımsız anahtar sessizce satır içi yedeğe düşer — yani çeviri
//      sistemi ÇALIŞIYOR görünür ama dil değiştirmek hiçbir şeyi
//      değiştirmez.
//   2. Satır içi yedek metin, TÜRKÇE tablodaki değerle aynı anlamdadır
//      (varsayılan yerel TR'dir; yedek İngilizce olsaydı tablo yüklenene
//      kadar arayüz İngilizce yanıp sönerdi).
//   3. Düzeltilen iki yüzeyde İngilizce sabit metin KALMAMIŞTIR.

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
import { join } from 'path';

const CORE = join(__dirname, '..', 'js', 'core');

const read = (p: string) => readFileSync(p, 'utf8');

/**
 * `t('key', 'yedek')` ve `t('key', 'yedek', { degisken })` çağrılarını çıkarır.
 *
 * ── DÜZELTİLEN AYRIŞTIRICI KUSURU ────────────────────────────────────────
 * Önceki desen, yedek dizeden HEMEN SONRA kapanış parantezi bekliyordu:
 *
 *     t\(\s*'(key)'\s*(?:,\s*(['"`])([\s\S]*?)\2\s*)?\)
 *
 * Üçüncü argüman (değişken nesnesi) eklendiğinde `\)` eşleşmiyor, tembel
 * `[\s\S]*?` ise bir sonraki tırnak+parantez ikilisini bulana kadar SATIRLAR
 * BOYUNCA genişliyordu. Sonuç: yedek metin olarak şablonun yarısı yakalanıp
 * tabloyla karşılaştırılıyor ve test YANLIŞ yere düşüyordu.
 *
 * Artık yedek, kendi tırnak türünü içermeyen bir karakter sınıfıyla yakalanır
 * (yani kapanış tırnağını geçemez) ve kapanış parantezi ŞART DEĞİLDİR.
 */
function extractCalls(src: string): { key: string; fallback: string | null }[] {
  const out: { key: string; fallback: string | null }[] = [];
  const re = /\bt\(\s*'([a-z0-9_]+)'\s*(?:,\s*(['"`])((?:\\.|(?!\2)[\s\S])*)\2)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push({ key: m[1], fallback: m[3] ?? null });
  return out;
}

/** Yerel tablodaki anahtarlar. */
function tableKeys(locale: string): Map<string, string> {
  const src = read(join(CORE, 'i18n', `${locale}.ts`));
  const map = new Map<string, string>();
  // ANAHTARLAR HER İKİ TIRNAKLA DA YAZILIR.
  // Bu desen yalnızca TEK tırnaklı anahtarları görüyordu; sözlüklerin büyük
  // kısmı çift tırnaklıdır (`"ui_bridge_user": "..."`). Sonuç: tablo eksik
  // kuruluyor ve 294 anahtar "tanımsız" sanılıyordu. Kanonik kapı
  // (`scripts/check-i18n-usage.js`) aynı anda "missing referenced key=0"
  // diyordu — çelişkinin tek kaynağı bu regex'ti.
  const re = /(['"])([a-z0-9_]+)\1\s*:\s*(['"])((?:\\.|(?!\3)[\s\S])*)\3/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) map.set(m[2], m[4]);
  return map;
}

const svelteFiles = readdirSync(CORE)
  .filter(f => f.endsWith('.svelte'))
  .map(f => join(CORE, f));

const usingI18n = svelteFiles.filter(f => read(f).includes("from './i18n"));

const tr = tableKeys('tr');
const en = tableKeys('en');

// ════════════════════════════════════════════════════════════════════════════
describe('i18n — anahtar bütünlüğü', () => {
  it('i18n kullanan en az bir bileşen vardır (kontrolün kendisi anlamlı olsun)', () => {
    expect(usingI18n.length).toBeGreaterThan(0);
  });

  it('kullanılan HER anahtar tr.ts içinde tanımlıdır', () => {
    const missing: string[] = [];
    for (const file of usingI18n) {
      for (const { key } of extractCalls(read(file))) {
        if (!tr.has(key)) missing.push(`${file.split(/[\\/]/).pop()}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('kullanılan HER anahtar en.ts içinde tanımlıdır', () => {
    const missing: string[] = [];
    for (const file of usingI18n) {
      for (const { key } of extractCalls(read(file))) {
        if (!en.has(key)) missing.push(`${file.split(/[\\/]/).pop()}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('tr ve en tabloları AYNI anahtar kümesini taşır', () => {
    // Bir tarafta olup diğerinde olmayan anahtar, dil değiştirince
    // İngilizce/Türkçe karışık bir arayüz üretir — düzeltilen kusurun ta
    // kendisi.
    const onlyTr = [...tr.keys()].filter(k => !en.has(k));
    const onlyEn = [...en.keys()].filter(k => !tr.has(k));
    expect({ onlyTr, onlyEn }).toEqual({ onlyTr: [], onlyEn: [] });
  });

  it('satır içi yedek, TÜRKÇE tablo değeriyle aynıdır', () => {
    // Varsayılan yerel TR'dir ve tablo ASENKRON yüklenir. Yedek İngilizce
    // olsaydı, ilk boyamada arayüz İngilizce görünüp sonra Türkçeye
    // dönerdi — kullanıcının bildirdiği "İngilizce metin" belirtisi.
    const mismatched: string[] = [];
    for (const file of usingI18n) {
      for (const { key, fallback } of extractCalls(read(file))) {
        if (fallback === null) continue;
        const expected = tr.get(key);
        if (expected !== undefined && expected !== fallback) {
          mismatched.push(`${key}: yedek="${fallback}" tablo="${expected}"`);
        }
      }
    }
    expect(mismatched).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('i18n — düzeltilen yüzeylerde İngilizce sabit metin kalmadı', () => {
  // Bu iki dosya bilerek adlandırılmıştır: kusur burada ÖLÇÜLDÜ. Tüm
  // istemciyi taramak bu aşamada yanlış olurdu — kalan bileşenler tutarlı
  // biçimde Türkçedir ve toptan i18n geçişi ayrı bir iştir.
  const FIXED = ['MemberListPanel.svelte', 'SavedPanel.svelte', 'VoicePanel.svelte'];

  /** Yalnızca KULLANICIYA GÖRÜNEN metni ayıklar: etiket gövdeleri. */
  function visibleText(src: string): string[] {
    const out: string[] = [];
    const re = />([^<>{}\n]{3,})</g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const text = m[1].trim();
      if (text) out.push(text);
    }
    return out;
  }

  const ENGLISH_MARKERS = [
    /^Members$/, /^Community$/, /^Loading members/, /^Members could not/,
    /^No members/, /^Online$/, /^Offline$/, /^Try again$/, /^Idle$/,
    /^Do not disturb$/, /^Saved$/, /^FOLLOW-UP$/, /^Saved yükleniyor$/,
  ];

  it.each(FIXED)('%s içinde İngilizce sabit arayüz metni yok', (name) => {
    const found = visibleText(read(join(CORE, name)))
      .filter(text => ENGLISH_MARKERS.some(re => re.test(text)));
    expect(found).toEqual([]);
  });
});
