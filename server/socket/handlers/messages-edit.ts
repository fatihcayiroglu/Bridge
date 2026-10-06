// server/socket/handlers/messages-edit.ts
// Mesaj düzenleme, silme, pin ve reaksiyon işlemleri.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { canManageRole, canViewChannel } from '../../lib/permissions';
import { Messages, Members, ReactionRoles, Roles } from '../../db/repositories';
import { hasPermission, PERMS, resolvePermissions } from '../../routes/roles';
import { getCachedPerms, invalidatePerms } from '../../lib/permCache';
import { invalidateChannelMessages } from '../../lib/messageCache';
import logger from '../../lib/logger';
// Edit and delete rules live in ONE place, shared with the HTTP routes (Final21 Phase 16).
import { deleteChannelMessage, editChannelMessage } from '../../lib/messageMutations';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import type { AuthUser, SocketUser } from './messages-types';
import { isolateSocketHandler } from '../handlerIsolation';

export function registerEditHandlers(
  socket: HandlerSocket,
  io: HandlerServer,
  user: AuthUser,
  _socketUsers: Map<string, SocketUser>,
): void {

  // ── message:pin ───────────────────────────────────────────
  socket.on('message:pin', isolateSocketHandler(socket, 'message:pin', async ({ messageId, channelId, serverId, pinned: desiredPinned }: {
    messageId: string; channelId: string; serverId: string; pinned?: boolean;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, serverId, pinned: desiredPinned }, socketSchemas.pinMessage).valid) return;
    const msg = await Messages.findById(messageId);
    if (!msg) return;
    // Güvenlik: mesajın istekte belirtilen kanal ve sunucuya ait olduğunu doğrula.
    // Bu kontrol olmadan saldırgan, MANAGE_MESSAGES yetkisi olmayan başka bir
    // sunucunun mesajını kendi sunucusundan pin/unpin yapabilirdi.
    if (msg.channelId !== channelId || msg.serverId !== serverId) return;
    const perms = await getCachedPerms(user._id, serverId, resolvePermissions, channelId);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_MESSAGES)) return;
    const pinned = typeof desiredPinned === 'boolean' ? desiredPinned : !msg.pinned;
    if (Boolean(msg.pinned) !== pinned) await Messages.update(messageId, { pinned });
    await invalidateChannelMessages(String(channelId));
    io.to(`channel:${channelId}`).emit('message:pinned', { messageId, pinned });
  }));

  // ── message:delete ─────────────────────────────────────────
  socket.on('message:delete', isolateSocketHandler(socket, 'message:delete', async ({ messageId, channelId, clientNonce }: {
    messageId: string; channelId: string; clientNonce?: string;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, clientNonce }, socketSchemas.deleteMessage).valid) return;
    // Single owner shared with HTTP DELETE (Final21 Phase 16): visibility, author/MANAGE_MESSAGES,
    // cascade soft delete, cache invalidation BEFORE the announcement.
    const result = await deleteChannelMessage(io, { actorId: user._id, messageId, channelId, clientNonce });
    if (!result.ok && clientNonce) {
      socket.emit('error:message', {
        event: 'message:delete',
        code: 'MUTATION_REJECTED',
        clientNonce,
      });
    }
  }));

  // ── message:edit ──────────────────────────────────────────
  socket.on('message:edit', isolateSocketHandler(socket, 'message:edit', async ({ messageId, channelId, content, clientNonce, baseVersion }: {
    messageId: string; channelId: string; content: string; clientNonce?: string; baseVersion?: number;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, content, clientNonce, baseVersion }, socketSchemas.editMessage).valid) return;
    // Single owner shared with HTTP PATCH (Final21 Phase 16). The HTTP copy had drifted and
    // skipped AutoMod entirely (measured: a refused word was stored through PATCH).
    const result = await editChannelMessage(io, {
      actorId: user._id, messageId, channelId, content, clientNonce, baseVersion,
    });
    if (result.ok) return;
    if (!clientNonce) return;

    // The client needs a deterministic terminal result for durable P7
    // operations. Preserve useful, authorized conflict/moderation codes; group
    // existence/permission refusals into one bounded code to avoid turning the
    // socket into a message-existence oracle.
    const publicCode = result.code === 'AUTOMOD_BLOCKED'
      || result.code === 'AUTOMOD_UNAVAILABLE'
      || result.code === 'CONFLICT'
      ? result.code
      : 'MUTATION_REJECTED';
    socket.emit('error:message', {
      event: 'message:edit',
      code: publicCode,
      ...(result.reason ? { message: result.reason } : {}),
      clientNonce,
    });
  }));

  // ── message:react ─────────────────────────────────────────
  socket.on('message:react', isolateSocketHandler(socket, 'message:react', async ({ messageId, channelId, emoji, active: desiredActive }: {
    messageId: string; channelId: string; emoji: string; active?: boolean;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, emoji, active: desiredActive }, socketSchemas.reactMessage).valid) return;
    if (!emoji || typeof emoji !== 'string' || emoji.length > 10) return;
    const msg = await Messages.findById(messageId);
    if (!msg || String(msg.channelId) !== channelId) return;
    const membership = await Members.findOne(user._id, msg.serverId);
    if (!membership) return;
    // SUNUCU UYELIGI KANAL GORUNURLUGU DEGILDIR (ayni kusur ailesi: pins/files,
    // search, ai/semantic). Goremedigi bir kanaldaki mesaja tepki verilemez.
    if (!(await canViewChannel(user._id, String(msg.serverId), String(msg.channelId)))) return;
    const reactionPerms = await resolvePermissions(user._id, String(msg.serverId), String(msg.channelId));
    if (!hasPermission(reactionPerms, PERMS.ADD_REACTIONS)) return;

    const before: Record<string, string[]> = typeof msg.reactions === 'string'
      ? (() => { try { return JSON.parse(msg.reactions) as Record<string, string[]>; } catch { return {}; } })()
      : (msg.reactions as Record<string, string[]> | undefined) ?? {};
    const wasPresent = (before[emoji] ?? []).includes(user._id);
    const targetActive = typeof desiredActive === 'boolean' ? desiredActive : !wasPresent;
    const atomic = typeof desiredActive === 'boolean'
      ? await Messages.setReactionStateAtomic(messageId, emoji, user._id, targetActive)
      : await Messages.toggleReactionAtomic(messageId, emoji, user._id);
    if (atomic === false) return;
    let reactions: Record<string, string[]>;
    if (atomic === null) {
      // Test/in-memory adapter fallback. Desired-state requests are idempotent:
      // if the current state already matches, no write or reaction-role side effect occurs.
      if (targetActive === wasPresent) {
        reactions = structuredClone(before);
      } else {
        if (targetActive && !before[emoji] && Object.keys(before).length >= 20) return;
        reactions = structuredClone(before);
        const users = reactions[emoji] ?? [];
        if (!targetActive) {
          const filtered = users.filter(id => id !== user._id);
          if (filtered.length) reactions[emoji] = filtered; else delete reactions[emoji];
        } else {
          reactions[emoji] = [...users, user._id];
        }
        await Messages.update(messageId, { reactions });
      }
    } else {
      reactions = atomic;
    }
    const added = (reactions[emoji] ?? []).includes(user._id);
    await invalidateChannelMessages(String(msg.channelId));
    io.to(`channel:${String(msg.channelId)}`).emit('message:reaction', { messageId, reactions });

    // Reaction Role
    try {
      const rules = await ReactionRoles.findByMessageAndEmoji(messageId, emoji);
      for (const rule of rules) {
        // Legacy/corrupt rules cannot cross tenant/channel/message boundaries.
        if (String(rule.serverId) !== String(msg.serverId) ||
            String(rule.channelId) !== String(msg.channelId) ||
            String(rule.messageId) !== messageId) continue;
        const [member, role] = await Promise.all([
          Members.findOne(user._id, rule.serverId),
          Roles.findByIdAndServer(rule.roleId, rule.serverId),
        ]);
        if (!member || !role) continue;

        // Re-validate the authority that created the rule at execution time.
        // A stale/corrupt legacy row (missing creator) or a moderator who was
        // later demoted must not keep granting a role above their hierarchy.
        const createdBy = String(rule.createdBy ?? '');
        if (!createdBy || !await canManageRole(createdBy, String(rule.roleId), String(rule.serverId))) continue;

        let roles = JSON.parse(typeof member.roles === 'string' ? member.roles : JSON.stringify(member.roles ?? []));
        if (added) {
          if (!roles.includes(rule.roleId)) {
            roles.push(rule.roleId);
            await Members.setRoles(user._id, rule.serverId, roles);
            invalidatePerms(rule.serverId, user._id);
            io.to(`user:${user._id}`).emit('role:granted', {
              serverId: rule.serverId, roleId: rule.roleId, emoji,
            });
          }
        } else if (roles.includes(rule.roleId)) {
          roles = roles.filter((r: string) => r !== rule.roleId);
          await Members.setRoles(user._id, rule.serverId, roles);
          invalidatePerms(rule.serverId, user._id);
          io.to(`user:${user._id}`).emit('role:revoked', {
            serverId: rule.serverId, roleId: rule.roleId, emoji,
          });
        }
      }
    } catch (err) { logger.warn('[ReactionRole]', (err as Error).message); }
  }));
}
