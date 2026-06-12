// server/socket/handlers/messages-edit.ts
// Mesaj düzenleme, silme, pin ve reaksiyon işlemleri.
// Sprint 107: messages.ts (505 satır) modüler yapıya ayrıldı.

import { Messages, Members, ReactionRoles } from '../../db/repositories';
import { hasPermission, PERMS, resolvePermissions } from '../../routes/roles';
import { getCachedPerms } from '../../lib/permCache';
import { cache } from '../../lib/redisAdapter';
import logger from '../../lib/logger';
import { deleteMessageWithCascade } from '../../lib/deleteMessageCascade';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
// Sprint 120: T5 — Düzenlenen mesajlarda da server-side sanitization
import { sanitizeMessageContent } from '../../lib/contentSanitizer';
import type { AuthUser, SocketUser } from './messages-types';
import type { Server as IOServer, Socket } from 'socket.io';

// ── Cache invalidation yardımcısı ─────────────────────────────
async function invalidateMessageCache(channelId: string): Promise<void> {
  try {
    await cache.del(`messages:${channelId}:first:50`);
    await cache.del(`messages:${channelId}:first:100`);
  } catch { /* non-fatal: Redis down olsa da mesaj işlemi tamamlanmış sayılır */ }
}

export function registerEditHandlers(
  socket: Socket,
  io: IOServer,
  user: AuthUser,
  socketUsers: Map<string, SocketUser>,
): void {

  // ── message:pin ───────────────────────────────────────────
  socket.on('message:pin', async ({ messageId, channelId, serverId }: {
    messageId: string; channelId: string; serverId: string;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, serverId }, socketSchemas.pinMessage).valid) return;
    const msg = await Messages.findById(messageId);
    if (!msg) return;
    // Güvenlik: mesajın istekte belirtilen kanal ve sunucuya ait olduğunu doğrula.
    // Bu kontrol olmadan saldırgan, MANAGE_MESSAGES yetkisi olmayan başka bir
    // sunucunun mesajını kendi sunucusundan pin/unpin yapabilirdi.
    if (msg.channelId !== channelId || msg.serverId !== serverId) return;
    const perms = await getCachedPerms(user._id, serverId, resolvePermissions);
    if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return;
    const pinned = !msg.pinned;
    await Messages.update(messageId, { pinned });
    io.to(`channel:${channelId}`).emit('message:pinned', { messageId, pinned });
  });

  // ── message:delete ─────────────────────────────────────────
  socket.on('message:delete', async ({ messageId, channelId }: {
    messageId: string; channelId: string;
  }) => {
    if (!validateSocketPayload({ messageId, channelId }, socketSchemas.deleteMessage).valid) return;
    const msg = await Messages.findById(messageId);
    if (!msg) return;

    const perms = await getCachedPerms(user._id, msg.serverId, resolvePermissions);
    const canDelete = msg.userId === user._id || hasPermission(perms, PERMS.MANAGE_MESSAGES);
    if (!canDelete) return;

    const deleted = await deleteMessageWithCascade(messageId, channelId, {
      _id: msg._id, channelId: msg.channelId, serverId: msg.serverId ?? '', threadId: msg.threadId ?? undefined,
    });
    if (!deleted) return;

    io.to(`channel:${channelId}`).emit('message:deleted', { id: messageId });
    await invalidateMessageCache(channelId);
  });

  // ── message:edit ──────────────────────────────────────────
  socket.on('message:edit', async ({ messageId, channelId, content }: {
    messageId: string; channelId: string; content: string;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, content }, socketSchemas.editMessage).valid) return;
    if (!content?.trim() || content.length > 2000) return;
    const msg = await Messages.findById(messageId);
    if (!msg || msg.userId !== user._id) return;

    const history = Array.isArray(msg.editHistory) ? msg.editHistory : [];
    history.push({ content: msg.content, editedAt: msg.editedAt || msg.createdAt });
    const trimmedHistory = history.slice(-10);

    await Messages.update(messageId, { content: sanitizeMessageContent(content.trim()), editedAt: Date.now(), editHistory: trimmedHistory });
    const updated = await Messages.findById(messageId);
    await invalidateMessageCache(channelId);
    io.to(`channel:${channelId}`).emit('message:edited', updated);
  });

  // ── message:react ─────────────────────────────────────────
  socket.on('message:react', async ({ messageId, channelId, emoji }: {
    messageId: string; channelId: string; emoji: string;
  }) => {
    if (!validateSocketPayload({ messageId, channelId, emoji }, socketSchemas.reactMessage).valid) return;
    if (!emoji || typeof emoji !== 'string' || emoji.length > 10) return;
    const msg = await Messages.findById(messageId);
    if (!msg) return;
    const membership = await Members.findOne(user._id, msg.serverId);
    if (!membership) return;

    const reactions: Record<string, string[]> = typeof msg.reactions === 'string' ? (() => { try { return JSON.parse(msg.reactions) as Record<string, string[]>; } catch { return {}; } })() : (msg.reactions as Record<string, string[]> | undefined) ?? {};
    const users     = reactions[emoji] || [];
    const idx       = users.indexOf(user._id);
    const added     = idx === -1;
    if (added) users.push(user._id); else users.splice(idx, 1);
    if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;
    await Messages.update(messageId, { reactions });
    io.to(`channel:${channelId}`).emit('message:reaction', { messageId, reactions });

    // Reaction Role
    try {
      const rules = await ReactionRoles.findByMessageAndEmoji(messageId, emoji);
      for (const rule of rules) {
        const member = await Members.findOne(user._id, rule.serverId);
        if (!member) continue;
        let roles = JSON.parse(typeof member.roles === 'string' ? member.roles : JSON.stringify(member.roles ?? []));
        if (added) {
          if (!roles.includes(rule.roleId)) {
            roles.push(rule.roleId);
            await Members.setRoles(user._id, rule.serverId, roles);
            for (const [sid, su] of socketUsers) {
              if ((su._id || su.id) === user._id) {
                io.to(sid).emit('role:granted', { serverId: rule.serverId, roleId: rule.roleId, emoji });
              }
            }
          }
        } else {
          roles = roles.filter((r: string) => r !== rule.roleId);
          await Members.setRoles(user._id, rule.serverId, roles);
          for (const [sid, su] of socketUsers) {
            if ((su._id || su.id) === user._id) {
              io.to(sid).emit('role:revoked', { serverId: rule.serverId, roleId: rule.roleId, emoji });
            }
          }
        }
      }
    } catch (err) { logger.warn('[ReactionRole]', (err as Error).message); }
  });
}
