// client/tests/mention-query.test.ts — Final21 Phase 15: @mention suggestions.

import { describe, expect, it } from 'vitest';
import { activeMentionQuery, applyMention, rankMentionCandidates } from '../js/core/composer/mention-query.ts';

describe('activeMentionQuery', () => {
  it.each([
    ['@', 1, { start: 0, query: '' }],
    ['hi @bo', 6, { start: 3, query: 'bo' }],
    ['hi @çağ', 7, { start: 3, query: 'çağ' }],
    ['line\n@al', 8, { start: 5, query: 'al' }],
    ['@alice hello', 6, { start: 0, query: 'alice' }],
  ])('%j at %d', (text, caret, expected) => {
    expect(activeMentionQuery(text, caret)).toEqual(expected);
  });

  it.each([
    ['mail me at a@b.com', 18],
    ['no mention', 10],
    ['@alice hello', 12],
    ['', 0],
    ['@bo', 9],
  ])('none for %j at %d', (text, caret) => {
    expect(activeMentionQuery(text, caret)).toBeNull();
  });
});

describe('rankMentionCandidates', () => {
  const members = [
    { _id: '1', username: 'zeynep', displayName: 'Zeynep Bora' },
    { _id: '2', username: 'bora_k', displayName: 'Bora Kaya' },
    { _id: '3', username: 'ali', displayName: 'Ali', nickname: 'Borakay' },
    { _id: '4', username: 'cagla', displayName: 'Çağla Öz' },
    { _id: '2', username: 'bora_k', displayName: 'duplicate row' },
    { username: 'no-id' },
    { _id: '5' },
  ];

  it('username prefix, then display-name word prefix, then substring; nickname wins over display name', () => {
    expect(rankMentionCandidates(members, 'bor').map((c) => [c.username, c.displayName])).toEqual([
      ['bora_k', 'Bora Kaya'], ['zeynep', 'Zeynep Bora'], ['ali', 'Borakay'],
    ]);
  });

  it('matches without diacritics and case', () => {
    expect(rankMentionCandidates(members, 'CAG').map((c) => c.username)).toEqual(['cagla']);
    expect(rankMentionCandidates(members, 'çağ').map((c) => c.username)).toEqual(['cagla']);
  });

  it('an empty query lists members (bounded) and nothing matches nonsense', () => {
    expect(rankMentionCandidates(members, '', 2)).toHaveLength(2);
    expect(rankMentionCandidates(members, 'qqq')).toEqual([]);
  });
});

describe('applyMention', () => {
  it('replaces the query with the username and one space, caret after it', () => {
    expect(applyMention('hi @bo how', 6, { start: 3, query: 'bo' }, 'bora_k')).toEqual({ text: 'hi @bora_k how', caret: 11 });
    expect(applyMention('@', 1, { start: 0, query: '' }, 'ali')).toEqual({ text: '@ali ', caret: 5 });
  });
});
