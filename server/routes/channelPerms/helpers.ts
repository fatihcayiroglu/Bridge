// server/routes/channelPerms/helpers.js.1
// Shared yardımcılar: rate limiter'lar, audit log, log mesajı, socket emit
'use strict';

const rateLimit    = require('express-rate-limit');
const { Auth, Servers, Channels, Messages } = require('../../db/repositories');
const { v4: uuidv4 } = require('uuid');

// ── Rate Limiter'lar ────────────────────────────────────────────
const permReadLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
  keyGenerator:    (req) => req.user?.id || req.ip,
  skip:            (req) => !req.user,
});

const permWriteLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             30,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Çok fazla yazma isteği. Lütfen bir dakika bekleyin.' },
  keyGenerator:    (req) => req.user?.id || req.ip,
  skip:            (req) => !req.user,
});

// ── Socket yardımcıları ─────────────────────────────────────────
function getIo(req) {
  return req.app?.get('io') ?? null;
}

function emitPermsUpdated(req, serverId, channelId) {
  const io = getIo(req);
  if (!io) return;
  io.to(`server:${serverId}`).emit('permissions:updated', { serverId, channelId });
}

// ── Audit log ──────────────────────────────────────────────────
async function writePermAudit(serverId: any, actorId: any, channelId: any, roleId: any, action: any, oldVals: any, newVals: any, extra: Record<string,any> = {}) {
  try {
    await Auth.insertAuditLog({
      serverId,
      channelId,
      actorId,
      actorName:  extra.actorName || actorId,
      action,
      targetId:   roleId,
      targetName: extra.targetName || roleId || '',
      old:        oldVals ? JSON.stringify(oldVals) : null,
      new:        newVals ? JSON.stringify(newVals) : null,
      extra:      JSON.stringify(extra),
      detail:     '',
    });
  } catch { /* audit log hatası kritik değil */ }
}

// ── Log kanalı sistem mesajı ───────────────────────────────────
async function sendPermLogMessage(req, serverId, channelId, action, actorName, targetName, oldVals, newVals) {
  try {
    const server = await Servers.findById(serverId);
    const logChannelId = server?.logChannelId;
    if (!logChannelId) return;

    const channel = await Channels.findById(channelId);
    const channelName = channel?.name || channelId;

    const actionLabels = {
      PERM_UPDATE:    '✏️ İzin güncellendi',
      PERM_DELETE:    '🗑️ İzin kaldırıldı',
      PERM_BULK_SYNC: '🔁 Toplu senkronizasyon',
    };
    const actionLabel = actionLabels[action] || action;

    let changeSummary = '';
    if (action === 'PERM_UPDATE' && oldVals && newVals) {
      changeSummary = ` | allow: ${oldVals.allow}→${newVals.allow}, deny: ${oldVals.deny}→${newVals.deny}`;
    } else if (action === 'PERM_DELETE' && oldVals) {
      changeSummary = ` | önceki: allow=${oldVals.allow}, deny=${oldVals.deny}`;
    } else if (action === 'PERM_BULK_SYNC') {
      changeSummary = newVals?.overrideCount != null ? ` | ${newVals.overrideCount} override kopyalandı` : '';
    }

    const content = `${actionLabel} — **#${channelName}** kanalı | Hedef: **${targetName || '?'}** | Yapan: **${actorName}**${changeSummary}`;

    const msgId = uuidv4();
    await Messages.create({
      _id: msgId, channelId: logChannelId, serverId,
      userId: 'system', username: 'Bridge', displayName: 'Bridge',
      content, type: 'system', createdAt: Date.now(),
    });

    const io = getIo(req);
    if (io) {
      io.to(`channel:${logChannelId}`).emit('message:new', {
        _id: msgId, channelId: logChannelId, serverId,
        userId: 'system', username: 'Bridge', displayName: 'Bridge',
        content, type: 'system', createdAt: Date.now(),
      });
    }
  } catch { /* sistem mesajı hatası kritik değil */ }
}

module.exports = {
  permReadLimiter,
  permWriteLimiter,
  getIo,
  emitPermsUpdated,
  writePermAudit,
  sendPermLogMessage,
};
export {};
