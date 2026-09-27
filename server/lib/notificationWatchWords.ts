// server/lib/notificationWatchWords.ts
// User-defined literal watch words for attention notifications.
// Keep matching deliberately simple and bounded: exact normalized tokens only.

export const MAX_NOTIFICATION_WATCH_WORDS = 10;
export const MAX_MESSAGE_WATCH_TOKENS = 128;

const WATCH_WORD_RE = /^[\p{L}\p{N}_-]{2,32}$/u;
const MESSAGE_TOKEN_RE = /[\p{L}\p{N}_-]{2,32}/gu;

export function normalizeNotificationWatchWord(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFKC').trim().toLowerCase();
  return WATCH_WORD_RE.test(normalized) ? normalized : null;
}

export function normalizeNotificationWatchWords(values: unknown): string[] | null {
  if (!Array.isArray(values) || values.length > MAX_NOTIFICATION_WATCH_WORDS) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const word = normalizeNotificationWatchWord(value);
    if (!word) return null;
    if (!seen.has(word)) { seen.add(word); out.push(word); }
  }
  return out;
}

export function extractNotificationWatchTokens(content: string): string[] {
  const normalized = String(content ?? '').normalize('NFKC').toLowerCase();
  const matches = normalized.match(MESSAGE_TOKEN_RE) ?? [];
  return [...new Set(matches)].slice(0, MAX_MESSAGE_WATCH_TOKENS);
}
