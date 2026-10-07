// P7 A6 — offline search over the encrypted authorized local history cache.
//
// There is intentionally NO second plaintext search index. The bounded message
// snapshots are decrypted only in memory for the current account, searched, and
// discarded. Online global search stays server-authoritative.

import { messageText } from '../messages/message-format.ts';
import type {
  ContextMessage,
  SearchFilters,
  SearchHit,
  UnifiedSearchResponse,
} from '../search/unified-search-client.ts';
import {
  listLocalFirstHistory,
} from './history-runtime.ts';
import type {
  CachedMessage,
  LocalHistorySnapshot,
} from './history.ts';

export const LOCAL_SEARCH_MAX_PAGE = 100;
export const LOCAL_SEARCH_DEFAULT_PAGE = 40;

export interface LocalSearchOptions {
  filters?: SearchFilters;
  limit?: number;
  offset?: number;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalized(value: unknown): string {
  return text(value).trim().toLocaleLowerCase();
}

function termsOf(query: string): string[] {
  return normalized(query).split(/\s+/).filter(term => term.length > 0);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from < haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    count += 1;
    from = index + needle.length;
  }
  return count;
}

function dateBound(value: string | undefined): number | null | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasRequestedAttachment(message: CachedMessage, kind: string): boolean {
  const fileUrl = text(message.fileUrl);
  const fileType = text(message.fileType).toLowerCase();
  const content = messageText(message);

  if (kind === 'file') return Boolean(fileUrl);
  if (kind === 'image') {
    return Boolean(fileUrl) && (
      fileType.startsWith('image/')
      || /\.(?:png|jpe?g|gif|webp|avif|svg)(?:$|[?#])/i.test(fileUrl)
    );
  }
  if (kind === 'link') return /https?:\/\/[^\s<>"']+/i.test(content);
  return false;
}

function passesFilters(message: CachedMessage, filters: SearchFilters | undefined): boolean {
  if (!filters) return true;

  if (filters.channelId && text(message.channelId) !== filters.channelId) return false;

  if (filters.from) {
    const wanted = normalized(filters.from);
    const candidates = [
      message.userId,
      message.username,
      message.displayName,
    ].map(normalized);
    if (!wanted || !candidates.some(value => value.includes(wanted))) return false;
  }

  if (filters.in) {
    const wanted = normalized(filters.in).replace(/^#/, '');
    const channelName = normalized(message.channelName).replace(/^#/, '');
    // Do not broaden a name filter to every cached channel when old snapshots
    // do not carry channelName metadata.
    if (!wanted || !channelName || !channelName.includes(wanted)) return false;
  }

  if (filters.has && !hasRequestedAttachment(message, normalized(filters.has))) return false;

  const createdAt = number(message.createdAt);
  const after = dateBound(filters.after);
  const before = dateBound(filters.before);
  if (after === null || before === null) return false;
  if (after !== undefined && createdAt < after) return false;
  if (before !== undefined && createdAt > before) return false;

  return true;
}

function scoreMessage(contentLower: string, queryLower: string, terms: readonly string[]): number {
  let score = contentLower.includes(queryLower) ? 100 : 0;
  for (const term of terms) score += countOccurrences(contentLower, term) * 10;
  return score;
}

function toHit(message: CachedMessage, content: string, score: number): SearchHit {
  const hit: SearchHit = {
    id: message._id,
    source: 'channel',
    content,
    contentFormat: number(message.contentFormat),
    // GlobalSearchPanel performs safe client-side highlighting from content.
    highlight: '',
    authorName: text(message.displayName || message.username),
    authorId: text(message.userId),
    createdAt: number(message.createdAt),
    score,
  };

  const channelId = text(message.channelId);
  if (channelId) hit.channelId = channelId;
  const channelName = text(message.channelName);
  if (channelName) hit.channelName = channelName;
  const serverId = text(message.serverId);
  if (serverId) hit.serverId = serverId;
  const threadId = text(message.threadId);
  if (threadId) hit.threadId = threadId;
  return hit;
}

export function searchHistorySnapshots(
  snapshots: readonly LocalHistorySnapshot[],
  query: string,
  options: LocalSearchOptions = {},
): UnifiedSearchResponse {
  const queryLower = normalized(query);
  const terms = termsOf(query);
  if (queryLower.length < 2 || !terms.length) return { hits: [], hasMore: false };

  const offset = Math.max(0, Math.trunc(number(options.offset)));
  const limit = Math.min(
    LOCAL_SEARCH_MAX_PAGE,
    Math.max(1, Math.trunc(number(options.limit) || LOCAL_SEARCH_DEFAULT_PAGE)),
  );

  const candidates: SearchHit[] = [];
  for (const snapshot of snapshots) {
    for (const message of snapshot.messages) {
      if (!passesFilters(message, options.filters)) continue;

      // Only the legitimately rendered plaintext field is searched. Encrypted
      // payload fields are neither tokenized nor copied to another service.
      const content = messageText(message);
      if (!content) continue;
      const contentLower = content.toLocaleLowerCase();
      if (!terms.every(term => contentLower.includes(term))) continue;

      candidates.push(toHit(
        message,
        content,
        scoreMessage(contentLower, queryLower, terms),
      ));
    }
  }

  candidates.sort((a, b) =>
    b.score - a.score
    || b.createdAt - a.createdAt
    || a.id.localeCompare(b.id)
  );

  return {
    hits: candidates.slice(offset, offset + limit),
    hasMore: offset + limit < candidates.length,
  };
}

export async function searchLocalFirstHistory(
  userId: string,
  query: string,
  options: LocalSearchOptions = {},
): Promise<UnifiedSearchResponse> {
  return searchHistorySnapshots(
    await listLocalFirstHistory(userId),
    query,
    options,
  );
}

export function localContextFromSnapshots(
  snapshots: readonly LocalHistorySnapshot[],
  channelId: string,
  messageId: string,
  radius = 2,
): ContextMessage[] {
  const snapshot = snapshots.find(item => item.channelId === channelId);
  if (!snapshot) return [];
  const index = snapshot.messages.findIndex(message => message._id === messageId);
  if (index < 0) return [];

  const safeRadius = Math.max(0, Math.min(5, Math.trunc(number(radius))));
  return snapshot.messages
    .slice(Math.max(0, index - safeRadius), index + safeRadius + 1)
    .map(message => ({
      _id: message._id,
      userId: text(message.userId),
      displayName: text(message.displayName || message.username) || null,
      content: messageText(message),
      contentFormat: number(message.contentFormat),
      createdAt: number(message.createdAt),
      isAnchor: message._id === messageId,
    }));
}

export async function localFirstSearchContext(
  userId: string,
  channelId: string,
  messageId: string,
  radius = 2,
): Promise<ContextMessage[]> {
  return localContextFromSnapshots(
    await listLocalFirstHistory(userId),
    channelId,
    messageId,
    radius,
  );
}
