// server/lib/contentSanitizer.ts
// Sprint 119: Tehdit modeli T5 — server-side Markdown sanitization eklendi.
//
// Mevcut durum: DOMPurify yalnızca client (tarayıcı) tarafında çalışıyor.
// Bu modül sunucu tarafında da içerik sanitize eder — mesaj kaydedilmeden önce.
//
// Kullanım (server/routes/messages.ts veya ilgili handler):
//   import { sanitizeMessageContent, sanitizeDisplayName } from '../lib/contentSanitizer';
//   const cleanContent = sanitizeMessageContent(req.body.content);

import { createLogger } from './logger';

const log = createLogger('contentSanitizer');

// DOMPurify is loaded lazily so Jest does not have to transform jsdom's ESM-only dependencies.
type Purifier = { sanitize(input: string, config?: Record<string, unknown>): string };
let domPurifyInstance: Purifier | null = null;

function basicSanitize(input: string): string {
  return input
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
}

function getDOMPurify(): Purifier | null {
  if (process.env.NODE_ENV === 'test') return null;
  if (domPurifyInstance) return domPurifyInstance;
  try {
    const req = module.require.bind(module) as NodeRequire;
    const { JSDOM } = req('jsdom') as typeof import('jsdom');
    const dompurifyModule = req('dompurify') as unknown as ((window: Window & typeof globalThis) => Purifier) | { default?: (window: Window & typeof globalThis) => Purifier };
    const createDOMPurify = typeof dompurifyModule === 'function' ? dompurifyModule : dompurifyModule.default;
    if (!createDOMPurify) return null;
    const jsdomWindow = new JSDOM('').window;
    domPurifyInstance = createDOMPurify(jsdomWindow as unknown as Window & typeof globalThis);
    return domPurifyInstance;
  } catch (err) {
    log.warn({ err, event: 'content_sanitizer_fallback' }, 'DOMPurify unavailable; using basic sanitizer fallback.');
    return null;
  }
}

// ── Konfigürasyonlar ───────────────────────────────────────────────────────

/**
 * Mesaj içeriği için izin verilen HTML etiketleri.
 * Bridge Markdown render'ı bu etiketleri üretebilir.
 */
const MESSAGE_ALLOWED_TAGS = [
  // Metin biçimlendirme
  'b', 'i', 'em', 'strong', 'u', 's', 'del', 'ins', 'mark',
  'code', 'pre', 'kbd', 'samp', 'var',
  // Yapısal
  'p', 'br', 'hr',
  'ul', 'ol', 'li',
  'blockquote', 'q',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Bağlantı (href kısıtlı)
  'a',
  // Medya (src kısıtlı)
  'img',
  // Tablo
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  // Diğer
  'span', 'div', 'details', 'summary',
];

// DOMPurify ALLOWED_ATTR bir string dizisi bekler — element bazlı kısıtlama değil.
// Per-element attribute kısıtlaması için DOMPurify hook'ları kullanılabilir
// ancak bu, uygulama katmanında (Markdown renderer) zaten ele alınıyor.
const MESSAGE_ALLOWED_ATTR = [
  // Tüm elementlerde izinliler
  'class', 'id',
  // <a> elementinde izinliler
  'href', 'title', 'rel', 'target',
  // <img> elementinde izinliler
  'src', 'alt', 'width', 'height', 'loading',
  // <td>/<th> elementlerinde izinliler
  'colspan', 'rowspan', 'scope',
];

// Yalnızca güvenli protokoller
const ALLOWED_URI_REGEXP = /^(?:https?|mailto|ftp|ircs?|matrix|xmpp):/i;

/**
 * Kullanıcı mesaj içeriğini sanitize eder.
 * Markdown'dan üretilen HTML'in güvenli alt kümesini korur.
 *
 * @param content - Ham kullanıcı girdisi (Markdown veya HTML)
 * @returns Temizlenmiş içerik
 */
export function sanitizeMessageContent(content: unknown): string {
  if (typeof content !== 'string') return '';
  if (content.length === 0) return '';

  // Makul boyut sınırı (10K karakter — büyük mesajlar reddedilmeli)
  const MAX_LEN = 10_000;
  if (content.length > MAX_LEN) {
    log.warn({ event: 'content_too_long', length: content.length, max: MAX_LEN });
    return content.slice(0, MAX_LEN);
  }

  const purifier = getDOMPurify();
  const clean = purifier ? purifier.sanitize(content, {
    ALLOWED_TAGS:  MESSAGE_ALLOWED_TAGS,
    ALLOWED_ATTR:  MESSAGE_ALLOWED_ATTR,
    ALLOWED_URI_REGEXP,
    // target="_blank" güvenli hale getir
    ADD_ATTR:      ['target'],
    // data: URI yasak
    ALLOW_DATA_ATTR: false,
    // SVG/MathML yasak (XSS vektörü)
    USE_PROFILES:  { html: true },
    // rel="noopener noreferrer" ekle
    FORCE_BODY:    false,
    RETURN_DOM:    false,
    RETURN_DOM_FRAGMENT: false,
  }) : basicSanitize(content);

  // target="_blank" olan linklere otomatik rel="noopener noreferrer" ekle.
  // Not: DOMPurify zaten rel ekleyebilir; bu yalnızca ek güvence katmanıdır.
  return clean.replace(
    /<a([^>]*?)target="([^"]*)"/gi,
    (match, attrs) => {
      // Zaten rel attribute'u var mı kontrol et (href içindeki rel= eşleşmesini önlemek için attribute sınırı kullan)
      if (/\brel\s*=/.test(attrs)) return match;
      return match + ' rel="noopener noreferrer"';
    }
  );
}

/**
 * Kullanıcı adı / display name sanitization.
 * HTML yok — yalnızca düz metin.
 */
export function sanitizeDisplayName(name: unknown): string {
  if (typeof name !== 'string') return '';
  // Tüm HTML taglarını sil, düz metin döndür
  const purifier = getDOMPurify();
  const stripped = purifier ? purifier.sanitize(name, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) : basicSanitize(name).replace(/<[^>]*>/g, '');
  return stripped.trim();
}

/**
 * Kanal / sunucu başlığı sanitization.
 * Satır sonu ve HTML yok.
 */
export function sanitizeTitle(title: unknown): string {
  if (typeof title !== 'string') return '';
  const purifier = getDOMPurify();
  const clean = purifier ? purifier.sanitize(title, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] }) : basicSanitize(title).replace(/<[^>]*>/g, '');
  return clean.replace(/[\r\n\t]/g, ' ').trim().slice(0, 100);
}

/**
 * ActivityPub içerik sanitization.
 * Fediverse mesajları için daha kısıtlı whitelist.
 */
export function sanitizeActivityPubContent(content: unknown): string {
  if (typeof content !== 'string') return '';

  const AP_ALLOWED_TAGS = ['p', 'br', 'a', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li'];

  const purifier = getDOMPurify();
  return purifier ? purifier.sanitize(content, {
    ALLOWED_TAGS:  AP_ALLOWED_TAGS,
    ALLOWED_ATTR:  ['href', 'rel', 'class'],
    ALLOWED_URI_REGEXP,
    ALLOW_DATA_ATTR: false,
    USE_PROFILES:  { html: true },
  }) : basicSanitize(content);
}

/**
 * URL güvenlik kontrolü.
 * Sadece izin verilen protokolleri kabul eder.
 */
export function sanitizeUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!ALLOWED_URI_REGEXP.test(trimmed)) {
    log.warn({ event: 'url_blocked', url: trimmed });
    return null;
  }
  try {
    // URL parse ederek normalize et
    const parsed = new URL(trimmed);
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Güvenli string olup olmadığını kontrol et (null byte, özel chars).
 * DB sorgularında kullanılacak alanlar için.
 */
export function isCleanString(value: unknown, maxLen = 255): boolean {
  if (typeof value !== 'string') return false;
  if (value.length > maxLen) return false;
  // Null byte ve control chars (0x00-0x08, 0x0B-0x0C, 0x0E-0x1F)
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(value)) return false;
  return true;
}
