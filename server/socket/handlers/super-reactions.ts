// server/socket/handlers/super-reactions.ts
// Sprint 82: Super Reactions socket handler

import type { HandlerSocket, HandlerServer } from '../handler-contracts';
import { validateSocketPayload, socketSchemas } from '../../middleware/validate';
import logger from '../../lib/logger';
import { resolvePermissions, hasPermission, PERMS } from '../../lib/permissions';
import { Messages } from '../../db/repositories';
import { isolateSocketHandler } from '../handlerIsolation';
import { cache, isRedisAvailable } from '../../lib/redisAdapter';


// ── Rate limit (per user) ─────────────────────────────────────────────────────

const _superReactCooldown = new Map<string, number>(); // `${userId}:${messageId}` → lastTimestamp
const COOLDOWN_MS = 5_000; // bir mesaja 5 saniyede bir super react
const COOLDOWN_CACHE_MAX = 100_000;

function pruneSuperReactionCooldown(now = Date.now()): void {
  for (const [key, usedAt] of _superReactCooldown) {
    if (now - usedAt >= COOLDOWN_MS) _superReactCooldown.delete(key);
  }
  while (_superReactCooldown.size >= COOLDOWN_CACHE_MAX) {
    const oldest = _superReactCooldown.keys().next().value as string | undefined;
    if (!oldest) break;
    _superReactCooldown.delete(oldest);
  }
}

setInterval(pruneSuperReactionCooldown, 30_000).unref();

// ── Handler ───────────────────────────────────────────────────────────────────

export function registerSuperReactionHandlers(
  socket: HandlerSocket,
  io:     HandlerServer,
  userId: string,
): void {

  socket.on('super_reaction:add', isolateSocketHandler(socket, 'super_reaction:add', async (payload: {
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

      // Cooldown — Redis claim is atomic across Socket.IO nodes. When Redis
      // is configured for a cluster, losing that authority must not silently
      // multiply the quota by the number of workers.
      const cooldownKey = `super-reaction:${userId}:${messageId}`;
      let remainingMs: number;
      if (process.env.REDIS_URL && !isRedisAvailable()) {
        throw new Error('Redis super-reaction cooldown coordination unavailable');
      }
      if (typeof cache.claimCooldown === 'function') {
        remainingMs = await cache.claimCooldown(cooldownKey, COOLDOWN_MS, COOLDOWN_MS + 5_000);
      } else {
        const lastUsed = _superReactCooldown.get(cooldownKey) ?? 0;
        remainingMs = Math.max(0, COOLDOWN_MS - (Date.now() - lastUsed));
      }
      if (remainingMs > 0) {
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
      if (!serverId) {
        socket.emit('super_reaction:error', { message: 'Mesaj bulunamadı.' });
        return;
      }
      const perms = await resolvePermissions(userId, serverId, channelId);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.ADD_REACTIONS)) {
        socket.emit('super_reaction:error', { message: 'Reaksiyon ekleme izniniz yok.' });
        return;
      }

      // Compatibility-only single-process fallback for legacy adapters.
      if (typeof cache.claimCooldown !== 'function') {
        if (_superReactCooldown.size >= COOLDOWN_CACHE_MAX) pruneSuperReactionCooldown();
        _superReactCooldown.set(cooldownKey, Date.now());
      }

      // Persist on the canonical message aggregate. This is a single-statement
      // PostgreSQL increment, so concurrent bursts cannot lose counts.
      const count = await Messages.incrementSuperReactionAtomic(messageId, emoji);
      if (count === null) {
        socket.emit('super_reaction:error', { message: 'Mesaj bulunamadı.' });
        return;
      }

      const broadcastData = {
        messageId,
        channelId,
        emoji,
        userId,
        count,
        burstColor: _getBurstColor(emoji),
      };

      // Kanaldaki herkese gönder
      io.to(`channel:${channelId}`).emit('super_reaction:received', broadcastData);

      logger.info(
        { event: 'super_reaction.added', messageId, emoji, userId, count },
        'Super reaction added',
      );
    } catch (err) {
      logger.error({ event: 'super_reaction.error', err }, 'super_reaction:add error');
    }
  }));
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
