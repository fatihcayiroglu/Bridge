// server/lib/serverMfaPolicy.ts
// Canonical server MFA policy used by every membership entry path.
//
// API writes are intentionally strict: OpenAPI declares an integer enum, so
// strings such as "2" are not accepted. Persisted unknown values are treated
// as the strongest supported level (2) rather than silently disabling MFA.

import { Auth } from '../db/repositories';
import logger from './logger';

export type ServerMfaLevel = 0 | 1 | 2;

export function parseServerMfaLevelWrite(value: unknown): ServerMfaLevel | null {
  return value === 0 || value === 1 || value === 2 ? value : null;
}

export function effectiveServerMfaLevel(value: unknown): ServerMfaLevel {
  // Older rows created before migration 016 legitimately have no explicit
  // value and inherit the historical/default policy: MFA disabled.
  if (value === undefined || value === null) return 0;
  return parseServerMfaLevelWrite(value) ?? 2;
}

export interface ServerMfaCheck {
  level: ServerMfaLevel;
  required: boolean;
  satisfied: boolean;
  unavailable: boolean;
}

export async function checkServerJoinMfa(
  userId: string,
  serverId: string,
  persistedLevel: unknown,
): Promise<ServerMfaCheck> {
  const level = effectiveServerMfaLevel(persistedLevel);
  if (level === 0) {
    return { level, required: false, satisfied: true, unavailable: false };
  }

  try {
    const credentials = await Auth.findCredentialsByUser(userId);
    return {
      level,
      required: true,
      satisfied: Array.isArray(credentials) && credentials.length > 0,
      unavailable: false,
    };
  } catch (err) {
    logger.error(
      { err, userId, serverId, event: 'server_join.mfa_lookup_failed' },
      '[ServerJoin] Passkey lookup failed; MFA requirement treated as unmet (fail-closed).',
    );
    return { level, required: true, satisfied: false, unavailable: true };
  }
}
