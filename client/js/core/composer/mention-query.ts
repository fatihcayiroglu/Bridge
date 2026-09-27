// client/js/core/composer/mention-query.ts
//
// @mention suggestions in the composer (Final21 Phase 15). Measured before: typing "@bo"
// offered nothing (two-browser probe, C9); a person had to know and type the exact
// username. The server already resolves "@username" mentions (lib/notifications.ts), so
// the composer only needs to find the person and insert their username.

export interface MentionMember {
  _id?: string;
  id?: string;
  username?: string;
  displayName?: string;
  nickname?: string;
}

export interface MentionCandidate {
  id: string;
  username: string;
  displayName: string;
}

export interface MentionQuery {
  /** Index of the "@". */
  start: number;
  /** Text typed after "@" (may be empty). */
  query: string;
}

const TOKEN = /[\p{L}\p{N}_.-]/u;
const MAX_QUERY = 32;

/** The "@query" the caret is in, if any. "@" must start the text or follow whitespace. */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  if (caret < 1 || caret > text.length) return null;
  let index = caret - 1;
  while (index >= 0 && TOKEN.test(text[index]!) && caret - index <= MAX_QUERY) index -= 1;
  if (index < 0 || text[index] !== '@') return null;
  if (index > 0 && !/\s/.test(text[index - 1]!)) return null; // e-mail addresses, "a@b"
  return { start: index, query: text.slice(index + 1, caret) };
}

const fold = (value: string): string => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('tr');

/**
 * Members matching the query: username prefix first, then a display-name word prefix,
 * then a substring of either. Stable within each rank; at most `limit`.
 */
export function rankMentionCandidates(members: readonly MentionMember[], query: string, limit = 8): MentionCandidate[] {
  const q = fold(query);
  const ranked: Array<{ rank: number; order: number; candidate: MentionCandidate }> = [];
  const seen = new Set<string>();
  members.forEach((member, order) => {
    const id = String(member._id ?? member.id ?? '');
    const username = typeof member.username === 'string' ? member.username : '';
    if (!id || !username || seen.has(id)) return;
    seen.add(id);
    const displayName = member.nickname || member.displayName || username;
    const user = fold(username);
    const words = fold(displayName).split(/\s+/);
    let rank: number;
    if (!q || user.startsWith(q)) rank = 0;
    else if (words.some((word) => word.startsWith(q))) rank = 1;
    else if (user.includes(q) || fold(displayName).includes(q)) rank = 2;
    else return;
    ranked.push({ rank, order, candidate: { id, username, displayName } });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Replace "@query" with "@username " and return the new text and caret. */
export function applyMention(text: string, caret: number, mention: MentionQuery, username: string): { text: string; caret: number } {
  const insert = `@${username} `;
  const after = text.slice(caret).replace(/^ /, '');
  const next = `${text.slice(0, mention.start)}${insert}${after}`;
  return { text: next, caret: mention.start + insert.length };
}
