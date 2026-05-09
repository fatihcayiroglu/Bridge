// plugins/word-filter/index.js — Bridge Plugin Örneği
'use strict';

async function setup(ctx) {
  ctx.logger.log('Word Filter başlatıldı');

  const cfg      = ctx.meta.config || {};
  const blocked  = (cfg.blockedWords || []).map(w => w.toLowerCase());
  const warnUser = cfg.warnUser !== false;
  const logChan  = (cfg.logChannelName || 'mod-log').toLowerCase();

  if (!blocked.length) {
    ctx.logger.warn('blockedWords listesi boş — plugin pasif');
    return;
  }

  // Mesaj gönderilince içeriği kontrol et
  ctx.hooks.on('message:created', async ({ messageId, channelId, serverId, userId, content, displayName }) => {
    if (!content) return;
    const lower = content.toLowerCase();
    const hit   = blocked.find(w => lower.includes(w));
    if (!hit) return;

    ctx.logger.log(`Yasaklı kelime tespit edildi: "${hit}" — mesaj: ${messageId}`);

    // Mesajı sil
    ctx.hooks.emit('plugin:deleteMessage', { messageId, channelId, serverId });

    // Kullanıcıya uyarı
    if (warnUser) {
      ctx.hooks.emit('plugin:sendMessage', {
        channelId,
        serverId,
        content:  `⚠️ <@${userId}>, mesajın yasaklı içerik nedeniyle kaldırıldı.`,
        botName:  'Word Filter',
      });
    }

    // Mod log kanalına kayıt
    const channels  = await ctx.db.channels.find({ serverId, type: 'text' });
    const logChannel = channels.find(c => c.name?.toLowerCase() === logChan);
    if (logChannel) {
      ctx.hooks.emit('plugin:sendMessage', {
        channelId: logChannel._id,
        serverId,
        content:   `🛡️ **Word Filter** | Kullanıcı: ${displayName} | Kelime: \`${hit}\` | Kanal: <#${channelId}>`,
        botName:   'Word Filter',
      });
    }
  });

  // /api/plugins/word-filter/blocked — yasaklı kelime listesi
  ctx.registerRoute('GET', '/blocked', (req, res) => {
    res.json({ blockedWords: blocked });
  });
}

module.exports = { setup };
