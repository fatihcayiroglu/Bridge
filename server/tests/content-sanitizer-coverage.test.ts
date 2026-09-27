process.env.NODE_ENV = 'test';

const warn = jest.fn();
jest.mock('../lib/logger', () => ({
  createLogger: () => ({ warn, debug: jest.fn(), info: jest.fn(), error: jest.fn() }),
}));

import {
  sanitizeMessageContent,
  sanitizeDisplayName,
  sanitizeTitle,
  sanitizeActivityPubContent,
  sanitizeUrl,
  isCleanString,
} from '../lib/contentSanitizer';

describe('content sanitizer security behavior', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects non-string and empty message values without coercion', () => {
    expect(sanitizeMessageContent(null)).toBe('');
    expect(sanitizeMessageContent(42)).toBe('');
    expect(sanitizeMessageContent('')).toBe('');
  });

  it('keeps the markdown HTML allowlist but strips executable markup and unsafe schemes', () => {
    const clean = sanitizeMessageContent(
      '<p>Hello <strong>world</strong></p>'
      + '<script>alert(1)</script>'
      + '<a href="javascript:alert(1)" target="_blank">bad</a>'
      + '<a href="https://example.com" target="_blank">good</a>'
      + '<img src="data:text/html,bad" onerror="alert(2)">',
    );
    expect(clean).toContain('<strong>world</strong>');
    expect(clean).not.toMatch(/<script|javascript:|onerror|data:text/i);
    expect(clean).toContain('https://example.com');
    expect(clean).toContain('noopener');
    expect(clean).toContain('noreferrer');
  });

  it('sanitizes after truncating oversized messages instead of returning raw HTML', () => {
    const dangerous = '<script>alert(1)</script>' + 'a'.repeat(10_100);
    const clean = sanitizeMessageContent(dangerous);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'content_too_long', max: 10_000 }));
    expect(clean).not.toContain('<script');
    expect(clean).not.toContain('alert(1)');
    expect(clean.length).toBeLessThanOrEqual(10_000);
  });

  it('does not duplicate rel when a target link already supplies one', () => {
    const clean = sanitizeMessageContent('<a href="https://example.com" rel="nofollow" target="_blank">x</a>');
    expect((clean.match(/\brel=/g) || [])).toHaveLength(1);
  });

  it('normalizes display names and titles as bounded plain text', () => {
    expect(sanitizeDisplayName(undefined)).toBe('');
    expect(sanitizeDisplayName('  <b>Ada</b>  ')).toBe('Ada');
    expect(sanitizeTitle(null)).toBe('');
    expect(sanitizeTitle('  <b>hello</b>\r\n\tworld  ')).toBe('hello   world');
    expect(sanitizeTitle('x'.repeat(150))).toHaveLength(100);
  });

  it('uses a stricter allowlist for ActivityPub content', () => {
    expect(sanitizeActivityPubContent(3)).toBe('');
    const clean = sanitizeActivityPubContent('<p><strong>ok</strong><img src="https://x.test/a.png"><script>x</script></p>');
    expect(clean).toContain('<strong>ok</strong>');
    expect(clean).not.toMatch(/<img|<script/i);
  });

  it.each([
    ['https://example.com/a b', 'https://example.com/a%20b'],
    ['mailto:user@example.com', 'mailto:user@example.com'],
    ['matrix:u/user:example.com', 'matrix:u/user:example.com'],
  ])('accepts and normalizes allowed URL %s', (raw, expected) => {
    expect(sanitizeUrl(raw)).toBe(expected);
  });

  it.each([null, 12, '', ' javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url'])
  ('blocks invalid or disallowed URL %#', (raw) => {
    expect(sanitizeUrl(raw)).toBeNull();
  });

  it('validates clean database strings without type or control-character coercion', () => {
    expect(isCleanString('normal')).toBe(true);
    expect(isCleanString('x'.repeat(255))).toBe(true);
    expect(isCleanString('x'.repeat(256))).toBe(false);
    expect(isCleanString('x', 0)).toBe(false);
    expect(isCleanString('a\u0000b')).toBe(false);
    expect(isCleanString('a\u001fb')).toBe(false);
    expect(isCleanString('a\tb')).toBe(true);
    expect(isCleanString(123)).toBe(false);
  });
});
