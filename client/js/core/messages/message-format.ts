// client/js/core/messages/message-format.ts
//
// Channel message text: what the person typed, and the formatting they asked for
// (Final21 Phase 15).
//
// Measured before this module (real Chromium, tools/p15-entities-probe.mjs):
//   · typed  "if a < b && c > d"  →  shown "if a &lt; b &amp;&amp; c &gt; d"
//   · typed  "…search?q=1&lang=tr" →  shown "…search?q=1&amp;lang=tr"
// The server stores channel messages through an HTML sanitizer (entities encoded,
// lib/contentSanitizer.ts) while this client renders text, so every message with
// <, > or & was shown double-encoded. DMs, group DMs and threads are stored raw:
// decode ONLY channel-message content.
//
//   · formatting (`**bold**`, `` `code` `` …) was shown as raw punctuation.
//
// Safety model: the output is a node tree rendered by Svelte text interpolation and
// real elements — never an HTML string, never {@html}. Link targets are http(s) only.

export type FormatNode =
  | { kind: 'text'; text: string }
  | { kind: 'strong' | 'em' | 'underline' | 'strike'; children: FormatNode[] }
  | { kind: 'code'; text: string }
  | { kind: 'codeblock'; text: string; language: string }
  | { kind: 'quote'; children: FormatNode[] }
  | { kind: 'link'; href: string; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

/**
 * One decoding pass over the entities the server sanitizer produces ("&amp;lt;" becomes
 * "&lt;", not "<"). Unknown entities are left untouched. Known loss upstream: the
 * sanitizer normalizes entities it RECEIVES, so text typed as "&lt;" is stored — and
 * shown — as "<"; that spelling cannot be recovered on the client.
 */
export function decodeStoredText(value: unknown): string {
  if (typeof value !== 'string' || !value.includes('&')) return typeof value === 'string' ? value : '';
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/**
 * Storage format of channel message text (Final21 Phase 16, server/lib/storedText.ts).
 * 1 = RAW: stored exactly as typed — never decode it, or typed "&amp;" would become "&".
 * 0 / absent = LEGACY: written through the old HTML sanitizer — decode once.
 */
export const RAW_TEXT_FORMAT = 1;

/** Anything that carries message text: a message, a reply snapshot, an edit-history entry, a search hit. */
export interface StoredTextLike {
  content?: unknown;
  contentFormat?: unknown;
}

/**
 * The text a person typed. Replaces a bare decodeStoredText(x.content): that decoded EVERY
 * channel message, which is right only for rows written before Phase 16.
 */
export function messageText(record: StoredTextLike | null | undefined): string {
  if (!record) return '';
  if (record.contentFormat === RAW_TEXT_FORMAT) return typeof record.content === 'string' ? record.content : '';
  return decodeStoredText(record.content);
}

const MAX_DEPTH = 6;
const URL_PATTERN = /^https?:\/\/[^\s<>"]+/i;
const TRAILING_URL_PUNCTUATION = /[.,:;!?'")\]}]+$/;

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function pushText(out: FormatNode[], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.kind === 'text') last.text += text;
  else out.push({ kind: 'text', text });
}

const DELIMITERS: Array<{ token: string; kind: 'strong' | 'em' | 'underline' | 'strike'; wordBoundary: boolean }> = [
  { token: '**', kind: 'strong', wordBoundary: false },
  { token: '__', kind: 'underline', wordBoundary: true },
  { token: '~~', kind: 'strike', wordBoundary: false },
  { token: '*', kind: 'em', wordBoundary: false },
  { token: '_', kind: 'em', wordBoundary: true },
];

/** Index of a valid closing delimiter, or -1. Content must be non-empty and not start/end with a space. */
function findClose(text: string, from: number, token: string, wordBoundary: boolean): number {
  let index = text.indexOf(token, from + 1);
  while (index !== -1) {
    // A run longer than the token ("***" closing "**bold *it***") closes at its END, so an
    // inner single-character delimiter keeps its own closing character.
    if (token.length > 1) {
      let run = index;
      while (text[run + token.length] === token[0]) run += 1;
      index = run;
    }
    const inner = text.slice(from, index);
    const after = text[index + token.length];
    const doubled = token.length === 1 && after === token; // "**" is not the end of "*"
    if (inner.length > 0 && !/^\s|\s$/.test(inner) && !doubled && (!wordBoundary || !isWordChar(after)) && !inner.includes('\n\n')) {
      return index;
    }
    index = text.indexOf(token, index + 1);
  }
  return -1;
}

function parseInline(text: string, depth: number): FormatNode[] {
  const out: FormatNode[] = [];
  let i = 0;
  let plain = '';
  const flush = () => { pushText(out, plain); plain = ''; };

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1 && !text.slice(i + 1, close).includes('\n')) {
        flush();
        out.push({ kind: 'code', text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    if ((ch === 'h' || ch === 'H') && !isWordChar(text[i - 1])) {
      const match = URL_PATTERN.exec(text.slice(i));
      if (match) {
        const raw = match[0].replace(TRAILING_URL_PUNCTUATION, '');
        const href = safeHref(raw);
        if (href) {
          flush();
          out.push({ kind: 'link', href, text: raw });
          i += raw.length;
          continue;
        }
      }
    }

    if (depth < MAX_DEPTH) {
      const delimiter = DELIMITERS.find((d) => text.startsWith(d.token, i));
      if (delimiter && (!delimiter.wordBoundary || !isWordChar(text[i - 1]))) {
        const start = i + delimiter.token.length;
        const close = findClose(text, start, delimiter.token, delimiter.wordBoundary);
        if (close !== -1) {
          flush();
          out.push({ kind: delimiter.kind, children: parseInline(text.slice(start, close), depth + 1) });
          i = close + delimiter.token.length;
          continue;
        }
      }
    }

    plain += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Quote blocks ("> " at line start), everything else inline. Newlines stay in text (pre-wrap). */
function parseBlocks(text: string, out: FormatNode[]): void {
  const lines = text.split('\n');
  let buffer: string[] = [];
  let quote: string[] = [];
  const flushBuffer = (trailingNewline: boolean) => {
    if (!buffer.length) return;
    for (const node of parseInline(buffer.join('\n') + (trailingNewline ? '\n' : ''), 0)) {
      if (node.kind === 'text') pushText(out, node.text);
      else out.push(node);
    }
    buffer = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    out.push({ kind: 'quote', children: parseInline(quote.join('\n'), 0) });
    quote = [];
  };
  lines.forEach((line, index) => {
    const quoted = /^> ?/.exec(line);
    if (quoted && line.length > 1) {
      flushBuffer(false);
      quote.push(line.slice(quoted[0].length));
    } else {
      flushQuote();
      buffer.push(line);
    }
    if (index === lines.length - 1) { flushQuote(); flushBuffer(false); }
  });
}

/** Parse decoded channel message text into renderable nodes. */
export function formatMessage(text: string): FormatNode[] {
  const out: FormatNode[] = [];
  const fence = /```([\w+-]{0,20})\n?([\s\S]*?)```/g;
  let last = 0;
  for (let match = fence.exec(text); match; match = fence.exec(text)) {
    if (match[2]!.length === 0) continue;
    parseBlocks(text.slice(last, match.index), out);
    out.push({ kind: 'codeblock', language: match[1] ?? '', text: match[2]!.replace(/\n$/, '') });
    last = match.index + match[0].length;
    if (text[last] === '\n') last += 1; // the block already ends the line
  }
  parseBlocks(text.slice(last), out);
  return out;
}

/** Visible text of a node tree (tests, previews, accessibility checks). */
export function nodesToText(nodes: readonly FormatNode[]): string {
  return nodes.map((node) => ('children' in node ? nodesToText(node.children) : node.text)).join('');
}
