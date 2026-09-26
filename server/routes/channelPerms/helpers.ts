import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { Auth, Servers, Channels, Messages, Roles } from '../../db/repositories';
import { v4 as uuidv4 } from 'uuid';
import { publishPersistedMessage } from '../../lib/channelActivity';

// Shared helpers: permission rate limits, audit records and socket invalidation.
type RateLimitRequest = Request & { user?: { id?: string } };
const permissionRateLimitKey = (req: RateLimitRequest): string =>
  req.user?.id || ipKeyGenerator(req.ip || 'unknown');
const permReadLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' },
  keyGenerator:    permissionRateLimitKey,
  skip:            (req) => !req.user,
});

const permWriteLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             30,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Çok fazla yazma isteği. Lütfen bir dakika bekleyin.' },
  keyGenerator:    permissionRateLimitKey,
  skip:            (req) => !req.user,
});

// ── Socket yardımcıları ─────────────────────────────────────────
function getIo(req: Request): import('socket.io').Server | null {
  return (req.app?.get('io') as import('socket.io').Server | undefined) ?? null;
}

function emitPermsUpdated(req: Request, serverId: string, channelId: string): void {
  const io = getIo(req);
  if (!io) return;
  io.to(`server:${serverId}`).emit('permissions:updated', { serverId, channelId });
}

// ── Audit log ──────────────────────────────────────────────────
async function writePermAudit(serverId: string, actorId: string, channelId: string, roleId: string | null, action: string, oldVals: unknown, newVals: unknown, extra: Record<string, unknown> = {}) {
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
async function sendPermLogMessage(req: Request, serverId: string, channelId: string, action: string, actorName: string, targetName: string, oldVals: Record<string, unknown> | null, newVals: Record<string, unknown> | null): Promise<void> {
  try {
    const server = await Servers.findById(serverId);
    const logChannelId = server?.logChannelId;
    if (!logChannelId) return;

    const channel = await Channels.findById(channelId);
    const channelName = channel?.name || channelId;

    const actionLabels: Record<string, string> = {
      PERM_UPDATE:    '✏️ İzin güncellendi',
      PERM_DELETE:    '🗑️ İzin kaldırıldı',
      PERM_BULK_SYNC: '🔁 Toplu senkronizasyon',
      PERM_UNDO:      '↩️ İzin değişikliği geri alındı',
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

    const logMessage = await Messages.create({
      _id: uuidv4(), channelId: logChannelId, serverId,
      userId: 'system', username: 'Bridge', displayName: 'Bridge',
      content, type: 'system', createdAt: Date.now(),
    });
    // Broadcast the stored row (it used to re-build a copy with a second timestamp).
    await publishPersistedMessage(getIo(req), logMessage);
  } catch { /* sistem mesajı hatası kritik değil */ }
}


/**
 * GÜVENLİK — KİRACI (TENANT) DOĞRULAMASI.
 *
 * `overrides.ts` rotaları yetkiyi `resolvePermissions(user, sid)` ile
 * doğruluyor, ardından `{ channelId: cid, roleId }` üzerinde işlem yapıyordu —
 * ancak `cid`in `sid`e ait olduğunu ve `roleId`nin `sid`e ait olduğunu HİÇ
 * doğrulamıyordu.
 *
 * İSTİSMAR: kendi A sunucusunda MANAGE_CHANNELS yetkisi olan bir kullanıcı
 *   PUT /api/servers/<A>/channels/<B'nin kanalı>/permissions/<B'nin rolü>
 * çağırarak BAŞKA bir sunucunun kanalına override yazabiliyordu; satır
 * `serverId: A` ile damgalandığı için veri de bozuluyordu. `GET /` aynı açıkla
 * B'nin override'larını sızdırıyordu.
 *
 * `bulk.ts` bu kapsamı zaten doğru uyguluyor
 * (`Channels.findWhere({ _id: { $in }, serverId: sid })`); bu yardımcı aynı
 * sözleşmeyi tekil rotalara taşır. Fail-closed: doğrulanamayan her şey reddedilir.
 */
async function assertChannelInServer(cid: string, sid: string): Promise<boolean> {
  if (!cid || !sid) return false;
  const channel = await Channels.findById(cid);
  return Boolean(channel) && String((channel as { serverId?: unknown }).serverId ?? '') === sid;
}

/** Rol gerçekten bu sunucuya mı ait? (rol-üzerinden çapraz kiracı IDOR engeli) */
async function assertRoleInServer(roleId: string, sid: string): Promise<boolean> {
  if (!roleId || !sid) return false;
  // `@everyone` sözleşmesi sunucu kimliğiyle aynıdır (Bridge kanonik davranışı).
  if (roleId === sid || roleId === '__everyone__') return true;
  return Boolean(await Roles.findByIdAndServer(roleId, sid));
}

export { permReadLimiter,
  assertChannelInServer,
  assertRoleInServer,
  permWriteLimiter,
  getIo,
  emitPermsUpdated,
  writePermAudit,
  sendPermLogMessage, };
