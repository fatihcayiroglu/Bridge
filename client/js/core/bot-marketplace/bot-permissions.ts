// client/js/core/bot-marketplace/bot-permissions.ts
//
// Plain-language wording for the scopes a bot asks for (Final21 Phase 14). The
// server owns the policy (server/lib/botScopes.ts) and sends each listing's
// canonical `requestedScopes`; this module only describes them and never decides
// what is grantable.

type Translate = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;

export function describeBotPermission(scope: string, translate: Translate): string {
  switch (scope) {
    case 'commands': return translate('bot_perm_commands', 'Kullanıcıların çağırdığı komutları almak');
    case 'messages:reply': return translate('bot_perm_messages_reply', 'Çağrıldığı kanalda yanıt vermek');
    default: return translate('bot_perm_unsupported', 'Desteklenmeyen izin: {name}', { name: scope });
  }
}

/** Order-insensitive equality of two scope lists. */
export function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((scope) => right.has(scope));
}
