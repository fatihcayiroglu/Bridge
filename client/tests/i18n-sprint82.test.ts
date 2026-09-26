// client/tests/i18n-sprint82.test.ts
// core/i18n — CANLI sözleşme testleri (native Vitest/ESM).
//
// ════════════════════════════════════════════════════════════════════════════
// FAZ 12 — KISMİ MIGRATION (PARTIAL_MIGRATE)
// ════════════════════════════════════════════════════════════════════════════
//
// ÇÖKME NEDENİ: dosya kendi `test()`/`expect()` runner'ını taşıyordu ve
// Vitest'e HİÇ suite kaydetmiyordu → "No test suite found" (NO_SUITE).
// Jest/CJS uyumsuzluğu DEĞİLDİ; 20 iddia stdout'a `✓` basıp geçiyor ama
// hiçbir sayıma girmiyordu.
//
// AYRICA: eski dosya üretimden HİÇBİR ŞEY import etmiyordu. Test ettiği
// `detectLocale`, `interpolate`, `formatPlural`, `EN_REQUIRED_KEYS`,
// `SUPPORTED_LOCALES` (dizi) sembollerinin tamamı test dosyasının İÇİNDE
// yeniden tanımlanmıştı.
//
// ESKİ 20 İDDİANIN BUGÜNKÜ DURUMU (js/core/i18n/index.ts, satır kanıtlı):
//   1–3  desteklenen diller  → STALE: üretimde 10 locale ve Record<Locale,string>
//                              (:13-24), eski test 9 ve dizi varsayıyordu
//   4–6  EN_REQUIRED_KEYS    → DEAD: üretim karşılığı yok
//   7–10 detectLocale        → MOVED+STALE: `_detectLocale` (:65-73) PRIVATE ve
//                              varsayılanı 'tr'; eski test 'en' fallback diyordu
//   11–14 interpolate        → DEAD: `t()` interpolasyon YAPMAZ (:115-117)
//   15–17 formatPlural       → DEAD: çoğullama YOK
//   18–20 çeviri içeriği     → DEAD: yerel örnek veri üzerinde çalışıyordu
//
// KORUNAN CANLI SÖZLEŞME (gerçek import ile): SUPPORTED_LOCALES · t() arama,
// fallback ve eksik-anahtar davranışı · locale okuma/abonelik · $t takma adı.
//
// GÜVENLİK GÖZLEMİ: `t()` interpolasyon yapmadığı için çeviri metnine
// kullanıcı kontrollü değişken enjekte edilen bir yol YOKTUR. Üretim kodu bu
// turda değiştirilmemiştir.

import { describe, it, expect } from 'vitest';
import { SUPPORTED_LOCALES, locale, t, $t, type Locale } from '../js/core/i18n/index.ts';

describe('SUPPORTED_LOCALES — canlı locale kümesi', () => {
  it('Record<Locale,string> biçimindedir (dizi DEĞİL)', () => {
    // Eski test bunu dizi sanıyordu; üretim sözleşmesi nesnedir (index.ts:13).
    expect(Array.isArray(SUPPORTED_LOCALES)).toBe(false);
    expect(typeof SUPPORTED_LOCALES).toBe('object');
  });

  it('bugünkü 10 dili içerir', () => {
    const codes = Object.keys(SUPPORTED_LOCALES).sort();

    expect(codes).toEqual(['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'tr', 'zh']);
  });

  it('her locale için görünen ad taşır', () => {
    for (const [code, label] of Object.entries(SUPPORTED_LOCALES)) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(code).toMatch(/^[a-z]{2}$/);
    }
  });

  it('en ve tr her zaman desteklenir (fallback zinciri buna dayanır)', () => {
    // _loadLocale hata durumunda en'e düşer (:52-55); _detectLocale varsayılanı tr (:72).
    expect(SUPPORTED_LOCALES).toHaveProperty('en');
    expect(SUPPORTED_LOCALES).toHaveProperty('tr');
  });
});

describe('t() — arama, fallback, eksik anahtar', () => {
  it('bilinmeyen anahtar için ANAHTARIN KENDİSİNİ döndürür', () => {
    // Sözleşme: _table[key] ?? fallback ?? key  (index.ts:116)
    expect(t('kesinlikle_olmayan_anahtar_xyz')).toBe('kesinlikle_olmayan_anahtar_xyz');
  });

  it('fallback verilmişse bilinmeyen anahtarda onu döndürür', () => {
    expect(t('kesinlikle_olmayan_anahtar_xyz', 'Yedek Metin')).toBe('Yedek Metin');
  });

  it('boş string fallback anahtar yerine geçer', () => {
    // '' nullish DEĞİLDİR; ?? zinciri onu geçerli sayar.
    expect(t('yok_boyle_bir_anahtar_2', '')).toBe('');
  });

  it('her zaman string döndürür', () => {
    expect(typeof t('herhangi_bir_anahtar')).toBe('string');
  });

  it('INTERPOLASYON YAPMAZ — şablon değişkeni olduğu gibi kalır', () => {
    // Eski testteki `interpolate` üretimde YOKTUR. Bu davranış geri gelirse
    // (ve escape edilmezse) güvenlik incelemesi gerekir.
    expect(t('merhaba {name}', 'merhaba {name}')).toBe('merhaba {name}');
  });

  it('$t, t ile AYNI fonksiyondur', () => {
    // index.ts:122 — `export { t as $t }`
    expect($t).toBe(t);
  });
});

describe('locale — okuma ve abonelik', () => {
  it('current desteklenen bir locale\'dir', () => {
    expect(Object.keys(SUPPORTED_LOCALES)).toContain(locale.current);
  });

  it('loading boolean\'dır', () => {
    expect(typeof locale.loading).toBe('boolean');
  });

  it('subscribe abone olur olmaz MEVCUT değerle çağrılır', () => {
    const seen: Locale[] = [];

    const unsubscribe = locale.subscribe(loc => { seen.push(loc); });

    expect(seen).toHaveLength(1);              // hemen çağrı (index.ts:94)
    expect(seen[0]).toBe(locale.current);
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });

  it('unsubscribe sonrası dinleyici kaydı bırakmaz', () => {
    const seen: Locale[] = [];
    const unsubscribe = locale.subscribe(loc => { seen.push(loc); });
    unsubscribe();

    // Tekrar abone olup bırakmak birikmeye yol açmamalı.
    const second = locale.subscribe(() => {});
    second();

    expect(seen).toHaveLength(1);
  });
});
