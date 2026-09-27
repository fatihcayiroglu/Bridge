import {
  evaluateAutomodRules,
  normalizeAutomodConfig,
  parseStoredAutomodConfig,
} from '../lib/automodPolicy';

describe('canonical AutoMod policy', () => {
  it('accepts PostgreSQL JSONB objects and legacy JSON strings', () => {
    expect(parseStoredAutomodConfig({ words: ['x'] })).toEqual({ words: ['x'] });
    expect(parseStoredAutomodConfig('{"words":["x"]}')).toEqual({ words: ['x'] });
    expect(parseStoredAutomodConfig('["not-object"]')).toEqual({});
    expect(parseStoredAutomodConfig('{bad')).toEqual({});
  });

  it('rejects numeric coercion, unknown config fields and invalid blocked words', () => {
    expect(normalizeAutomodConfig('spam_messages', { maxMessages: '5' }).ok).toBe(false);
    expect(normalizeAutomodConfig('spam_messages', { maxMessages: 2.5 }).ok).toBe(false);
    expect(normalizeAutomodConfig('spam_messages', { maxMessages: -2 }).ok).toBe(false);
    expect(normalizeAutomodConfig('link_filter', { surprise: true }).ok).toBe(false);
    expect(normalizeAutomodConfig('blocked_words', { words: [123] }).ok).toBe(false);
    expect(normalizeAutomodConfig('blocked_words', { words: [] }).ok).toBe(false);
  });

  it('normalizes canonical defaults without weakening explicit bounds', () => {
    const result = normalizeAutomodConfig('spam_messages', {});
    expect(result).toEqual({
      ok: true,
      config: {
        action: 'delete', timeoutMs: 60_000, logChannelId: null, exemptRoles: [],
        maxMessages: 5, windowSecs: 5,
      },
    });
    expect(normalizeAutomodConfig('repeated_chars', { minRepeat: 4 }).ok).toBe(false);
    expect(normalizeAutomodConfig('mention_spam', { maxMentions: 21 }).ok).toBe(false);
    expect(normalizeAutomodConfig('caps_lock', { minLength: Number.MAX_SAFE_INTEGER }).ok).toBe(false);
  });

  it('aggregates delete + timeout actions across matching rules', async () => {
    const decision = await evaluateAutomodRules([
      { _id: 'r1', type: 'blocked_words', enabled: true, config: { words: ['forbidden'], action: 'delete' } },
      { _id: 'r2', type: 'caps_lock', enabled: true, config: { minLength: 4, action: 'timeout', timeoutMs: 120_000 } },
    ], {
      serverId: 's1', userId: 'u1', content: 'FORBIDDEN WORD', memberRoleIds: [],
    }, async () => 1);

    expect(decision.matched).toBe(true);
    expect(decision.deleteMessage).toBe(true);
    expect(decision.timeoutMs).toBe(120_000);
    expect(decision.matchedRuleIds).toEqual(['r1', 'r2']);
  });

  it('honors exempt roles and does not evaluate their rules', async () => {
    const increment = jest.fn().mockResolvedValue(999);
    const decision = await evaluateAutomodRules([
      { _id: 'spam', type: 'spam_messages', enabled: true, config: { exemptRoles: ['trusted'] } },
    ], {
      serverId: 's1', userId: 'u1', content: 'hello', memberRoleIds: ['trusted'],
    }, increment);
    expect(decision.matched).toBe(false);
    expect(increment).not.toHaveBeenCalled();
  });

  it('does not consume spam-frequency counters for message edits', async () => {
    const increment = jest.fn().mockResolvedValue(999);
    const decision = await evaluateAutomodRules([
      { _id: 'spam-edit', type: 'spam_messages', enabled: true, config: { maxMessages: 2, windowSecs: 9 } },
    ], {
      serverId: 's1', userId: 'u1', content: 'edited content', memberRoleIds: [], event: 'edit',
    }, increment);
    expect(increment).not.toHaveBeenCalled();
    expect(decision.matched).toBe(false);
  });

  it('uses an atomic counter dependency for spam thresholds', async () => {
    const increment = jest.fn().mockResolvedValue(4);
    const decision = await evaluateAutomodRules([
      { _id: 'spam', type: 'spam_messages', enabled: true, config: { maxMessages: 3, windowSecs: 9 } },
    ], {
      serverId: 's1', userId: 'u1', content: 'hello', memberRoleIds: [],
    }, increment);
    expect(increment).toHaveBeenCalledWith('automod:spam:s1:spam:u1', 9);
    expect(decision.deleteMessage).toBe(true);
  });

  it.each([
    ['link_filter', 'go to https://example.test now'],
    ['invite_filter', 'join /invite/a1b2c3d4'],
    ['mention_spam', '@a1 @a2 @a3'],
    ['repeated_chars', 'aaaaa'],
  ] as const)('enforces %s content rules', async (type, content) => {
    const config = type === 'mention_spam' ? { maxMentions: 2 }
      : type === 'repeated_chars' ? { minRepeat: 5 }
      : {};
    const decision = await evaluateAutomodRules([
      { _id: type, type, enabled: true, config },
    ], { serverId: 's', userId: 'u', content, memberRoleIds: [] }, async () => 1);
    expect(decision.deleteMessage).toBe(true);
  });

  it('skips genuinely disabled persisted rules', async () => {
    const decision = await evaluateAutomodRules([
      { _id: 'off', type: 'link_filter', enabled: false, config: {} },
    ], { serverId: 's', userId: 'u', content: 'https://example.test', memberRoleIds: [] }, async () => 100);
    expect(decision.matched).toBe(false);
  });

  it.each([
    [{ _id: 'bad-enabled', type: 'link_filter', enabled: 'true', config: {} }, /enabled state/],
    [{ _id: 'unknown', type: 'future_rule', enabled: true, config: {} }, /rule type/],
    [{ _id: 'bad-json', type: 'link_filter', enabled: true, config: '{bad' }, /config/],
    [{ _id: 'corrupt', type: 'blocked_words', enabled: true, config: { words: [] } }, /config/],
  ] as const)('fails closed when an enabled persisted rule is malformed: %p', async (rule, message) => {
    await expect(evaluateAutomodRules(
      [rule],
      { serverId: 's', userId: 'u', content: 'https://example.test', memberRoleIds: [] },
      async () => 100,
    )).rejects.toThrow(message);
  });
});
