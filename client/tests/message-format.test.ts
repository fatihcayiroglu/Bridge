// client/tests/message-format.test.ts — Final21 Phase 15: channel message text and formatting.

import { describe, expect, it } from 'vitest';
import { decodeStoredText, formatMessage, messageText, nodesToText, RAW_TEXT_FORMAT, type FormatNode } from '../js/core/messages/message-format.ts';

describe('decodeStoredText — what the server sanitizer stored becomes what was typed', () => {
  it.each([
    // [typed, stored by lib/contentSanitizer.ts (measured)]
    ['if a < b && c > d', 'if a &lt; b &amp;&amp; c &gt; d'],
    ['https://example.com/search?q=1&lang=tr', 'https://example.com/search?q=1&amp;lang=tr'],
    ['arrow -> and fish <><', 'arrow -&gt; and fish &lt;&gt;&lt;'],
    ['<@1234> hi', '&lt;@1234&gt; hi'],
  ])('%j', (typed, stored) => {
    expect(decodeStoredText(stored)).toBe(typed);
  });

  it('decodes exactly one level', () => {
    expect(decodeStoredText('&amp;lt;')).toBe('&lt;');
  });

  it('decodes numeric entities and leaves unknown or invalid ones alone', () => {
    expect(decodeStoredText('&#39;q&#x27; &quot;x&quot;')).toBe(`'q' "x"`);
    expect(decodeStoredText('&unknown; &#0; &#xD800; &#99999999;')).toBe('&unknown; &#0; &#xD800; &#99999999;');
  });

  it('non-strings become empty text; text without & is returned as is', () => {
    expect(decodeStoredText(undefined)).toBe('');
    expect(decodeStoredText(42)).toBe('');
    expect(decodeStoredText('plain')).toBe('plain');
  });
});

const kinds = (nodes: FormatNode[]): unknown => nodes.map((node) =>
  'children' in node ? { [node.kind]: kinds(node.children) } : node.kind === 'text' ? node.text : { [node.kind]: node.text });

describe('formatMessage', () => {
  it('bold, italic, underline, strike and nesting', () => {
    expect(kinds(formatMessage('**bold** *it* _it2_ __under__ ~~gone~~ **bold *and it***'))).toEqual([
      { strong: ['bold'] }, ' ', { em: ['it'] }, ' ', { em: ['it2'] }, ' ', { underline: ['under'] }, ' ',
      { strike: ['gone'] }, ' ', { strong: ['bold ', { em: ['and it'] }] },
    ]);
  });

  it('inline code and code blocks are literal — no formatting inside', () => {
    expect(kinds(formatMessage('run `a **b** c` now'))).toEqual(['run ', { code: 'a **b** c' }, ' now']);
    const nodes = formatMessage('see:\n```ts\nconst x = a < b && **y**;\n```\nafter');
    expect(nodes).toEqual([
      { kind: 'text', text: 'see:\n' },
      { kind: 'codeblock', language: 'ts', text: 'const x = a < b && **y**;' },
      { kind: 'text', text: 'after' },
    ]);
  });

  it('does not italicise snake_case, lone markers or spaced markers', () => {
    const text = 'my_var_name and 5 * 3 * 2 and ** not bold ** and _ x_';
    expect(formatMessage(text)).toEqual([{ kind: 'text', text }]);
  });

  it('links: http(s) only, trailing punctuation stays text, never other schemes', () => {
    expect(kinds(formatMessage('see https://example.com/a?b=1&c=2. or javascript:alert(1) or ftp://x'))).toEqual([
      'see ', { link: 'https://example.com/a?b=1&c=2' }, '. or javascript:alert(1) or ftp://x',
    ]);
    const [link] = formatMessage('https://example.com/p').filter((node) => node.kind === 'link') as Array<{ href: string }>;
    expect(link!.href).toBe('https://example.com/p');
  });

  it('quote lines become a quote block; surrounding lines stay text', () => {
    expect(kinds(formatMessage('hello\n> quoted **line**\n> second\nbye'))).toEqual([
      'hello', { quote: ['quoted ', { strong: ['line'] }, '\nsecond'] }, 'bye',
    ]);
  });

  it('the visible text never loses characters for unformatted input', () => {
    for (const text of ['a < b && c > d', 'emoji 🎉 türkçe çğıöşü', 'multi\n\nline', '* bullet\n* list', '`unclosed', '**unclosed']) {
      expect(nodesToText(formatMessage(text))).toBe(text);
    }
  });

  it('pathological nesting is bounded (no stack blow-up, no lost text)', () => {
    const text = `${'**'.repeat(200)}x${'**'.repeat(200)}`;
    expect(() => formatMessage(text)).not.toThrow();
    expect(nodesToText(formatMessage(text))).toContain('x');
  });
});

// Final21 Phase 16: channel text written from now on is stored RAW (contentFormat 1). Decoding it
// would corrupt text that literally contains an entity; only LEGACY rows are decoded.
describe('messageText — decode only what was stored through the old sanitizer', () => {
  it('shows RAW text exactly as typed, entities included', () => {
    expect(messageText({ content: 'Vec<String> & type &amp; here', contentFormat: RAW_TEXT_FORMAT }))
      .toBe('Vec<String> & type &amp; here');
  });

  it('decodes LEGACY text once, as before', () => {
    expect(messageText({ content: 'a &lt; b &amp;&amp; c', contentFormat: 0 })).toBe('a < b && c');
    expect(messageText({ content: 'a &lt; b' })).toBe('a < b');
  });

  it('works for reply snapshots and edit-history entries (they carry their own format)', () => {
    const replyTo = { _id: 'm1', content: '<3 &amp;', contentFormat: 1 };
    const history = { content: 'x &gt; y', editedAt: 1 };
    expect(messageText(replyTo)).toBe('<3 &amp;');
    expect(messageText(history)).toBe('x > y');
  });

  it('missing records and non-string content render as empty text', () => {
    expect(messageText(null)).toBe('');
    expect(messageText(undefined)).toBe('');
    expect(messageText({ content: 7, contentFormat: 1 })).toBe('');
  });

  it('formatting still applies on top of RAW text', () => {
    const nodes = formatMessage(messageText({ content: '**a<b**', contentFormat: 1 }));
    expect(nodes).toEqual([{ kind: 'strong', children: [{ kind: 'text', text: 'a<b' }] }]);
  });
});
