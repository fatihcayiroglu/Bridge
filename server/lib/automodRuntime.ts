import { v4 as uuidv4 } from 'uuid';
import { normalizeMessageText } from './storedText';
import { Channels, Messages } from '../db/repositories';
import { publishPersistedMessage } from './channelActivity';
import logger from './logger';
import type { AutomodDecision } from './automodPolicy';
import type { HandlerServer } from '../socket/handler-contracts';

export function normalizeAutomodMemberRoleIds(value: unknown): string[] {
  let roles: unknown = value;
  if (typeof roles === 'string') {
    try { roles = JSON.parse(roles); } catch { return []; }
  }
  if (!Array.isArray(roles)) return [];
  return [...new Set(roles.filter((role): role is string => typeof role === 'string' && role.length > 0))];
}

export async function writeAutomodLogs(
  decision: AutomodDecision,
  context: {
    serverId: string;
    channelId: string;
    userId: string;
    displayName: string;
    content: string;
    operation?: 'send' | 'edit';
  },
  io: HandlerServer,
): Promise<void> {
  if (!decision.matched || decision.logChannelIds.length === 0) return;
  const preview = normalizeMessageText(context.content.slice(0, 200)).replace(/`/g, '\\`');
  const blockLabel = context.operation === 'edit' ? 'düzenleme engellendi' : 'mesaj engellendi';
  const action = [
    decision.deleteMessage ? blockLabel : null,
    decision.timeoutMs ? `timeout ${Math.ceil(decision.timeoutMs / 60_000)} dk` : null,
  ].filter(Boolean).join(' + ') || 'kural eşleşti';

  for (const logChannelId of decision.logChannelIds) {
    try {
      // Config creation validates tenant ownership, but re-check at use time: channels can move/delete/change type.
      const logChannel = await Channels.findByIdAndServer(logChannelId, context.serverId);
      if (!logChannel || !['text', 'announcement'].includes(String(logChannel.type || 'text'))) continue;
      const logMessage = await Messages.create({
        _id: uuidv4(),
        channelId: logChannelId,
        serverId: context.serverId,
        userId: 'system',
        username: 'AutoMod',
        displayName: 'AutoMod 🤖',
        avatarColor: '#ed4245',
        avatarUrl: null,
        content: [
          '🛡️ **AutoMod**',
          `👤 ${context.displayName} (${context.userId})`,
          `📍 Kanal: ${context.channelId}`,
          `⚙️ ${action}`,
          `📏 ${decision.reasons.join(', ')}`,
          `💬 \`${preview}\``,
        ].join('\n'),
        type: 'system',
        reactions: {},
        createdAt: Date.now(),
        autoModAlert: true,
      });
      await publishPersistedMessage(io, logMessage);
    } catch (err) {
      // Moderation decision already exists; audit delivery is best-effort and must not undo it.
      logger.warn({ event: 'automod.log.failed', serverId: context.serverId, logChannelId, err },
        '[automod] log mesajı yazılamadı');
    }
  }
}
