// plugins/welcome-bot/index.ts — Bridge Plugin
// SPRINT65: .js → .ts geçişi
'use strict';

import type { PluginContext } from '../lifecycle';

interface WelcomeBotConfig {
  messageTemplate?: string;
  channelName?:     string;
}

interface MemberJoinedPayload {
  userId:      string;
  serverId:    string;
  displayName: string;
  username:    string;
}

interface Channel {
  _id:   string;
  name?: string;
}

export async function setup(ctx: PluginContext): Promise<void> {
  ctx.logger.log('Welcome Bot başlatıldı');

  const cfg        = (ctx.meta.config ?? {}) as WelcomeBotConfig;
  const template   = cfg.messageTemplate ?? '👋 Hoş geldin, {username}!';
  const chanTarget = (cfg.channelName ?? 'genel').toLowerCase();

  // Yeni üye katılınca hoş geldiniz mesajı gönder
  ctx.hooks.on('member:joined', async (raw) => {
    const { userId, serverId, displayName, username } = raw as MemberJoinedPayload;
    try {
      const db = ctx.db as { channels: { find: (q: Record<string, unknown>) => Promise<Channel[]> } };

      // Hedef kanalı bul
      const channels = await db.channels.find({ serverId, type: 'text' });
      const channel  = channels.find((c) => c.name?.toLowerCase() === chanTarget) ?? channels[0];
      if (!channel) return;

      const msg = template
        .replace('{username}',    displayName || username || 'kullanıcı')
        .replace('{userId}',      userId)
        .replace('{serverId}',    serverId)
        .replace('{channelName}', channel.name ?? '');

      ctx.hooks.emit('plugin:sendMessage', {
        channelId: channel._id,
        serverId,
        content:   msg,
        botName:   'Welcome Bot',
      });

      ctx.logger.log(`Hoş geldiniz mesajı gönderildi: ${displayName} → #${channel.name ?? ''}`);
    } catch (e) {
      ctx.logger.error('Mesaj gönderilemedi:', (e as Error).message);
    }
  });

  // /api/plugins/welcome-bot/config — mevcut config'i döndür
  ctx.registerRoute('GET', '/config', (_req, res) => {
    res.json({ config: cfg, status: 'active' });
  });
}
