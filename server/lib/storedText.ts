// server/lib/storedText.ts
//
// How channel message text is stored, and how to read it back as the text a person typed.
//
// ════════════════════════════════════════════════════════════════════════════
// TWO STORAGE FORMATS (Final21 Phase 16)
// ════════════════════════════════════════════════════════════════════════════
// LEGACY (contentFormat 0 / absent): content went through the HTML sanitizer
// (lib/contentSanitizer.ts) on write. "<", ">" and "&" were kept as entities, and the
// sanitizer REWROTE anything that looked like markup. Measured in Phase 16 (13 typed
// inputs → stored → shown): only 3 survived. `Vec<String>` became `Vec`,
// `Map<String, List<Integer>>` became `Map>`, `if (a<b && c>d)` became
// `if (a<b>d) {}</b>`, `mail me <alice@example.com>` lost the address. The sanitizer bought
// no safety: no surface renders message content as HTML (the client prints text, search
// escapes before adding <mark>, email never carries message bodies, and channel messages
// are not federated) — DMs, group DMs and threads were already stored raw on that basis.
//
// RAW (contentFormat 1): what was typed, bounded and stripped of invisible control
// characters, nothing else. Every write stores RAW from Phase 16 on. Legacy rows are not
// rewritten — the sanitizer's losses are irreversible, and a bulk rewrite of history is
// a risk with no benefit — they are decoded once on read, exactly as before.
//
// The client twin is client/js/core/messages/message-format.ts.

/** Stored content is the literal text that was typed. */
export const RAW_TEXT_FORMAT = 1;

/** Same bound the sanitizer enforced; longer input is cut, never rejected here. */
export const MAX_MESSAGE_TEXT = 10_000;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/**
 * Single decoding pass for LEGACY content ("&amp;lt;" becomes "&lt;", not "<"). Known loss
 * upstream: the sanitizer normalized entities it received, so text typed as "&lt;" or "&copy;"
 * was stored as "&lt;" / "©" and is shown as "<" / "©" — not recoverable here.
 */
export function decodeStoredMessageText(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return entity;
      return String.fromCodePoint(code);
    }
    return NAMED[body.toLowerCase()] ?? entity;
  });
}

// C0 controls except TAB, LF, CR; DEL; C1 controls. They are invisible, can corrupt exports
// and terminals, and NUL is rejected by PostgreSQL TEXT. Everything visible is kept verbatim.
const INVISIBLE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** What a RAW write stores: the typed text, bounded, without invisible control characters. */
export function normalizeMessageText(content: unknown): string {
  if (typeof content !== 'string' || content.length === 0) return '';
  const bounded = content.length > MAX_MESSAGE_TEXT ? content.slice(0, MAX_MESSAGE_TEXT) : content;
  return bounded.replace(INVISIBLE_CONTROLS, '');
}

/** Minimal shape of anything that carries stored channel text. */
export interface StoredTextRecord {
  content?: unknown;
  contentFormat?: unknown;
}

/** The text a person typed, whichever format the record was stored in. */
export function storedMessageText(record: StoredTextRecord | null | undefined): string {
  if (!record) return '';
  if (record.contentFormat === RAW_TEXT_FORMAT) return typeof record.content === 'string' ? record.content : '';
  return decodeStoredMessageText(record.content);
}
