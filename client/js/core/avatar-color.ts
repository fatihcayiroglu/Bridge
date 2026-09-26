// client/js/core/avatar-color.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AVATAR BAŞ HARFLERİ İÇİN OKUNABİLİR METİN RENGİ
// ════════════════════════════════════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR (Final20): avatar arka planı KULLANICININ seçtiği
// `avatarColor`dan geliyor, metin rengi ise CSS'te sabit `color: white`.
// Açık renkli bir avatar seçildiğinde baş harfler okunamaz hâle geliyor.
//
// Canlı ölçüm (axe-core, gerçek sunucu, `#my-avatar`):
//     #ffffff üzerine #00aff4 → kontrast 2.48:1 (13px, bold)
//     WCAG 2.1 SC 1.4.3 (Contrast Minimum, AA) → en az 4.5:1
//
// Bu ihlal erişilebilirlik süitinde GÖRÜNMÜYORDU, çünkü `a11y.smoke.spec.ts`
// ve `a11y.flows.spec.ts` `color-contrast` kuralını "ayrı bir audit'te ele
// alınır" notuyla devre dışı bırakıyordu — ama öyle bir audit YOKTU. Yani
// "0 ihlal" sonucu, hiç ölçülmemiş bir ölçütü de kapsıyormuş gibi duruyordu.
//
// ── NEDEN SABİT BİR RENK LİSTESİ DEĞİL ─────────────────────────────────────
// `avatarColor` serbest bir alandır; kullanıcı herhangi bir rengi seçebilir ve
// gelecekte yeni varsayılanlar eklenebilir. Beyaz/siyah kararını ARKA PLANIN
// BAĞIL PARLAKLIĞINDAN hesaplamak, bugünkü tek bir rengi yamamaktan farklı
// olarak ileride eklenen her renk için de doğru sonucu verir.

/** WCAG 2.1'in tanımladığı bağıl parlaklık (relative luminance). */
function relativeLuminance(r: number, g: number, b: number): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG kontrast oranı: (L1 + 0.05) / (L2 + 0.05). */
function contrastRatio(a: number, b: number): number {
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` → [r, g, b]; tanınmazsa `null`. */
function parseHex(value: string): [number, number, number] | null {
  const hex = value.trim().replace(/^#/, '');
  const expand = (part: string): number => parseInt(part.length === 1 ? part + part : part, 16);
  if (hex.length === 3 || hex.length === 4) {
    return [expand(hex[0] ?? ''), expand(hex[1] ?? ''), expand(hex[2] ?? '')];
  }
  if (hex.length === 6 || hex.length === 8) {
    return [expand(hex.slice(0, 2)), expand(hex.slice(2, 4)), expand(hex.slice(4, 6))];
  }
  return null;
}

/** Avatar metni için koyu mürekkep. Saf siyah yerine yumuşak bir ton. */
const DARK_INK = '#101114';
const LIGHT_INK = '#ffffff';

/**
 * Verilen arka plan üzerinde WCAG AA'yı sağlayan metin rengini döndürür.
 *
 * İkisi de 4.5:1'i sağlamıyorsa (çok orta parlaklıkta bir arka plan) DAHA
 * YÜKSEK kontrastlı olan seçilir: mükemmel olamadığımızda en iyisini veririz,
 * sessizce okunaksız bırakmayız.
 */
export function readableTextOn(background: string): string {
  const rgb = parseHex(background);
  if (!rgb) return LIGHT_INK;
  const bg = relativeLuminance(rgb[0], rgb[1], rgb[2]);
  const onLight = contrastRatio(bg, relativeLuminance(255, 255, 255));
  const onDark = contrastRatio(bg, relativeLuminance(16, 17, 20));
  if (onLight >= 4.5) return LIGHT_INK;
  if (onDark >= 4.5) return DARK_INK;
  return onDark > onLight ? DARK_INK : LIGHT_INK;
}

/** GEÇERLİ bir CSS hex rengi mi: 3, 4, 6 veya 8 basamak. */
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Hex rengi geçirir, aksi hâlde verilen tokena düşer (Final21 Faz 16).
 *
 * Aynı işi yapan BEŞ ayrı yerel kopya vardı (`InboxPanel`, `MemberListPanel`,
 * `MemberProfilePopover`, `MembersTab`, `RolesTab`). Üçü ÖLÜ koddu (hiç
 * çağrılmıyordu, lint uyarısı veriyordu); kalan ikisi `#[0-9a-fA-F]{3,8}`
 * desenini kullanıyordu — bu desen 5 ve 7 basamaklı, CSS'te GEÇERSİZ değerleri
 * de geçirir; tarayıcı böyle bir bildirimi yok sayar ve rol rengi sessizce
 * kaybolurdu. Tek sahip burada; uzunluk kuralı doğru olanıdır.
 */
export function safeHexColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_COLOR.test(value) ? value : fallback;
}

/** Yalnızca güvenli hex renkleri geçirir; aksi hâlde marka tokenına düşer. */
export function safeAvatarColor(value?: unknown): string {
  return safeHexColor(value, 'var(--brand)');
}

/**
 * Avatar için TAM satır içi stil: arka plan + okunabilir metin rengi.
 *
 * Renk bir CSS tokenına düştüğünde (`var(--brand)`) parlaklık derleme zamanında
 * bilinemez; o durumda metin rengi YAZILMAZ ve CSS varsayılanı geçerli kalır.
 * Marka rengi bilerek koyudur, beyaz metinle kontrastı zaten yeterlidir.
 */
export function avatarStyle(value?: unknown): string {
  const background = safeAvatarColor(value);
  if (background.startsWith('var(')) return `background:${background}`;
  return `background:${background};color:${readableTextOn(background)}`;
}

/**
 * Arka planı ZATEN ÇÖZÜLMÜŞ bir avatar için satır içi stil.
 *
 * Bazı yüzeyler renk adını kayıttan (`BridgeRegistry.get('cssColor')`) çözer;
 * `avatarColor` orada bir hex değil, `brand-local` gibi bir AD olabilir. O
 * çözümü bu modül tekrarlamaz — çözülmüş değeri alır.
 *
 * Çözülmüş değer hex ise okunabilir mürekkep hesaplanır; `var(--x)` ya da
 * adlandırılmış bir renk ise parlaklık bilinemez ve metin rengi YAZILMAZ
 * (CSS varsayılanı geçerli kalır). Yanlış bir tahmin yazmaktansa hiç
 * yazmamak doğrudur.
 */
export function avatarStyleFromResolved(color: string): string {
  const readable = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)
    ? `;color:${readableTextOn(color)}`
    : '';
  return `background:${color}${readable}`;
}

/** HSL → RGB (h derece, s/l yüzde). */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number): number => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(255 * f(0)), Math.round(255 * f(8)), Math.round(255 * f(4))];
}

/**
 * Beyaz metnin WCAG AA'yı (4.5:1) GEÇTİĞİ bir kimlik arka planı üretir.
 *
 * ── NEDEN SABİT AÇIKLIK YETMEZ ────────────────────────────────────────────
 * Sunucu/avatar kimlik renkleri id'den türetiliyordu: `hsl(hue 42% 38%)`.
 * HSL'in "lightness"ı ALGISAL DEĞİLDİR: aynı %38 açıklık, sarı-yeşil tonlarda
 * maviden çok daha parlak bir renk verir. Ölçüldü (axe, canlı):
 *
 *     #ffffff üzerine #8a7738 (hue≈45)  → 4.32:1   AA ALTI
 *     #ffffff üzerine #468a38 (hue≈100) → 4.19:1   AA ALTI
 *
 * Dahası bu iki ton için KOYU mürekkep de yetmiyordu (4.46 ve 4.60): renk
 * öyle bir orta parlaklıkta ki hiçbir metin rengi AA'yı geçemiyordu. Yani
 * sorun mürekkepte değil, PALETTE idi.
 *
 * Burada ton (hue) ve doygunluk KORUNUR — görsel kimlik bozulmaz — ve açıklık
 * yalnızca eşiği geçene kadar düşürülür. Her ton için gereken miktar farklıdır;
 * bu yüzden sabit bir sayı değil, ÖLÇÜM kullanılır.
 */
export function identityBackground(hue: number, saturation = 42, startLightness = 38): string {
  const white = relativeLuminance(255, 255, 255);
  for (let lightness = startLightness; lightness >= 12; lightness -= 1) {
    const [r, g, b] = hslToRgb(hue, saturation, lightness);
    if (contrastRatio(relativeLuminance(r, g, b), white) >= 4.5) {
      return `hsl(${hue} ${saturation}% ${lightness}%)`;
    }
  }
  return `hsl(${hue} ${saturation}% 12%)`;
}
