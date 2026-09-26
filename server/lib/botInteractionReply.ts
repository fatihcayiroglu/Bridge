// server/lib/botInteractionReply.ts
//
// The one action a bot may take: answering a slash command a user invoked
// (Final21 Phase 14).
//
// Before this, bots could receive invocations but not act — the Bot SDK marked
// sendMessage and every other action unsupported because no bot-principal
// authority existed. A general "post anywhere" authority would need channel
// visibility, role hierarchy and moderation policy for bots. Replying to an
// invocation needs none of that: the invoking user chose this bot, in this
// channel, moments ago. Every condition below is re-derived from server state;
// nothing the bot sends is trusted except the reply text.
//
// What the canonical user send path (socket/handlers/messages-send.ts) enforces, and
// what applies here — measured by tools/p14-reply-gaps-probe.mjs, which failed R1–R3
// before these were added:
//   · AutoMod rules: ENFORCED through the same evaluator. A bot has no member roles, so
//     role exemptions never apply, and a bot cannot be timed out — any match refuses the
//     reply (fail closed), and rule-lookup failure propagates as an error.
//   · Volume: a bot is not subject to per-user slowmode, but one invocation allows at most
//     INTERACTION_REPLY_LIMIT replies (atomic shared counter).
//   · History cache: invalidated exactly like a user message, or a reload hides the reply.
//   · Deliberately NOT done: mention notifications, outgoing webhooks, plugin hooks and
//     cross-server bridge forwarding. A bot reply cannot ping, fan out or loop.

import { v4 as uuidv4 } from 'uuid';
import { normalizeMessageText, RAW_TEXT_FORMAT } from './storedText';
import { Automod, Bots, Channels, Messages } from '../db/repositories';
import { evaluateAutomodRules } from './automodPolicy';
import { writeAutomodLogs } from './automodRuntime';
import { invalidateChannelMessages } from './messageCache';
import { cache } from './redisAdapter';
import type { HandlerServer } from '../socket/handler-contracts';
import { hasPermission, PERMS, resolvePermissions } from './permissions';
import { readPersistedCommandArray } from './botCommands';
import { readGrantedBotScopes, type BotScope } from './botScopes';

/** How long after the invocation a bot may still answer it. */
export const INTERACTION_REPLY_WINDOW_MS = 15 * 60_000;
export const INTERACTION_REPLY_MAX_LENGTH = 2000;
/** Replies one invocation may receive (e.g. an acknowledgement, progress, and a result). */
export const INTERACTION_REPLY_LIMIT = 5;

export interface ReplyingBot {
  _id: string;
  serverId: string;
  username: string;
  avatarUrl?: string | null;
  slashCommands?: unknown;
}

export type InteractionReplyResult =
  | { ok: true; message: Record<string, unknown> }
  | { ok: false; status: 400 | 403 | 404 | 429; error: string };

function invokedCommandName(content: unknown): string | null {
  if (typeof content !== 'string' || !content.startsWith('/')) return null;
  const name = content.trim().slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return /^[a-z0-9_-]{1,32}$/.test(name) ? name : null;
}

/** Scopes this bot holds in a server: all of them at home, the consented grant elsewhere. */
export async function botScopesInServer(bot: ReplyingBot, serverId: string): Promise<readonly BotScope[] | null> {
  if (String(bot.serverId) === serverId) return ['commands', 'messages:reply'];
  const link = await Bots.findServerBot(bot._id, serverId) as { grantedScopes?: unknown } | null;
  return link ? readGrantedBotScopes(link.grantedScopes) : null;
}

export async function replyToInvocation(
  bot: ReplyingBot,
  invocationMessageId: string,
  rawContent: unknown,
  now = Date.now(),
  io: HandlerServer | null = null,
): Promise<InteractionReplyResult> {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return { ok: false, status: 400, error: 'content required' };
  if (rawContent.length > INTERACTION_REPLY_MAX_LENGTH) return { ok: false, status: 400, error: 'content too long' };

  const invocation = await Messages.findById(invocationMessageId) as {
    _id: string; channelId?: string; serverId?: string; userId?: string; content?: unknown;
    displayName?: string; createdAt?: number; deletedAt?: number | null; contentFormat?: unknown;
  } | null;
  if (!invocation || invocation.deletedAt) return { ok: false, status: 404, error: 'Invocation not found' };
  const serverId = String(invocation.serverId ?? '');
  const channelId = String(invocation.channelId ?? '');

  // It must be an invocation of THIS bot's command.
  const name = invokedCommandName(invocation.content);
  const owns = name !== null && readPersistedCommandArray(bot.slashCommands)
    .some((command) => String((command as { name?: unknown }).name ?? '').toLowerCase() === name);
  if (!owns) return { ok: false, status: 403, error: 'not_invoked' };
  // PostgreSQL returns BIGINT as a string; `Number.isFinite("…")` is false. The live
  // probe caught this: every fresh invocation was refused as expired.
  const invokedAt = Number(invocation.createdAt);
  if (!Number.isFinite(invokedAt) || now - invokedAt > INTERACTION_REPLY_WINDOW_MS) {
    return { ok: false, status: 403, error: 'interaction_expired' };
  }

  // The bot must still be installed there, with the reply scope.
  const scopes = await botScopesInServer(bot, serverId);
  if (!scopes) return { ok: false, status: 403, error: 'not_installed' };
  if (!scopes.includes('messages:reply')) return { ok: false, status: 403, error: 'scope_required' };

  // The invoker must have been entitled to invoke bots in that channel — the same
  // rule that decides whether the invocation was delivered at all.
  const invokerPerms = await resolvePermissions(String(invocation.userId ?? ''), serverId, channelId).catch(() => 0);
  if (!hasPermission(invokerPerms, PERMS.USE_BOT_COMMANDS)) return { ok: false, status: 403, error: 'not_invoked' };

  const channel = await Channels.findById(channelId) as { _id: string; serverId?: string } | null;
  if (!channel || String(channel.serverId) !== serverId) return { ok: false, status: 404, error: 'Channel not found' };

  const botUserId = `bot:${bot._id}`;
  const increment = (key: string, ttlSeconds: number) => cache.increment(key, ttlSeconds);
  const decision = await evaluateAutomodRules(
    await Automod.findByServer(serverId),
    { serverId, userId: botUserId, content: rawContent, memberRoleIds: [] },
    increment,
  );
  if (decision.matched) {
    if (io) {
      await writeAutomodLogs(decision, { serverId, channelId, userId: botUserId, displayName: bot.username, content: rawContent }, io);
    }
    return { ok: false, status: 403, error: 'automod_blocked' };
  }

  // Counted last, so refused attempts do not use up the invocation's replies.
  const replies = await increment(`bot-interaction-replies:${bot._id}:${invocation._id}`, Math.ceil(INTERACTION_REPLY_WINDOW_MS / 1000));
  if (replies > INTERACTION_REPLY_LIMIT) return { ok: false, status: 429, error: 'reply_limit' };

  const message = await Messages.create({
    _id: uuidv4(),
    channelId,
    serverId,
    userId: botUserId,
    botId: bot._id,
    username: bot.username,
    displayName: bot.username,
    avatarColor: '#2d9cdb',
    avatarUrl: bot.avatarUrl ?? null,
    content: normalizeMessageText(rawContent),
    contentFormat: RAW_TEXT_FORMAT,
    type: 'normal',
    reactions: {},
    replyTo: {
      _id: invocation._id,
      displayName: invocation.displayName,
      content: typeof invocation.content === 'string' ? invocation.content.slice(0, 100) : '',
      contentFormat: invocation.contentFormat === RAW_TEXT_FORMAT ? RAW_TEXT_FORMAT : 0,
    },
    createdAt: now,
  });
  await invalidateChannelMessages(channelId);
  return { ok: true, message: message as unknown as Record<string, unknown> };
}
