// server/lib/svgSanitizer.ts
// SVG dosyalarındaki XSS vektörlerini temizler.
//
// Strateji: reject-or-strip
//   1. Dosyayı oku
//   2. Tehlikeli elementleri ve attribute'ları kaldır (strip)
//   3. Temizlenmiş dosyayı aynı path'e yaz
//   4. Temizlik sonrası hâlâ tehlikeli içerik varsa dosyayı reddet
//
// Neden reject-only değil?
//   Meşru SVG'ler bazen event attribute içerebilir (bazı araç çıktıları).
//   Strip yaklaşımı daha kullanıcı dostu — sadece gerçekten tehlikeli
//   kısımlar kesilir, görsel içerik korunur.


import fs from 'fs';
import path from 'path';
const DANGEROUS_ELEMENTS = new Set([
  'script',
  'foreignObject',
  'iframe',
  'object',
  'embed',
  'video',
  'audio',
  'canvas',
  'input',
  'form',
  'animate',        // CSS animation ile XSS mümkün
  'set',            // SMIL animasyon — XSS vektörü
  'animateMotion',
  'animateTransform',
]);

// ── Tehlikeli attribute pattern'ları ─────────────────────────
const DANGEROUS_ATTR_PATTERNS = [
  /^on\w+$/i,              // onerror, onload, onclick, vb.
  /^xlink:href$/i,         // harici kaynak referansı
  /^href$/i,               // <a href="javascript:">
  /^action$/i,             // form action
  /^formaction$/i,
  /^data-\w*src$/i,        // data-src gibi lazy-load tricky pattern'lar
];

// ── Tehlikeli değer pattern'ları ──────────────────────────────
const DANGEROUS_VALUE_PATTERNS = [
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\/html/i,
  /data\s*:\s*application/i,
  /<\s*script/i,
  /expression\s*\(/i,     // IE CSS expression
  /url\s*\(\s*['"]\s*javascript/i,
];

/**
 * SVG string'ini sanitize eder — tehlikeli element ve attribute'ları kaldırır.
 * @param {string} svgContent - ham SVG içeriği
 * @returns {{ clean: string, stripped: string[] }} temizlenmiş içerik + kaldırılan şeyler
 */
interface SanitizeResult { clean: string; stripped: string[] }

function sanitizeSvgString(svgContent: string): SanitizeResult {
  const stripped = [];
  let clean = svgContent;

  // 1. Tehlikeli elementleri (açılış-kapanış dahil) kaldır
  for (const el of DANGEROUS_ELEMENTS) {
    const openTag  = new RegExp(`<\\s*${el}(?:\\s[^>]*)?>`, 'gi');
    const closeTag = new RegExp(`<\\/\\s*${el}\\s*>`, 'gi');
    const selfClose = new RegExp(`<\\s*${el}(?:\\s[^>]*)?\\/>`, 'gi');

    // Açılış-kapanış arasındaki içerik dahil kaldır
    const fullElement = new RegExp(`<\\s*${el}(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\s*${el}\\s*>`, 'gi');

    const beforeLen = clean.length;
    clean = clean.replace(fullElement, '').replace(selfClose, '').replace(openTag, '').replace(closeTag, '');
    if (clean.length !== beforeLen) stripped.push(`element:<${el}>`);
  }

  // 2. Tehlikeli attribute'ları kaldır (tüm element'lerde)
  clean = clean.replace(/(\s)([\w:.-]+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|([^\s>]+))/g,
    (match, space, attrName, dq, sq, uq) => {
      const value = dq ?? sq ?? uq ?? '';

      // Tehlikeli attribute ismi mi?
      if (DANGEROUS_ATTR_PATTERNS.some(p => p.test(attrName))) {
        stripped.push(`attr:${attrName}`);
        return '';
      }

      // Tehlikeli değer mi?
      if (DANGEROUS_VALUE_PATTERNS.some(p => p.test(value))) {
        stripped.push(`attr:${attrName}=<dangerous-value>`);
        return '';
      }

      return match;
    }
  );

  // 3. HTML entity-encoded tehlikeli pattern'lar (& #106; = j gibi)
  const ENCODED_JS = /&#(?:x0*6[aA]|0*106);/g; // j
  const ENCODED_COLON = /&#(?:x0*3[aA]|0*58);/g; // :
  if (ENCODED_JS.test(clean) || ENCODED_COLON.test(clean)) {
    // javascript: encoded hali — tüm href/src değerlerini temizle
    clean = clean.replace(/(href|src|action)\s*=\s*["'][^"']*["']/gi, (m, attr) => {
      stripped.push(`encoded-proto:${attr}`);
      return `${attr}="#"`;
    });
  }

  // 4. CDATA bölümleri (script injection vektörü)
  clean = clean.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, () => {
    stripped.push('CDATA-section');
    return '';
  });

  // 5. Processing instructions (<?php, <?xml-stylesheet vb.)
  clean = clean.replace(/<\?(?!xml\s)[^?]*\?>/g, () => {
    stripped.push('processing-instruction');
    return '';
  });

  return { clean, stripped };
}

/**
 * Dosyadan SVG oku, sanitize et, aynı path'e yaz.
 * @param {string} filePath - dosya yolu
 * @returns {{ safe: boolean, stripped: string[], rewritten: boolean }}
 */
interface SvgFileResult { safe: boolean; stripped: string[]; rewritten: boolean }

async function sanitizeSvgFile(filePath: string): Promise<SvgFileResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.svg' && ext !== '.svgz') {
    return { safe: true, stripped: [], rewritten: false };
  }

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { safe: false, stripped: ['read-error'], rewritten: false };
  }

  const { clean, stripped } = sanitizeSvgString(content);

  // Sanitize sonrası ek tehlike kontrolü
  const RESIDUAL_DANGER = [
    /<script/i,
    /javascript\s*:/i,
    /on\w+\s*=/i,
    /<foreignObject/i,
  ];

  for (const pattern of RESIDUAL_DANGER) {
    if (pattern.test(clean)) {
      // Temizlenemedi — dosyayı reddet
      return { safe: false, stripped: [...stripped, `residual:${pattern}`], rewritten: false };
    }
  }

  // Değişiklik yapıldıysa dosyayı güncelle
  if (stripped.length > 0) {
    try {
      fs.writeFileSync(filePath, clean, 'utf8');
    } catch {
      return { safe: false, stripped: [...stripped, 'write-error'], rewritten: false };
    }
  }

  return { safe: true, stripped, rewritten: stripped.length > 0 };
}

/**
 * SVG string'inin güvenli olup olmadığını hızlıca kontrol eder (dosyaya yazmaz).
 * Tarama sonucu false ise dosyayı reddet.
 */
function isSvgSafe(svgContent: string): boolean {
  const { stripped } = sanitizeSvgString(svgContent);
  return stripped.length === 0;
}

export { sanitizeSvgFile, sanitizeSvgString, isSvgSafe };
