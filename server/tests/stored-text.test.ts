// server/tests/stored-text.test.ts — Final21 Phase 15: plain-text surfaces show channel messages as typed.
import { decodeStoredMessageText, normalizeMessageText, RAW_TEXT_FORMAT, storedMessageText } from '../lib/storedText';
import { sanitizeMessageContent } from '../lib/contentSanitizer';

describe('decodeStoredMessageText', () => {
  it.each([
    'if a < b && c > d',
    'https://example.com/search?q=1&lang=tr',
    'arrow -> and fish <><',
    'türkçe çğıöşü & emoji 🎉',
  ])('round-trips what the sanitizer stored for %j', (typed) => {
    expect(decodeStoredMessageText(sanitizeMessageContent(typed))).toBe(typed);
  });

  it('documents the upstream loss: entity spellings typed by a person are normalized before storage', () => {
    expect(decodeStoredMessageText(sanitizeMessageContent('talking about &lt; itself'))).toBe('talking about < itself');
    expect(decodeStoredMessageText(sanitizeMessageContent('&copy; 2026'))).toBe('© 2026');
  });

  it('decodes once and leaves unknown or invalid entities alone', () => {
    expect(decodeStoredMessageText('&amp;lt; &#39; &#x1F389;')).toBe("&lt; ' 🎉");
    expect(decodeStoredMessageText('&bogus; &#0; &#xD800;')).toBe('&bogus; &#0; &#xD800;');
  });

  it('non-strings become empty text', () => {
    expect(decodeStoredMessageText(undefined)).toBe('');
    expect(decodeStoredMessageText(null)).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Final21 Phase 16 — channel text is stored RAW (contentFormat 1)
// ════════════════════════════════════════════════════════════════════════════
// Measured through the old write path (sanitizer + decode): 3 of these 13 survived.
// Through the RAW path all 13 must come back exactly as typed.
const TYPED: Array<[string, string]> = [
  ['rust generic', 'let v: Vec<String> = Vec::new();'],
  ['java generic', 'Map<String, List<Integer>> m;'],
  ['ts generic', 'const x: Array<number> = [];'],
  ['heart', 'i <3 bridge'],
  ['html inline', 'use <br> for a line break'],
  ['html in a code fence', '\`\`\`html\n<div class="card">hi</div>\n\`\`\`'],
  ['xml', '<config><key>v</key></config>'],
  ['angle mentions', 'see <#general> and <@alice>'],
  ['comparison', 'if (a<b && c>d) {}'],
  ['script tag as text', 'look: <script>alert(1)</script> done'],
  ['img onerror as text', '<img src=x onerror=alert(1)>'],
  ['email in angle brackets', 'mail me <alice@example.com>'],
  ['a literal entity', 'type &amp; to get &'],
];

describe('RAW storage keeps what was typed', () => {
  it.each(TYPED)('%s', (_name, typed) => {
    expect(storedMessageText({ content: normalizeMessageText(typed), contentFormat: RAW_TEXT_FORMAT })).toBe(typed);
  });

  it('CONTROL: the old sanitizer path loses most of the same inputs (why the format exists)', () => {
    const faithful = TYPED.filter(([, typed]) => decodeStoredMessageText(sanitizeMessageContent(typed)) === typed).length;
    expect(faithful).toBeLessThan(TYPED.length / 2);
  });
});

describe('normalizeMessageText', () => {
  it('removes invisible control characters but keeps tab, newline and carriage return', () => {
    const c = (n: number) => String.fromCharCode(n);
    const typed = 'a' + c(0) + 'b' + c(7) + 'c' + c(0x1b) + 'd' + c(0x7f) + 'e' + c(0x85) + 'f\tg\nh\ri';
    expect(normalizeMessageText(typed)).toBe('abcdef\tg\nh\ri');
  });

  it('keeps visible Unicode, including bidi-looking text and emoji, verbatim', () => {
    expect(normalizeMessageText('türkçe çğıöşü 🎉 <b>')).toBe('türkçe çğıöşü 🎉 <b>');
  });

  it('bounds length the way the old write path did', () => {
    expect(normalizeMessageText('x'.repeat(10_050))).toHaveLength(10_000);
  });

  it('non-strings and empty input become empty text', () => {
    expect(normalizeMessageText(undefined)).toBe('');
    expect(normalizeMessageText(42)).toBe('');
    expect(normalizeMessageText('')).toBe('');
  });
});

describe('storedMessageText picks the decoding from the stored format', () => {
  it('RAW is never decoded — a typed "&amp;" stays "&amp;"', () => {
    expect(storedMessageText({ content: 'type &amp; here', contentFormat: 1 })).toBe('type &amp; here');
  });

  it('LEGACY (0 or absent) is decoded once, exactly as before Phase 16', () => {
    expect(storedMessageText({ content: 'a &lt; b', contentFormat: 0 })).toBe('a < b');
    expect(storedMessageText({ content: 'a &lt; b' })).toBe('a < b');
  });

  it('missing records and non-string content become empty text', () => {
    expect(storedMessageText(null)).toBe('');
    expect(storedMessageText({ content: 5, contentFormat: 1 })).toBe('');
  });
});
