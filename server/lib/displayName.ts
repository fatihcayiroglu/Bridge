// server/lib/displayName.ts
//
// KANONİK GÖRÜNEN AD TEMİZLEYİCİSİ
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK AÇIK (P2 — sosyal üründe kimlik taklidi)
// ════════════════════════════════════════════════════════════════════════════
// `username` ASCII ile sınırlıdır (/^[a-zA-Z0-9_]+$/), ama `displayName`
// yalnızca `{ type: 'string', max: 80 }` ile doğrulanıyordu. Kullanıcıların
// GÖRDÜĞÜ ad budur: üye listesi, mesaj başlığı, mention, ses katılımcıları,
// moderasyon kayıtları.
//
// ── CANLI SUNUCUDA ÖLÇÜLDÜ (e2e/_identity-spoof.cjs — 8 vektörden 7'si kabul)
//   Kiril homoglifi     U+0410 + "dmin"        Latin "Admin" ile piksel aynı
//   Yunan homoglifi     U+039C + "oderator"
//   Sıfır genişlikli    "Ad" + U+200B + "min"  ekranda "Admin"
//   ZWJ                 "Ad" + U+200D + "min"  ekranda "Admin"
//   RTL override        "user" + U+202E + "gnp.exe"  →  ekranda "userexe.png"
//   Zalgo               taşan birleştirici işaret yığını
//   Tam genişlik        U+FF21 + "dmin"
//
// ── TASARIM: ORANTILI SAVUNMA ───────────────────────────────────────────────
// Uluslararası adları YASAKLAMIYORUZ. Ayrım şudur:
//
//   GÖRÜNMEZ / YAPISAL karakterler → adın parçası değildir, KALDIRILIR:
//     bidi geçersiz kılmaları, sıfır genişlikli karakterler, kontrol
//     karakterleri, taşan birleştirici yığınları.
//
//   MEŞRU YAZI SİSTEMLERİ → korunur:
//     Kiril "Аdmin" GEÇERLİ Kiril metnidir ve reddedilmez. Homoglifleri
//     karakter yasaklayarak çözmek, Kiril/Yunan/Türkçe adları kullanan
//     gerçek kullanıcıları cezalandırırdı.
//
// ── HOMOGLİFLER İÇİN MİMARİ CEVAP ───────────────────────────────────────────
// Görünen ad bir KİMLİK GARANTİSİ DEĞİLDİR; benzersiz `username` odur.
// Bu dosya görsel HİLEYİ kaldırır; kimlik garantisini `username` sağlar.
//
// ── NEDEN DESENLER SAYISAL KURULUYOR ────────────────────────────────────────
// Bu kod noktaları KASITLI olarak sayısal olarak yazılmıştır. Kaynağa düz
// karakter konması dosyayı `grep` açısından ikili (binary) yapıyor ve gözden
// geçirenin tam olarak hangi kod noktalarının engellendiğini görmesini
// imkânsız kılıyordu — görünmez karakterleri görünmez biçimde engellemek.

/** Görünen adın izin verilen azami uzunluğu (mevcut davranışla aynı). */
export const DISPLAY_NAME_MAX = 32;

/** Bir karakterden sonra izin verilen azami ardışık birleştirici işaret. */
const MAX_COMBINING_RUN = 2;

/** [başlangıç, bitiş] kod noktası aralıklarından karakter sınıfı üretir. */
function charClass(ranges: ReadonlyArray<readonly [number, number]>, flags: string): RegExp {
  const body = ranges
    .map(([a, b]) => (a === b
      ? '\\u' + a.toString(16).padStart(4, '0')
      : '\\u' + a.toString(16).padStart(4, '0') + '-\\u' + b.toString(16).padStart(4, '0')))
    .join('');
  return new RegExp('[' + body + ']', flags);
}

/**
 * Bidi (iki yönlü metin) denetim karakterleri.
 *   U+202A..U+202E  gömme / geçersiz kılma
 *   U+2066..U+2069  yalıtma
 *   U+200E, U+200F  soldan-sağa / sağdan-sola işareti
 *   U+061C          Arapça harf işareti
 * Görünen adda meşru kullanımları yoktur; metni GÖRSEL OLARAK ters çevirip
 * başka bir kimlik veya dosya uzantısı gibi göstermeye yararlar.
 */
const BIDI_RANGES = [
  [0x202a, 0x202e], [0x2066, 0x2069], [0x200e, 0x200f], [0x061c, 0x061c],
] as const;

/**
 * Sıfır genişlikli ve biçim karakterleri.
 *   U+200B ZWSP · U+200C ZWNJ · U+200D ZWJ · U+2060 kelime birleştirici
 *   U+FEFF BOM  · U+180E Moğol sesli ayırıcı
 *
 * BİLİNÇLİ ÖDÜNLEŞİM: ZWNJ ve ZWJ Farsça ve bazı Hint yazılarında metin
 * açısından anlamlıdır. Ancak görünen adda GÖRÜNMEZ İKİZ üretmeye de
 * yararlar ("Ad" + ZWJ + "min" ekranda "Admin"dir). Sohbet ürünlerinin
 * yaygın tercihi bunları addan çıkarmaktır: ad okunabilir kalır, görünmez
 * ikiz üretilemez.
 */
const ZERO_WIDTH_RANGES = [
  [0x200b, 0x200d], [0x2060, 0x2060], [0xfeff, 0xfeff], [0x180e, 0x180e],
] as const;

/** C0 / C1 kontrol karakterleri. */
const CONTROL_RANGES = [[0x0000, 0x001f], [0x007f, 0x009f]] as const;

/** Boşluk gibi görünen ama normal boşluk olmayan karakterler. */
const NBSP_RANGES = [
  [0x00a0, 0x00a0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000],
] as const;

/** Unicode birleştirici işaret aralıkları (Zalgo bunları yığar). */
const COMBINING_RANGES = [
  [0x0300, 0x036f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff], [0xfe20, 0xfe2f],
] as const;

const BIDI       = charClass(BIDI_RANGES, 'g');
const ZERO_WIDTH = charClass(ZERO_WIDTH_RANGES, 'g');
const CONTROL    = charClass(CONTROL_RANGES, 'g');
const NBSP_LIKE  = charClass(NBSP_RANGES, 'g');
const COMBINING  = charClass(COMBINING_RANGES, '');

/** Ardışık birleştirici işaretleri MAX_COMBINING_RUN ile sınırlar. */
function capCombining(input: string): string {
  let out = '';
  let run = 0;
  for (const ch of input) {
    if (COMBINING.test(ch)) {
      if (run >= MAX_COMBINING_RUN) continue;   // fazlasını at
      run++;
    } else {
      run = 0;
    }
    out += ch;
  }
  return out;
}

/**
 * Görünen adı güvenli biçime indirger.
 *
 * Sonuç BOŞ olabilir (girdi tamamen görünmez karakterlerden oluşuyorsa);
 * çağıran taraf bu durumda adı reddetmeli veya `username`e geri düşmelidir.
 */
export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return '';

  let s = raw;

  // 1. NFKC — uyumluluk varyantlarını kanonikleştirir: U+FF21 → "A".
  try { s = s.normalize('NFKC'); } catch { /* geçersiz vekil çifti — ham kullan */ }

  // 2. Görsel hile taşıyan karakterleri kaldır.
  s = s.replace(BIDI, '').replace(ZERO_WIDTH, '').replace(CONTROL, '');

  // 3. Boşluk taklitlerini gerçek boşluğa indir, sonra sıkıştır.
  s = s.replace(NBSP_LIKE, ' ').replace(/\s+/g, ' ').trim();

  // 4. Zalgo yığınını sınırla (UI taşmasını ve okunamazlığı engeller).
  s = capCombining(s);

  // 5. Uzunluk (mevcut davranışla aynı).
  return s.slice(0, DISPLAY_NAME_MAX);
}

/**
 * Ham girdi görsel hile karakteri içeriyor muydu?
 * Denetim/moderasyon kaydı ve test için kullanışlıdır.
 */
export function hasDeceptiveCharacters(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  // `g` bayrağı taşıyan RegExp'lerde `lastIndex` durumu taşınır — sıfırla.
  BIDI.lastIndex = 0;
  ZERO_WIDTH.lastIndex = 0;
  CONTROL.lastIndex = 0;
  return BIDI.test(raw) || ZERO_WIDTH.test(raw) || CONTROL.test(raw);
}
