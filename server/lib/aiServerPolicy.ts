// server/lib/aiServerPolicy.ts
//
// P6 — per-server AI opt-out.
//
// The installation decides WHETHER AI exists (AI_PROVIDER, lib/aiProvider.ts).
// A server owner decides whether THEIR server's content may reach it: a
// server with `aiEnabled = false` sends nothing to an AI provider — no channel
// context, no message text, no audio, no embeddings. Routes that have a local
// (rules) fallback serve it, exactly as when the installation has AI off;
// routes without one answer 403 `AI_DISABLED_FOR_SERVER`.
//
// Rules:
//   · checked on the server, from the stored row — never from the request;
//   · checked AFTER the requester's own permission check, so a non-member
//     learns nothing about a server's settings;
//   · read on every request (no cache), so turning it off or on takes effect
//     on the very next request;
//   · fail closed: a missing server or an unreadable row means "no AI".
//
// Default for existing and new servers: enabled. AI still needs the operator
// to configure a provider, so this preserves P5 behaviour; the owner opts out.

import { Servers } from '../db/repositories';
import logger from './logger';

export const AI_DISABLED_FOR_SERVER = 'AI_DISABLED_FOR_SERVER';
export const AI_DISABLED_FOR_SERVER_MESSAGE = 'AI features are turned off for this server.';

type AiFlagRow = { _id?: unknown; aiEnabled?: unknown } | null | undefined;

/** The stored flag: only an explicit false (or its storage forms) turns AI off. */
export function rowAllowsAi(row: AiFlagRow): boolean {
  if (!row) return false;
  const v = row.aiEnabled;
  return !(v === false || v === 0 || v === 'false' || v === 'f');
}

/** True when this server's content may be sent to an AI provider. Fail-closed. */
export async function serverAllowsAi(serverId: unknown): Promise<boolean> {
  if (typeof serverId !== 'string' || !serverId) return false;
  try {
    return rowAllowsAi(await Servers.findById(serverId) as AiFlagRow);
  } catch (err) {
    logger.warn({ event: 'ai.server_policy.read_failed', err: err instanceof Error ? err.message.slice(0, 200) : 'non-error' },
      'Server AI setting could not be read; treating AI as off for this request.');
    return false;
  }
}

/** The subset of `serverIds` whose content may be sent to an AI provider. Fail-closed. */
export async function serversAllowingAi(serverIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(serverIds.filter((s) => typeof s === 'string' && s))];
  if (!ids.length) return new Set();
  try {
    const rows = await Servers.findByIds(ids) as Array<{ _id?: unknown; aiEnabled?: unknown }>;
    return new Set(rows.filter(rowAllowsAi).map((r) => String(r._id)));
  } catch (err) {
    logger.warn({ event: 'ai.server_policy.read_failed', err: err instanceof Error ? err.message.slice(0, 200) : 'non-error' },
      'Server AI settings could not be read; treating AI as off for this request.');
    return new Set();
  }
}
