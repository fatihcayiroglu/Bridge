// server/socket/handlers/super-reactions.ts
// Sprint 82: Super Reactions socket handler

import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import logger from '../../lib/logger';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { Messages, Reactions } from '../../db/repositories';
import type { Socket, Server as IOServer } from 'socket.io';

// ── Rate limit (per user) ─────────────────────────────────────────────────────

const _superReactCooldown = new Map<string, number>(); // `${userId}:${messageId}` → lastTimestamp
const COOLDOWN_MS = 5_000; // bir mesaja 5 saniyede bir super react

// ── Handler ───────────────────────────────────────────────────────────────────

export function registerSuperReactionHandlers(
  socket: Socket,
  io:     IOServer,
  userId: string,
): void {

  socket.on('super_reaction:add', async (payload: {
    messageId: string;
    channelId: string;
    emoji:     string;
  }) => {
    if (!validateSocketPayload(payload, socketSchemas.superReactionAdd).valid) return;
    try {
      const { messageId, channelId, emoji } = payload ?? {};
      if (!messageId || !channelId || !emoji) return;

      // Emoji doğrulama — basit unicode check
      if (typeof emoji !== 'string' || emoji.length > 8) {
        socket.emit('super_reaction:error', { message: 'Geçersiz emoji.' });
        return;
      }

      // Cooldown
      const cooldownKey = `${userId}:${messageId}`;
      const lastUsed    = _superReactCooldown.get(cooldownKey) ?? 0;
      if (Date.now() - lastUsed < COOLDOWN_MS) {
        socket.emit('super_reaction:error', { message: 'Çok hızlısınız. Biraz bekleyin.' });
        return;
      }

      // Mesaj var mı?
      const msg = await Messages.findById(messageId);
      if (!msg || msg.channelId !== channelId) {
        socket.emit('super_reaction:error', { message: 'Mesaj bulunamadı.' });
        return;
      }

      // İzin kontrolü
      const serverId = msg.serverId as string | undefined;
      if (serverId) {
        const perms = await resolvePermissions(userId, serverId, channelId);
        if (!hasPermission(perms, PERMS.ADD_REACTIONS)) {
          socket.emit('super_reaction:error', { message: 'Reaksiyon ekleme izniniz yok.' });
          return;
        }
      }

      // Cooldown güncelle
      _superReactCooldown.set(cooldownKey, Date.now());

      // Normal reaksiyon sayısını artır (reactions tablosunu yeniden kullan)
      let reaction = await Reactions.findOne({ messageId, emoji, type: 'super' });
      if (reaction) {
        reaction.count = (reaction.count ?? 1) + 1;
        await Reactions.update({ _id: reaction._id }, { $set: { count: reaction.count } });
      } else {
        reaction = await Reactions.create({
          messageId,
          channelId,
          emoji,
          type:  'super',
          count: 1,
        });
      }

      const broadcastData = {
        messageId,
        channelId,
        emoji,
        userId,
        count:      reaction.count ?? 1,
        burstColor: _getBurstColor(emoji),
      };

      // Kanaldaki herkese gönder
      io.to(`channel:${channelId}`).emit('super_reaction:received', broadcastData);

      logger.info(
        { event: 'super_reaction.added', messageId, emoji, userId, count: reaction.count },
        'Super reaction added',
      );
    } catch (err) {
      logger.error({ event: 'super_reaction.error', err }, 'super_reaction:add error');
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BURST_COLORS: Record<string, string> = {
  '❤️':  '#FF0000',
  '🔥':  '#FF4500',
  '⭐':  '#FFD700',
  '💯':  '#00C851',
  '🎉':  '#9B59B6',
  '👍':  '#3498DB',
  '😂':  '#FFD700',
  '😍':  '#FF69B4',
  '🚀':  '#4169E1',
  '💎':  '#00CED1',
};

function _getBurstColor(emoji: string): string {
  return BURST_COLORS[emoji] ?? '#2d9cdb';
}
