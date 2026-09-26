// server/lib/channelName.ts
//
// KANAL ADI NORMALIZASYONU — TEK SAHIP
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Normalizasyon su ifadeydi:
//
//     name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-')
//
// Bu, TURKCE HARFLERIN HEPSINI yok ediyordu. Gorsel incelemede olculdu:
//
//     "çok-uzun-bir-kanal-adı-örneği"  →  "-ok-uzun-bir-kanal-ad--rne-i"
//     "sohbet-odası"                   →  "sohbet-odas-"
//
// Yani TURKCE ONCELIKLI bir uründe kullanici kanalini TURKCE ADLANDIRAMIYORDU.
// Her ç, ğ, ı, ö, ş, ü bir tireye donusuyordu.
//
// Ustelik bu, sistemin KENDI dogrulayicisiyla da CELISIYORDU:
// `lib/security.ts` kanal adi validatoru Turkce harfleri ACIKCA kabul eder
//     /^[a-z0-9\-_ğüşöçıİĞÜŞÖÇ ]+$/i
// Dogrulama "Turkce olur" derken normalizasyon onu siliyordu.
//
// ── KORUNAN GUVENLIK NIYETI ───────────────────────────────────────────────
// Tehlikeli karakterler (yol ayraci, kontrol karakteri, `@`, `#`, `/`) yine
// elenir; bosluklar tireye donusur; uzunluk sinirlanir. Degisen tek sey,
// TURKCE HARFLERIN artik mesru sayilmasidir.

// Izin verilen Turkce kucuk harfler asagidaki literal regex icindedir:
//   ç ğ ı ö ş ü

/**
 * Kanal adini kanonik bicime getirir.
 *
 * Not: `toLowerCase()` kullanilir, `toLocaleLowerCase('tr')` DEGIL. Turkce
 * yerel kucultme `I` → `ı` donusumu yapar; bu, Ingilizce adlari (ornegin
 * "API") beklenmedik bicimde degistirirdi. Kanal adlari cok dilli oldugu
 * icin yerelden bagimsiz kucultme daha az surpriz uretir.
 */
export function normalizeChannelName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFC')                              // birlesik harfleri tek kod noktasina indir
    .replace(/\s+/g, '-')                          // bosluk → tire
    // LITERAL regex: sablon dizesi + dinamik `RegExp` birlesimi, `\-` kacisi
    // ve karakter sinifi icindeki `9-_` araligi yuzunden belirsizdi. Tire
    // sinifin SONUNDA durur ki aralik olarak yorumlanmasin.
    .replace(/[^a-z0-9_çğıöşü-]/g, '-')
    .replace(/-{2,}/g, '-')                        // ard arda tireleri sadelestir
    .replace(/^-+|-+$/g, '')                       // bas/son tireleri at
    .slice(0, 32);
}
