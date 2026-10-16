// server/lib/messageContentPolicy.ts
//
// The content checks a new plaintext message passes before it is stored,
// whichever path posts it: the socket channel send (socket/handlers/
// messages-send.ts), thread replies and forum posts (routes/threads.ts), and
// scheduled messages when they are posted (jobs/scheduledMessages.ts). One
// owner, so no path skips them; the thread routes and scheduled messages did,
// and posted what the channel refused.
//
//   1. P7 B1 content abuse (lib/abusePolicy.ts): the same text, or links to
//      one host, too often per window. Counted per account across paths.
//   2. P7 B1 mass mention: more than `mentions.perMessage` distinct people,
//      unless the sender has MENTION_EVERYONE.
//   3. The server's AutoMod rules. A matched rule's timeout is applied and
//      logged even when the message itself is allowed; a delete action refuses
//      it. A rule-store failure propagates, so an outage cannot silently
//      disable configured moderation (fail closed).
//
// Encrypted content and file messages are not inspected by the callers.
//
// Machine principals (machineContentRefused below) post through their own
// paths: an installed bot's interaction reply (`bot:<id>`), an incoming
// webhook (`webhook:<id>`) and a plugin (`plugin:<id>`). They get the server's
// AutoMod rules and not the P7 per-account limits. Bridge's own system and
// audit messages (AutoMod alerts, join notices) are written directly and are
// not moderated.

import { Automod, Members } from '../db/repositories';
import { ABUSE_POLICY, checkContentAbuse, mentionsWithinLimit } from './abusePolicy';
import { evaluateAutomodRules } from './automodPolicy';
import { normalizeAutomodMemberRoleIds, writeAutomodLogs } from './automodRuntime';
import { hasPermission, PERMS } from './permissions';
import { cache } from './redisAdapter';
import type { HandlerServer } from '../socket/handler-contracts';

export type MessageContentRefusal =
  | { kind: 'spam'; reason: 'spam_repeat' | 'spam_links'; retryAfterMs: number }
  | { kind: 'refused'; code: 'TOO_MANY_MENTIONS' | 'AUTOMOD_BLOCKED'; message: string };

export async function checkMessageContent(
  input: {
    userId: string;
    serverId: string;
    channelId: string;
    content: string;
    /** The sender's resolved permissions in this channel. */
    senderPerms: number;
    /** The sender's membership `roles` as stored (array or JSON text). */
    memberRoles: unknown;
    /** Shown in AutoMod log entries. */
    displayName: string;
  },
  io: HandlerServer | null,
): Promise<MessageContentRefusal | null> {
  const { userId, serverId, channelId, content } = input;

  const abuse = await checkContentAbuse(userId, content);
  if (!abuse.allowed) return { kind: 'spam', reason: abuse.reason, retryAfterMs: abuse.retryAfterMs };

  if (!mentionsWithinLimit(content, hasPermission(input.senderPerms, PERMS.MENTION_EVERYONE))) {
    return { kind: 'refused', code: 'TOO_MANY_MENTIONS', message: `En fazla ${ABUSE_POLICY.mentions.perMessage} kişi etiketlenebilir.` };
  }

  const decision = await evaluateAutomodRules(
    await Automod.findByServer(serverId),
    { serverId, userId, content, memberRoleIds: normalizeAutomodMemberRoleIds(input.memberRoles) },
    (key, ttlSeconds) => cache.increment(key, ttlSeconds),
  );
  if (!decision.matched) return null;
  if (decision.timeoutMs) {
    // The durable timeout is part of the action. If it fails, the message is
    // not stored as if the moderation action had succeeded.
    await Members.setTimeout(serverId, userId, Date.now() + decision.timeoutMs);
  }
  await writeAutomodLogs(decision, { serverId, channelId, userId, displayName: input.displayName, content }, io);
  if (decision.deleteMessage) {
    return { kind: 'refused', code: 'AUTOMOD_BLOCKED', message: decision.reasons.join(', ') || 'Mesaj AutoMod tarafından engellendi.' };
  }
  return null;
}

/**
 * The server's AutoMod rules for a machine principal posting into one of its
 * channels: `bot:<id>`, `webhook:<id>` or `plugin:<id>`. True when the post is
 * refused; the caller then stores and publishes nothing.
 *
 * A machine is not a member: it has no roles, so role exemptions never apply,
 * and it cannot be timed out, so any matching rule refuses the post (whatever
 * its configured action). A match is written to the rule's log channels.
 * Message-frequency rules count each principal on its own. A rule-store
 * failure propagates (fail closed); each caller answers it.
 *
 * The P7 per-account limits (checkMessageContent) do not apply: they bound one
 * person's posting across paths, while a webhook or plugin is one principal
 * that may legitimately post the same text to many channels. Each machine path
 * keeps its own volume control (bot reply budget, webhook route limit).
 */
export async function machineContentRefused(
  input: { principalId: string; serverId: string; channelId: string; displayName: string; content: string },
  io: HandlerServer | null,
): Promise<boolean> {
  const { principalId, serverId, channelId, displayName, content } = input;
  const decision = await evaluateAutomodRules(
    await Automod.findByServer(serverId),
    { serverId, userId: principalId, content, memberRoleIds: [] },
    (key, ttlSeconds) => cache.increment(key, ttlSeconds),
  );
  if (!decision.matched) return false;
  await writeAutomodLogs(decision, { serverId, channelId, userId: principalId, displayName, content }, io);
  return true;
}
