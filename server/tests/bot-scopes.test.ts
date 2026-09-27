// server/tests/bot-scopes.test.ts — the only bot capabilities Bridge enforces (Final21 Phase 14).

import {
  BOT_SCOPES,
  classifyBotPermissions,
  consentMatches,
  readGrantedBotScopes,
  validateDeclaredBotScopes,
} from '../lib/botScopes';

describe('bot scope vocabulary', () => {
  it('contains only enforced capabilities, in canonical order', () => {
    expect(BOT_SCOPES).toEqual(['commands', 'messages:reply']);
  });

  it('separates enforceable scopes from unsupported declarations', () => {
    expect(classifyBotPermissions(['messages:reply', 'members:ban', 'commands', 'members:ban', 42])).toEqual({
      scopes: ['commands', 'messages:reply'],
      unsupported: ['42', 'members:ban'],
    });
    expect(classifyBotPermissions('commands')).toEqual({ scopes: [], unsupported: [] });
  });

  it('validates a listing declaration', () => {
    expect(validateDeclaredBotScopes(undefined)).toEqual({ ok: true, scopes: ['commands'] });
    expect(validateDeclaredBotScopes(['messages:reply', 'commands'])).toEqual({ ok: true, scopes: ['commands', 'messages:reply'] });
    expect(validateDeclaredBotScopes(['commands', 'voice:join'])).toEqual({ ok: false, reason: 'unsupported permissions: voice:join' });
    expect(validateDeclaredBotScopes(['messages:reply'])).toEqual({ ok: false, reason: 'permissions must include "commands"' });
    expect(validateDeclaredBotScopes({ commands: true })).toEqual({ ok: false, reason: 'permissions must be an array' });
  });

  it('reads a persisted grant fail-closed', () => {
    expect(readGrantedBotScopes(['commands', 'messages:reply'])).toEqual(['commands', 'messages:reply']);
    expect(readGrantedBotScopes('["commands","messages:reply"]')).toEqual(['commands', 'messages:reply']);
    expect(readGrantedBotScopes(['messages:reply'])).toEqual(['commands']);
    expect(readGrantedBotScopes('{broken')).toEqual(['commands']);
    expect(readGrantedBotScopes(null)).toEqual(['commands']);
  });

  it('accepts consent only for exactly the declared scopes', () => {
    const declared = ['commands', 'messages:reply'] as const;
    expect(consentMatches(declared, ['messages:reply', 'commands'])).toBe(true);
    expect(consentMatches(declared, ['commands'])).toBe(false);
    expect(consentMatches(declared, ['commands', 'messages:reply', 'members:ban'])).toBe(false);
    expect(consentMatches(declared, undefined)).toBe(false);
    expect(consentMatches(['commands'], ['commands'])).toBe(true);
  });
});
