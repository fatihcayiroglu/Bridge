// server/plugins/actions.ts
// Sprint 107→108: Plugin emit aksiyonlarını sunucu tarafında işler.
// plugin:sendMessage | plugin:deleteMessage | plugin:grantRole

import type { Server as IOServer } from 'socket.io';
import { Messages, Members } from '../db/repositories';
import { systemMsg } from '../socket/handlers/messages-types';
import { deleteMessageWithCascade } from '../lib/deleteMessageCascade';
import { cache } from '../lib/redisAdapter';
import logger from '../lib/logger';
interface HookBus {
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
}

interface PluginSendPayload {
  channelId: string;
  serverId:  string;
  content:   string;
  botName?:  string;
}

interface PluginDeletePayload {
  messageId: string;
  channelId: string;
  serverId:  string;
}

interface PluginGrantRolePayload {
  userId:   string;
  serverId: string;
  roleId:   string;
}

async function invalidateMessageCache(channelId: string): Promise<void> {
  try {
    await cache.del(`messages:${channelId}:first:50`);
    await cache.del(`messages:${channelId}:first:100`);
  } catch { /* non-fatal */ }
}

export function registerPluginActionHandlers(hooks: HookBus, io: IOServer): void {
  hooks.on('plugin:sendMessage', async (raw) => {
    const { channelId, serverId, content, botName } = raw as PluginSendPayload;
    if (!channelId || !serverId || !content?.trim()) return;

    try {
      const msg = {
        ...systemMsg(channelId, serverId, content.trim()),
        displayName: botName || '🤖 Plugin Bot',
        username:    'plugin-bot',
      };
      const saved = await Messages.create(msg);
      io.to(`channel:${channelId}`).emit('message:new', saved);
    } catch (err) {
      logger.error({ err: (err as Error).message, event: 'plugin.sendMessage' }, 'plugin:sendMessage failed');
    }
  });

  hooks.on('plugin:deleteMessage', async (raw) => {
    const { messageId, channelId, serverId } = raw as PluginDeletePayload;
    if (!messageId || !channelId) return;

    try {
      const msg = await Messages.findById(messageId);
      if (!msg) return;
      if (serverId && msg.serverId !== serverId) {
        logger.warn({ messageId, event: 'plugin.deleteMessage.denied' }, 'serverId mismatch');
        return;
      }
      const ok = await deleteMessageWithCascade(messageId, channelId, {
        _id: String(msg._id), channelId: String(msg.channelId),
        serverId: String(msg.serverId), threadId: msg.threadId as string | undefined,
      });
      if (!ok) return;
      io.to(`channel:${channelId}`).emit('message:deleted', { id: messageId });
      await invalidateMessageCache(channelId);
      logger.info({ messageId, channelId, event: 'plugin.deleteMessage' }, 'plugin deleted message');
    } catch (err) {
      logger.error({ err: (err as Error).message, event: 'plugin.deleteMessage' }, 'plugin:deleteMessage failed');
    }
  });

  hooks.on('plugin:grantRole', async (raw) => {
    const { userId, serverId, roleId } = raw as PluginGrantRolePayload;
    if (!userId || !serverId || !roleId) return;

    try {
      const member = await Members.findOne(userId, serverId);
      if (!member) return;

      let roles: string[] = [];
      try {
        roles = JSON.parse((member.roles as string) || '[]');
      } catch {
        roles = [];
      }
      if (roles.includes(roleId)) return;

      roles.push(roleId);
      await Members.setRoles(userId, serverId, roles);

      io.emit('role:granted', { serverId, roleId, userId, source: 'plugin' });
    } catch (err) {
      logger.error({ err: (err as Error).message, event: 'plugin.grantRole' }, 'plugin:grantRole failed');
    }
  });

  logger.info({ event: 'plugins.actions.registered' }, 'Plugin action handlers registered');
}
