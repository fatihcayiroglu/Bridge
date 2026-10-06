// server/lib/messageMutations.ts
//
// ONE owner for editing and deleting a channel message (Final21 Phase 16).
//
// ════════════════════════════════════════════════════════════════════════════
// MEASURED — TWO SURFACES, TWO SETS OF RULES
// ════════════════════════════════════════════════════════════════════════════
// The socket handlers (socket/handlers/messages-edit.ts) and the HTTP routes
// (PATCH / DELETE /api/channels/:messageId in routes/messages.ts) each carried their own copy
// of "edit a message" and "delete a message", and the HTTP copies had drifted
// (`p16-http-mutation-probe`, real server, two accounts, baseline 1/4):
//   · HTTP edit skipped AutoMod: a word the socket edit refused (AUTOMOD_BLOCKED) was stored
//     through PATCH with 200 — a moderation bypass open to any author with a token.
//   · HTTP edit and delete never invalidated the first-page cache and never broadcast: other
//     members did not see the change, and a fresh read still served the old text / the
//     deleted message.
//   · HTTP delete used a different deletion (no thread/unread cascade).
// Both surfaces now call these functions; they differ only in how they report a refusal.

import { Automod, Members, Messages, Users } from '../db/repositories';
import { evaluateAutomodRules } from './automodPolicy';
import { normalizeAutomodMemberRoleIds, writeAutomodLogs } from './automodRuntime';
import { deleteMessageWithCascade } from './deleteMessageCascade';
import logger from './logger';
import { invalidateChannelMessages } from './messageCache';
import { canViewChannel, hasPermission, PERMS, resolvePermissions } from './permissions';
import { cache } from './redisAdapter';
import { normalizeMessageText, RAW_TEXT_FORMAT, storedMessageText } from './storedText';
import type { HandlerServer } from '../socket/handler-contracts';

/** Same bound the socket edit has always enforced. */
export const MAX_EDIT_LENGTH = 2000;

export type MutationFailureCode =
  | 'INVALID'              // empty / too long / wrong message type
  | 'NOT_FOUND'            // no such message, or not in the stated channel
  | 'NOT_VISIBLE'          // not a member, or cannot view the channel
  | 'FORBIDDEN'            // visible, but not allowed to change THIS message
  | 'AUTOMOD_BLOCKED'
  | 'AUTOMOD_UNAVAILABLE'  // rules could not be evaluated: fail closed
  | 'CONFLICT'             // a newer authoritative edit exists
  | 'FAILED';              // storage refused the change

export type MutationResult =
  | { ok: true; message: Record<string, unknown> | null }
  | { ok: false; code: MutationFailureCode; reason?: string };

interface EditInput {
  actorId: string;
  messageId: string;
  /** When given, the message must belong to this channel (socket payloads name it). */
  channelId?: string;
  content: unknown;
  clientNonce?: string;
  /**
   * Version the editor originally saw: editedAt when present, otherwise
   * createdAt. Offline/retried edits use this to avoid overwriting a newer
   * authoritative server edit.
   */
  baseVersion?: number;
  /** HTTP has always refused edits of non-`normal` messages; the socket never did. */
  requireNormalType?: boolean;
}

interface DeleteInput {
  actorId: string;
  messageId: string;
  channelId?: string;
  clientNonce?: string;
}

type StoredMessage = NonNullable<Awaited<ReturnType<typeof Messages.findById>>>;

async function loadVisible(actorId: string, messageId: string, channelId: string | undefined): Promise<
  { ok: true; msg: StoredMessage; membership: Record<string, unknown> } | { ok: false; code: MutationFailureCode }
> {
  const msg = await Messages.findById(messageId);
  if (!msg || (channelId !== undefined && String(msg.channelId) !== channelId)) return { ok: false, code: 'NOT_FOUND' };
  const membership = await Members.findOne(actorId, msg.serverId);
  if (!membership || !(await canViewChannel(actorId, String(msg.serverId), String(msg.channelId)))) {
    return { ok: false, code: 'NOT_VISIBLE' };
  }
  return { ok: true, msg, membership: membership as unknown as Record<string, unknown> };
}

export async function editChannelMessage(io: HandlerServer | null | undefined, input: EditInput): Promise<MutationResult> {
  const raw = typeof input.content === 'string' ? input.content : '';
  if (!raw.trim() || raw.length > MAX_EDIT_LENGTH) return { ok: false, code: 'INVALID' };

  const loaded = await loadVisible(input.actorId, input.messageId, input.channelId);
  if (!loaded.ok) return loaded;
  const { msg, membership } = loaded;
  if (msg.userId !== input.actorId) return { ok: false, code: 'FORBIDDEN' };
  if (msg.deletedAt) return { ok: false, code: 'NOT_FOUND' };
  if (input.requireNormalType && msg.type !== undefined && msg.type !== 'normal') return { ok: false, code: 'INVALID', reason: 'type' };

  const desiredContent = normalizeMessageText(raw.trim());
  const currentContent = storedMessageText(msg);
  const currentVersion = Number(msg.editedAt ?? msg.createdAt ?? 0);

  // Lost confirmation / reconnect replay: if the authoritative row already has
  // the desired content, the mutation is satisfied. Do not append editHistory
  // again and do not re-run policy side effects; just repeat confirmation.
  if (currentContent === desiredContent) {
    const channelId = String(msg.channelId);
    io?.to(`channel:${channelId}`).emit('message:edited', { ...msg, clientNonce: input.clientNonce });
    return { ok: true, message: msg as unknown as Record<string, unknown> };
  }

  if (
    input.baseVersion !== undefined
    && (!Number.isFinite(input.baseVersion) || input.baseVersion < 0 || input.baseVersion !== currentVersion)
  ) {
    return { ok: false, code: 'CONFLICT' };
  }

  // Persisted AutoMod protects edits too; otherwise a benign send can be edited into content
  // that would have been refused. Spam-frequency rules count new sends only.
  try {
    const decision = await evaluateAutomodRules(
      await Automod.findByServer(String(msg.serverId)),
      {
        serverId: String(msg.serverId),
        userId: input.actorId,
        content: raw,
        memberRoleIds: normalizeAutomodMemberRoleIds(membership.roles),
        event: 'edit',
      },
      (key, ttlSeconds) => cache.increment(key, ttlSeconds),
    );
    if (decision.matched) {
      if (decision.timeoutMs) {
        // Durable policy state: if it cannot be written, fail closed and change nothing.
        await Members.setTimeout(String(msg.serverId), input.actorId, Date.now() + decision.timeoutMs);
      }
      const actor = await Users.findById(input.actorId).catch(() => null);
      await writeAutomodLogs(
        decision,
        {
          serverId: String(msg.serverId),
          channelId: String(msg.channelId),
          userId: input.actorId,
          displayName: String(membership.nickname || actor?.displayName || actor?.username || input.actorId),
          content: raw,
          operation: 'edit',
        },
        io as HandlerServer,
      );
      // The pre-edit text was accepted; "delete" means refuse the triggering edit.
      if (decision.deleteMessage) {
        return { ok: false, code: 'AUTOMOD_BLOCKED', reason: decision.reasons.join(', ') || undefined };
      }
    }
  } catch (err) {
    logger.warn({ event: 'automod.edit.failed', serverId: msg.serverId, messageId: input.messageId, err },
      '[automod] message edit enforcement failed');
    return { ok: false, code: 'AUTOMOD_UNAVAILABLE' };
  }

  const history = Array.isArray(msg.editHistory) ? [...msg.editHistory] : [];
  // Each version keeps the format it was stored in (legacy decodes, raw does not).
  history.push({ content: msg.content ?? '', editedAt: msg.editedAt || msg.createdAt, contentFormat: msg.contentFormat ?? 0 });
  await Messages.update(input.messageId, {
    content: desiredContent,
    contentFormat: RAW_TEXT_FORMAT,
    editedAt: Date.now(),
    editHistory: history.slice(-10),
  });
  const updated = await Messages.findById(input.messageId);
  const channelId = String(msg.channelId);
  // Invalidate BEFORE announcing: a client that refetches on the event must not get the old page.
  await invalidateChannelMessages(channelId);
  io?.to(`channel:${channelId}`).emit('message:edited', { ...updated, clientNonce: input.clientNonce });
  return { ok: true, message: updated as unknown as Record<string, unknown> | null };
}

export async function deleteChannelMessage(io: HandlerServer | null | undefined, input: DeleteInput): Promise<MutationResult> {
  const loaded = await loadVisible(input.actorId, input.messageId, input.channelId);
  if (!loaded.ok) return loaded;
  const { msg } = loaded;
  const channelId = String(msg.channelId);

  const perms = await resolvePermissions(input.actorId, String(msg.serverId), channelId).catch(() => 0);
  if (msg.userId !== input.actorId && !hasPermission(perms, PERMS.MANAGE_MESSAGES)) return { ok: false, code: 'FORBIDDEN' };

  // Delete is desired-state idempotent. A retry after a lost confirmation does
  // not run the destructive cascade again; current authorization is still
  // checked above so a revoked user cannot use stale local state as an oracle.
  if (msg.deletedAt) {
    io?.to(`channel:${channelId}`).emit('message:deleted', {
      id: input.messageId,
      clientNonce: input.clientNonce,
    });
    return { ok: true, message: null };
  }

  const deleted = await deleteMessageWithCascade(input.messageId, channelId, {
    _id: msg._id, channelId: msg.channelId, serverId: msg.serverId ?? '', threadId: msg.threadId ?? undefined,
  }, input.actorId);
  if (!deleted) return { ok: false, code: 'FAILED' };

  await invalidateChannelMessages(channelId);
  io?.to(`channel:${channelId}`).emit('message:deleted', { id: input.messageId, clientNonce: input.clientNonce });
  return { ok: true, message: null };
}
