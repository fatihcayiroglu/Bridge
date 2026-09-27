// server/lib/botScopes.ts
//
// What a bot is allowed to do in a server — the ONLY capabilities Bridge
// enforces for bots (Final21 Phase 14).
//
// Measured before this module existed: a bot could register slash commands and
// receive the invocations addressed to it, but could not act at all (the Bot SDK
// marked every action unsupported). Marketplace listings nevertheless declared
// `members:ban`, `roles:assign`, `voice:join` … — capabilities that were neither
// implemented nor enforced, shown to server admins as if they meant something.
//
// The vocabulary is deliberately small. A scope exists here only when the server
// enforces it; a listing that declares anything else is not installable.

export const BOT_SCOPES = ['commands', 'messages:reply'] as const;
export type BotScope = typeof BOT_SCOPES[number];

/** Every grant includes this: receiving the slash commands a user invokes. */
export const BASE_BOT_SCOPE: BotScope = 'commands';

const KNOWN = new Set<string>(BOT_SCOPES);

export function isBotScope(value: unknown): value is BotScope {
  return typeof value === 'string' && KNOWN.has(value);
}

/**
 * Splits declared permissions into enforceable scopes and unsupported entries.
 * The result is de-duplicated and in canonical order, so two declarations can be
 * compared for equality.
 */
export function classifyBotPermissions(input: unknown): { scopes: BotScope[]; unsupported: string[] } {
  const values = Array.isArray(input) ? input : [];
  const unsupported = new Set<string>();
  const scopes = new Set<BotScope>();
  for (const value of values) {
    if (isBotScope(value)) scopes.add(value);
    else unsupported.add(typeof value === 'string' ? value : JSON.stringify(value));
  }
  return { scopes: BOT_SCOPES.filter((scope) => scopes.has(scope)), unsupported: [...unsupported].sort() };
}

/**
 * Validates a declaration a listing author submits: known scopes only, and the
 * base scope must be present. Returns the canonical list or a reason.
 */
export function validateDeclaredBotScopes(input: unknown): { ok: true; scopes: BotScope[] } | { ok: false; reason: string } {
  if (input === undefined) return { ok: true, scopes: [BASE_BOT_SCOPE] };
  if (!Array.isArray(input)) return { ok: false, reason: 'permissions must be an array' };
  const { scopes, unsupported } = classifyBotPermissions(input);
  if (unsupported.length) return { ok: false, reason: `unsupported permissions: ${unsupported.join(', ')}` };
  if (!scopes.includes(BASE_BOT_SCOPE)) return { ok: false, reason: `permissions must include "${BASE_BOT_SCOPE}"` };
  return { ok: true, scopes };
}

/** Reads a persisted grant; anything unreadable collapses to the base scope only (fail closed). */
export function readGrantedBotScopes(value: unknown): BotScope[] {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { parsed = null; }
  }
  const { scopes } = classifyBotPermissions(parsed);
  return scopes.includes(BASE_BOT_SCOPE) ? scopes : [BASE_BOT_SCOPE];
}

/** Consent must cover exactly what the listing declares — no silent partial or extra grants. */
export function consentMatches(declared: readonly BotScope[], accepted: unknown): boolean {
  if (!Array.isArray(accepted)) return false;
  const { scopes, unsupported } = classifyBotPermissions(accepted);
  return unsupported.length === 0 && scopes.length === declared.length && scopes.every((scope, i) => scope === declared[i]);
}
