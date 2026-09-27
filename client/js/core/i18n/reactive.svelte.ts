// client/js/core/i18n/reactive.svelte.ts
//
// SVELTE BİLEŞENLERİ İÇİN REAKTİF ÇEVİRİ BAĞLAYICISI
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `i18n/index.ts` içindeki `t()` doğru çalışır ama REAKTİF DEĞİLDİR: modül
// düzeyindeki düz bir `_table` değişkenini okur. Svelte 5'te bir şablon
// ifadesi yalnızca içinde okunan REAKTİF durum değiştiğinde yeniden
// değerlendirilir. Düz modül değişkeni rune değildir.
//
// `i18n-dom.ts` de bu boşluğu kapatmaz: o yalnızca `index.html` içindeki
// `data-i18n` NİTELİKLİ düz DOM düğümlerini günceller (12 düğüm).
//
// Sonuç: kullanıcı Ayarlar'dan dili değiştirdiğinde, ekranda ZATEN duran
// Svelte bileşenlerinin metni ESKİ dilde kalıyordu — sayfa yenilenene ya da
// bileşen yeniden monte edilene kadar. Yani 10 dillik çeviri altyapısı
// vardı, dil seçici vardı, ama seçim ARAYÜZE YANSIMIYORDU.
//
// ── BU İKİNCİ BİR i18n SİSTEMİ DEĞİLDİR ───────────────────────────────────
// Çeviri tabloları, `setLocale`, kalıcılık ve `<html lang>` yönetimi TEK
// SAHİPTE kalır: `i18n/index.ts`. Burada yeni tablo, yeni depolama ya da
// yeni dil listesi YOKTUR. Yalnızca mevcut sahibin yayınladığı değişim
// sinyali, Svelte'in görebileceği bir rune'a bağlanır.
//
// KULLANIM (mevcut çağrılarla birebir aynı imza):
//     import { t } from '../i18n/reactive.svelte.ts';
//     {t('sign_in', 'Giriş yap')}

import { locale, localeTag as rawLocaleTag, t as rawT } from './index';

// Dil her değiştiğinde artan sürüm sayacı. Şablonlar bunu OKUDUĞU için
// Svelte, dil değişiminde ifadeyi yeniden değerlendirir.
let _tick = $state(0);

// Tek abonelik — modül düzeyinde, bileşen ömründen bağımsız.
// `locale.subscribe` abone olur olmaz mevcut değerle bir kez çağırır; bu
// ilk çağrı sayacı artırmamalıdır, yoksa her içe aktarma gereksiz bir
// geçersizleştirme üretir.
let _primed = false;
locale.subscribe(() => {
  if (!_primed) { _primed = true; return; }
  _tick++;
});

/** Test/tanılama için geçerli sürüm sayacı. */
export function localeTick(): number {
  return _tick;
}

/**
 * Reaktif çeviri.
 *
 * `rawT` ile AYNI sözleşme (`key`, isteğe bağlı Türkçe yedek) — mevcut çağrı
 * noktaları birebir taşınabilir. Tek fark, dil değişiminde bileşenin
 * yeniden değerlendirilmesidir.
 *
 * ── ÜÇÜNCÜ PARAMETRE: DEĞİŞKEN YERLEŞTİRME ───────────────────────────────
 * Bazı kullanıcı metinleri değer taşır: "3 okunmamış", "Adım 2",
 * "{grup} grubuna mesaj gönder…". Bunlar dize birleştirmeyle çevrilemez,
 * çünkü SÖZCÜK SIRASI dile göre değişir — İngilizce "Step 2" ile Türkçe
 * "Adım 2" burada benzer görünse de genel olarak birleştirme kırılgandır ve
 * çevirmene cümlenin tamamını göremediği bir yapı dayatır.
 *
 * Bu yüzden metin, ADLI yer tutucularla tek bir çeviri birimi olarak kalır:
 *
 *     t('unread_count', '{count} okunmamış', { count: 3 })
 *
 * Yer tutucu bulunamazsa olduğu gibi bırakılır — sessizce boş dize
 * üretmektense görünür kalması yeğdir.
 */
export function t(
  key: string,
  fallback?: string,
  vars?: Record<string, string | number>,
): string {
  // REAKTİF BAĞIMLILIK, DEĞERİ KULLANILARAK okunur (Final21 Faz 19).
  // Burada eskiden çıplak bir `_tick;` ifadesi vardı. Yan etkisiz bir ifade olduğu için
  // üretim derlemesi (esbuild TS dönüşümü + minify) onu Svelte görmeden SİLİYORDU: paketteki
  // `t()` durumu hiç okumuyordu. Sonuç: İngilizce tarayıcıda açılışta monte edilen bütün
  // bileşenler Türkçe yedek metinde kalıyor, dil değişimi açık bileşenlere yansımıyordu.
  // Birim testleri geliştirme derlemesinde koştuğu için görmüyordu. `_tick` hiçbir zaman
  // negatif değildir; koşul davranışı değiştirmez ama okumanın silinmesini imkânsız kılar.
  // Yerleştirme KANONİK sahipte yapılır (i18n/index.ts).
  return _tick >= 0 ? rawT(key, fallback, vars) : key;
}

export { t as $t };

/** Reactive BCP-47 locale tag for Intl/date/number formatting. */
export function localeTag(): string {
  // `t()` ile aynı neden: okuma değeri kullanılarak yapılır, derleme onu silemez.
  return _tick < 0 ? 'und' : rawLocaleTag(locale.current);
}
