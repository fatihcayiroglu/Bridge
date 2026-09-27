#!/usr/bin/env node
'use strict';

// Dependency-free regression gate for user-visible Turkish source literals.
// Turkish is a supported locale, not the source language of product chrome:
// visible copy must flow through t()/workerText so every stable locale can own it.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const CORE = path.join(CLIENT, 'js/core');
const TURKISH_LETTERS_OR_WORDS = /[çğıöşüÇĞİÖŞÜ]|\b(?:Sunucu|Kanal|Mesaj|Rol|Üye|Kullanıcı|Ayar|Bildirim|Gizlilik|Hata|Başar|Yükle|Kaydet|İptal|Sil|Ekle|Aç|Kapat|Ses|Mikrofon|Kamera|Dosya|Arama|Kur|Bekle|Doğrul|Giriş|Çıkış|Bağlantı|Yönet|İzin|Gönder|Alıcı|Engel|Arkadaş|Grup|Tema|Çevrimiçi|Çevrimdışı|Boşta|Rahatsız|Geçersiz|bulunamadı|başarısız|gerekli|gerekir|seç|yenile|oluştur|kaldır|göster|gizle|katıl|ayrıl|açıklama|liste|durum|uyarı|desteklenmiyor)\b/i;
// Final21 Phase 16 — ASCII-ONLY TURKISH WAS INVISIBLE.
// The detector above needs a Turkish-specific letter or one of its listed words. Turkish that
// happens to use only ASCII letters matched neither, so 18 visible strings shipped in Turkish
// to every locale with this gate green: "Yeni ileti", "Devam", "Dinleyici", "Yok",
// "Kanala Git: …", "Sunucuya Git: …", "Emoji silindi", "Webhook silindi" and more.
// These words are unambiguous in an English/Turkish UI. Words that are also English or collide
// with code are deliberately absent: "var" matched CSS `var(--brand)` (measured, 3 false
// positives), "forum"/"tema"/"profil"-style cognates are either absent or harmless.
const TURKISH_ASCII_WORDS = new RegExp(`\\b(?:${[
  'yeni', 'ileti', 'iletisi', 'sohbet', 'konu', 'konuyu', 'etiket', 'etiketler', 'dinle', 'dinleyici', 'sahne',
  'tamam', 'vazgec', 'devam', 'lutfen', 'simdi', 'sonra', 'henuz', 'yok', 'icin', 'degil', 'olarak',
  'kanala', 'kanali', 'sunucuya', 'sunucuda', 'mesaji', 'mesajlar', 'yaziyor', 'yazdi', 'bekleniyor',
  'yukleniyor', 'kaydedildi', 'eklendi', 'silindi', 'guncelle', 'guncellendi', 'davet', 'davetiye',
  'kapali', 'acik', 'hepsi', 'tumu', 'hicbiri', 'bilgi', 'ayarlar', 'profil', 'hesap', 'sifre', 'parola',
  'gonder', 'gonderildi', 'baglan', 'baglaniyor', 'baglanti', 'cevrimici', 'kullanici', 'uye', 'uyeler',
  'roller', 'izinler', 'yetki', 'kanallar', 'sunucular', 'ara', 'arama', 'sonuc', 'sonuclar',
].join('|')})\\b`, 'i');
// Final21 Phase 19 — INFLECTED ASCII TURKISH WAS STILL INVISIBLE.
// The word list matches whole words only, so an inflected form slipped past it: six
// `toast('Silinemedi')` calls ("could not delete"), `'⭐ Admin yetkisi verildi'`, "Eklenemedi",
// "Yenilenemedi", "… indirildi." shipped in Turkish to every locale with this gate green.
// Turkish verb suffixes for "could not", passive/past and progressive forms do not end English
// words; a stem of at least two letters is required so short tokens cannot match.
const TURKISH_ASCII_SUFFIX = /\b[a-z]{2,}(?:emedi|amadi|ilsin|insin|unsun|ecek|acak|iyor|uyor|ildi|uldu|lendi|landi|irildi|ildi)\b/i;
const TURKISH = {
  test: (text) => TURKISH_LETTERS_OR_WORDS.test(text) || TURKISH_ASCII_WORDS.test(text) || TURKISH_ASCII_SUFFIX.test(text),
};

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function lineAt(src, index) { return src.slice(0, index).split('\n').length; }
function blank(src, rx) { return src.replace(rx, m => m.replace(/[^\n]/g, ' ')); }
function stripComments(src) {
  src = blank(src, /\/\*[\s\S]*?\*\//g);
  return src.replace(/(^|[^:])\/\/[^\n]*/gm, m => m.replace(/[^\n]/g, ' '));
}
function visibleTemplateText(text) {
  // Keep only literal template segments; expressions may contain translated
  // fallback strings inside t(...), which are not hardcoded product chrome.
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] !== '$' || text[i + 1] !== '{') { out += text[i++]; continue; }
    i += 2;
    let depth = 1;
    let quote = null;
    let escape = false;
    while (i < text.length && depth > 0) {
      const ch = text[i++];
      if (quote) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    out += ' ';
  }
  return out;
}
/**
 * Blank every top-level `{…}` mustache (balanced, string-aware), offsets preserved. A
 * non-nested regex ended `{t('k', 'metin', { count })}` at the object's `}` and reported
 * the rest of the expression as hardcoded text (Final21 Phase 15).
 */
function blankMustaches(src) {
  const out = src.split('');
  let depth = 0;
  let quote = null;
  let escape = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (depth > 0 && ch !== '\n') out[i] = ' ';
    if (quote) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (depth > 0 && (ch === "'" || ch === '"' || ch === '`')) { quote = ch; continue; }
    if (ch === '{') { depth += 1; if (ch !== '\n') out[i] = ' '; }
    else if (ch === '}' && depth > 0) depth -= 1;
  }
  return out.join('');
}

/** Replace every `t(...)` call (balanced, string-aware) with spaces; offsets are preserved. */
function blankTranslationCalls(expr) {
  let out = expr;
  for (const start of [...expr.matchAll(/\bt\s*\(/g)].map(m => m.index)) {
    let i = expr.indexOf('(', start) + 1;
    let depth = 1;
    let quote = null;
    let escape = false;
    while (i < expr.length && depth > 0) {
      const ch = expr[i++];
      if (quote) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    out = out.slice(0, start) + ' '.repeat(i - start) + out.slice(i);
  }
  return out;
}
function walk(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules','dist','coverage','.git','tests','__tests__','fixtures','i18n'].includes(e.name)) continue;
      walk(p, ext, out);
    } else if (e.isFile() && ext.test(e.name) && !/\.test\./.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every user-visible hardcoded Turkish literal under `clientDir` (default: the real client). */
function scan(clientDir = CLIENT) {
  const UI_SOURCE = path.join(clientDir, 'js');
  const hits = [];
  function hit(file, src, index, kind, text) {
    hits.push(`${rel(file)}:${lineAt(src,index)} ${kind}: ${JSON.stringify(text.slice(0,180))}`);
  }

  // Svelte markup: plain text + literal accessible attributes + string literals in
  // mustache expressions outside t(...) calls.
  for (const file of walk(UI_SOURCE, /\.svelte$/)) {
    const original = fs.readFileSync(file, 'utf8');
    let src = blank(original, /<script\b[\s\S]*?<\/script>/gi);
    src = blank(src, /<style\b[\s\S]*?<\/style>/gi);
    src = blank(src, /<!--[\s\S]*?-->/g);

    // `data-tip` GORUNUR bir ipucu metnidir (CSS tooltip). Listede olmadigi
    // icin uc yuzeyde sabit Turkce metin fark edilmeden kalmisti; o metinler
    // her dilde Turkce goruntuleniyordu.
    const attr = /\b(placeholder|aria-label|aria-description|title|alt|data-tip)\s*=\s*(["'])(.*?)\2/gis;
    for (const m of src.matchAll(attr)) if (TURKISH.test(m[3])) hit(file, original, m.index, `attr:${m[1]}`, m[3]);

    // Hide tags and mustache blocks, then inspect only literal text nodes.
    let visible = blankMustaches(src);
    visible = visible.replace(/<[^>]*>/g, m => m.replace(/[^\n]/g,' '));
    const textRx = /[^\n<>]{2,}/g;
    for (const m of visible.matchAll(textRx)) {
      const text = m[0].replace(/&[A-Za-z0-9#]+;/g,' ').replace(/\s+/g,' ').trim();
      if (text && TURKISH.test(text)) hit(file, original, m.index, 'text', text);
    }

    // Expression literals. A literal inside t(...) is an intentional resilient
    // fallback and is not product-owned hardcoded chrome — but only the t(...)
    // call itself is exempt. Skipping the whole expression let the untranslated
    // branch of `{busy ? t("…") : installed ? t("…") : 'Kur'}` ship (Final21 Phase 14).
    const exprRx = /\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    for (const m of src.matchAll(exprRx)) {
      const expr = blankTranslationCalls(m[1]);
      for (const sm of expr.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
        const text = sm[2];
        if (!TURKISH.test(text)) continue;
        // APPLICATION STATE IS NOT PRODUCT CHROME.
        // A literal that is compared against (`asama === 'yenile'`) or assigned to
        // a variable inside an event handler (`onclick={() => asama = 'yenile'}`)
        // is a state token, never rendered text. Demanding a t() call there is
        // exactly what produced the defect this file exists to prevent: the
        // SecurityTab 2FA state machine was keyed on a TRANSLATED string, so its
        // backup-code screen stopped matching as soon as the locale changed.
        const before = expr.slice(0, sm.index).replace(/\s+$/, '');
        const isComparisonOperand = /[!=]==?$/.test(before);
        const isHandlerAssignment = /[^=!<>]=$/.test(before) && expr.includes('=>');
        if (isComparisonOperand || isHandlerAssignment) continue;
        hit(file, original, m.index + sm.index, 'expression', text);
      }
    }
  }

  // TypeScript user-visible sinks. This intentionally does not flag logger/debug
  // strings, protocol event names, tests, or translation dictionaries.
  const userCall = '(?:toast|showAuthMsg|alert|confirm|prompt|notify|showToast|setStatus|setMessage|setError|showError|showSuccess|showConfirm)';
  // A Svelte component's <script> block feeds the same sinks as a .ts module; before
  // Final21 Phase 14 it was never scanned (SavedPanel.svelte shipped `confirmLabel: 'Kur'`).
  function scriptOnly(original) {
    let out = original.replace(/[^\n]/g, ' ');
    for (const m of original.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      const start = m.index + m[0].indexOf('>') + 1;
      out = out.slice(0, start) + m[1] + out.slice(start + m[1].length);
    }
    return out;
  }
  for (const file of [...walk(UI_SOURCE, /\.ts$/), ...walk(UI_SOURCE, /\.svelte$/), path.join(clientDir, 'sw.ts')]) {
    if (!fs.existsSync(file)) continue;
    const original = fs.readFileSync(file, 'utf8');
    const src = stripComments(file.endsWith('.svelte') ? scriptOnly(original) : original);
    const patterns = [
      ['dom-assignment', /\.(?:textContent|innerText|innerHTML|title|placeholder|ariaLabel|alt)\s*=\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g],
      ['user-call', new RegExp(`\\b${userCall}\\s*\\(\\s*(["'\\x60])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`, 'g')],
      // confirmLabel/cancelLabel/message: product-dialog.ts options render verbatim.
      // Omitted before Final21 Phase 14, which let `confirmLabel: 'Kur'` ship to every locale.
      // The lookbehind keeps it to object keys: `data.message : 'x'` is a ternary, not a sink.
      // `\w+Label` (Final21 Phase 19): `activeLabel: 'Mikrofonu aç'` / `idleLabel: …` in the shell
      // voice controls reached aria-label and the tooltip in every locale; only a fixed list of
      // *Label names was a sink.
      ['user-property', /(?<![.\w$])(?:label|title|description|hint|placeholder|ariaLabel|emptyText|message|\w+Label)\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g],
      ['accessible-attr', /\.setAttribute\(\s*(["'])(?:aria-[^"']+|title|placeholder|alt)\1\s*,\s*(["'`])((?:\\.|(?!\2)[\s\S])*?)\2/g],
    ];
    for (const [kind, rx] of patterns) {
      for (const m of src.matchAll(rx)) {
        const rawText = kind === 'accessible-attr' ? m[3] : m[2];
        const quote = kind === 'accessible-attr' ? m[2] : m[1];
        const text = quote === '`' ? visibleTemplateText(rawText) : rawText;
        if (!text || !TURKISH.test(text)) continue;
        // worker/local UI dictionaries are translation owners, not hardcoded sinks.
        const before = src.slice(Math.max(0, m.index - 160), m.index);
        if (file.endsWith('/sw.ts') && /SW_COPY[\s\S]*$/.test(before) && m.index < src.indexOf('function normalizeWorkerLocale')) continue;
        hit(file, original, m.index, kind, text);
      }
    }
  }

  // ── STATIC SHELL (index.html) — Final21 Phase 19 ─────────────────────────
  // The shell's accessible names, tooltips and mobile-nav labels were plain Turkish attributes
  // with no i18n hook: 28 strings stayed Turkish in every locale (screen readers included), and
  // this gate never opened index.html. A Turkish value is allowed ONLY as the fallback of an
  // element that carries the matching hook, and every hook key must exist in the tables.
  const shell = path.join(clientDir, 'index.html');
  if (fs.existsSync(shell)) {
    const original = fs.readFileSync(shell, 'utf8');
    let src = blank(original, /<script\b[\s\S]*?<\/script>/gi);
    src = blank(src, /<style\b[\s\S]*?<\/style>/gi);
    src = blank(src, /<!--[\s\S]*?-->/g);
    const HOOKS = { 'aria-label': 'data-i18n-aria-label', 'data-tip': 'data-tip-i18n', title: 'data-i18n-title', placeholder: 'data-i18n-placeholder', alt: 'data-i18n-alt' };
    const table = (() => {
      const p = path.join(clientDir, 'js/core/i18n/en.ts');
      if (!fs.existsSync(p)) return null;
      return new Set([...fs.readFileSync(p, 'utf8').matchAll(/["']([a-zA-Z0-9_]+)["']\s*:/g)].map(m => m[1]));
    })();
    for (const tag of src.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
      const attrs = tag[2];
      for (const [attr, hook] of Object.entries(HOOKS)) {
        const value = new RegExp(`(?:^|\\s)${attr}\\s*=\\s*"([^"]*)"`).exec(attrs);
        if (value && TURKISH.test(value[1]) && !new RegExp(`(?:^|\\s)${hook}\\s*=`).test(attrs)) {
          hit(shell, original, tag.index, `shell-attr:${attr}`, value[1]);
        }
      }
      if (table) {
        for (const key of attrs.matchAll(/(?:^|\s)data-(?:i18n(?:-[\w-]+)?|tip-i18n)\s*=\s*"([^"]+)"/g)) {
          if (!table.has(key[1])) hit(shell, original, tag.index, 'shell-missing-key', key[1]);
        }
      }
    }
    for (const m of src.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>([^<]*[^\s<][^<]*)</g)) {
      const text = m[3].replace(/&[A-Za-z0-9#]+;/g, ' ').trim();
      if (text && TURKISH.test(text) && !/(?:^|\s)data-i18n\s*=/.test(m[2])) hit(shell, original, m.index, 'shell-text', text);
    }
  }

  return [...new Set(hits)];
}

if (require.main === module) {
  const hits = scan();
  if (hits.length) {
    console.error('❌ hardcoded user-facing i18n surface gate başarısız:');
    for (const row of hits) console.error(` - ${row}`);
    process.exit(1);
  }
  console.log('✅ hardcoded user-facing i18n surface: 0 Svelte/TypeScript violations.');
}

module.exports = { scan };
