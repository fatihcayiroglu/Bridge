// server/routes/moderation.ts — Session 18: @openapi annotation eklendi
// Mevcut mantık değişmedi; key endpoint'lere JSDoc blokları eklendi.

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router({ mergeParams: true });

const MAX_MEMBER_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;
import { Auth, Users, Members, Servers, Messages, Channels, Roles, ChannelPermissions, MessageReports } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import type { JwtPayload } from '../middleware/auth';
import { getMemberPerms, hasPermission, canActOn, PERMS } from './roles';
import { limits } from '../middleware/rateLimit';
// Sprint 121 FIX 12: permCache invalidation — kick/ban/timeout sonrası izin cache'ini temizle
import { invalidatePerms } from '../lib/permCache';
import { v4 as uuidv4 } from 'uuid';
import { emitPermsUpdated, sendPermLogMessage, writePermAudit } from './channelPerms/helpers';
import { evictUserFromServerRooms, evictSocketsWithoutChannelAccessBestEffort } from '../lib/liveMembership';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery, parseNonNegativeSafeIntValue } from '../lib/queryNumbers';
import { resolvePermissions as resolveEffectivePermissions } from '../lib/permissions';
import { storedMessageText } from '../lib/storedText';
import { enforceStepUp } from '../lib/stepUp';

type PermissionState = { allow: number; deny: number };
type AuditRow = Record<string, unknown> & {
  _id?: string; serverId?: string; channelId?: string; targetId?: string;
  targetName?: string; action?: string; actorName?: string; createdAt?: number;
  old?: unknown; new?: unknown; extra?: unknown;
};

const SAFE_PERMISSION_UNDO_ACTIONS = new Set(['PERM_UPDATE', 'PERM_DELETE']);
const RELATED_PERMISSION_ACTIONS = ['PERM_UPDATE', 'PERM_DELETE', 'PERM_UNDO'];

function parseAuditJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function decodePermissionState(value: unknown): { ok: true; value: PermissionState | null } | { ok: false } {
  const parsed = parseAuditJson(value);
  if (parsed === null || parsed === undefined) return { ok: true, value: null };
  if (!parsed || typeof parsed !== 'object') return { ok: false };
  const allow = Number((parsed as Record<string, unknown>).allow);
  const deny = Number((parsed as Record<string, unknown>).deny);
  if (!Number.isInteger(allow) || allow < 0 || !Number.isInteger(deny) || deny < 0 || (allow & deny) !== 0) {
    return { ok: false };
  }
  return { ok: true, value: { allow, deny } };
}

function samePermissionState(row: Record<string, unknown> | null, state: PermissionState | null): boolean {
  if (!row || !state) return row === null && state === null;
  return Number(row.allow) === state.allow && Number(row.deny) === state.deny;
}

function dateBoundary(value: unknown, endOfDay: boolean): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const input = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : value;
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

async function permissionUndoAssessment(serverId: string, entry: AuditRow): Promise<{
  supported: boolean; canUndo: boolean; reason?: string;
}> {
  if (!SAFE_PERMISSION_UNDO_ACTIONS.has(String(entry.action ?? ''))) {
    return { supported: false, canUndo: false };
  }
  const channelId = String(entry.channelId ?? '');
  const roleId = String(entry.targetId ?? '');
  const auditId = String(entry._id ?? '');
  const createdAt = Number(entry.createdAt);
  if (!channelId || !roleId || !auditId || !Number.isFinite(createdAt)) {
    return { supported: true, canUndo: false, reason: 'Denetim kaydında güvenli geri alma için gereken hedef bilgileri eksik.' };
  }

  const [channel, roleExists] = await Promise.all([
    Channels.findByIdAndServer(channelId, serverId),
    roleId === '__everyone__' || roleId === serverId
      ? Promise.resolve(true)
      : Roles.findByIdAndServer(roleId, serverId).then(Boolean),
  ]);
  if (!channel || !roleExists) {
    return { supported: true, canUndo: false, reason: 'Kanal veya rol artık mevcut değil.' };
  }

  const oldState = decodePermissionState(entry.old);
  const newState = decodePermissionState(entry.new);
  if (!oldState.ok || !newState.ok) {
    return { supported: true, canUndo: false, reason: 'Denetim kaydındaki önceki durum doğrulanamıyor.' };
  }
  if (entry.action === 'PERM_UPDATE' && newState.value === null) {
    return { supported: true, canUndo: false, reason: 'Güncellemenin son durumu doğrulanamıyor.' };
  }
  if (entry.action === 'PERM_DELETE' && oldState.value === null) {
    return { supported: true, canUndo: false, reason: 'Silinen override’ın önceki durumu kayıtta yok.' };
  }

  const later = await Auth.findAuditLogsWhere({
    serverId, channelId, targetId: roleId,
    action: { $in: RELATED_PERMISSION_ACTIONS },
    createdAt: { $gte: createdAt },
    _id: { $ne: auditId },
  }) as AuditRow[];
  if (later.length) {
    return { supported: true, canUndo: false, reason: 'Bu hedefte daha yeni bir yönetici değişikliği var.' };
  }

  const current = await ChannelPermissions.findOne({ channelId, roleId }) as Record<string, unknown> | null;
  const expected = entry.action === 'PERM_UPDATE' ? newState.value : null;
  if (!samePermissionState(current, expected)) {
    return { supported: true, canUndo: false, reason: 'Mevcut izin durumu denetim kaydından sonra değişmiş.' };
  }
  return { supported: true, canUndo: true };
}

function csvCell(value: unknown): string {
  let text = String(value ?? '').replace(/\r?\n/g, ' ');
  // Spreadsheet formula injection: exported admin data may still contain
  // user-controlled names/reasons.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeAudit(serverId: string, actor: JwtPayload, action: string, targetId: string, targetName: string, detail = ''): Promise<void> {
  await Auth.insertAuditLog({
    serverId,
    actorId: actor._id || actor.id,
    actorName: actor.displayName || actor.username,
    action, targetId, targetName, detail,
  });
}

/** User-submitted message reports visible only where the moderator has MANAGE_MESSAGES. */
router.get('/reports', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const rows = await MessageReports.findOpenForServer(serverId, 200);
  const visible: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const channelId = String(row.channelId ?? '');
    const perms = await resolveEffectivePermissions(_u.id, serverId, channelId).catch(() => 0);
    if (!hasPermission(perms, PERMS.MANAGE_MESSAGES) && !hasPermission(perms, PERMS.ADMIN)) continue;
    const [message, channel, reporter] = await Promise.all([
      Messages.findById(String(row.messageId ?? '')),
      Channels.findByIdAndServer(channelId, serverId),
      Users.findById(String(row.reporterId ?? '')),
    ]);
    if (!message || !channel) continue;
    visible.push({
      id: String(row._id), messageId: String(row.messageId), channelId,
      reason: String(row.reason ?? 'other'), detail: String(row.detail ?? ''),
      createdAt: Number(row.createdAt ?? 0),
      channel: { _id: channelId, name: String(channel.name ?? channelId) },
      message: {
        displayName: String(message.displayName ?? message.username ?? 'Bridge user'),
        preview: storedMessageText(message).replace(/\s+/g, ' ').trim().slice(0, 240),
      },
      reporter: { _id: String(row.reporterId ?? ''), displayName: String(reporter?.displayName ?? reporter?.username ?? 'Bridge user') },
    });
  }
  return res.json({ reports: visible, count: visible.length });
});

router.put('/reports/:reportId', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const reportId = String(req.params.reportId ?? '');
  const resolution = String(req.body?.resolution ?? '');
  if (resolution !== 'resolved' && resolution !== 'dismissed') return res.status(400).json({ error: 'Invalid resolution' });

  const report = await MessageReports.findById(serverId, reportId);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const channelId = String(report.channelId ?? '');
  const perms = await resolveEffectivePermissions(_u.id, serverId, channelId).catch(() => 0);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const result = await MessageReports.resolveTargetState({
    serverId, id: reportId, actorId: _u.id,
    resolution: resolution as 'resolved' | 'dismissed',
  });
  if (result.kind === 'missing') return res.status(404).json({ error: 'Report not found' });
  if (result.kind === 'conflict') return res.status(409).json({ error: 'Report already handled' });
  if (result.kind === 'updated') {
    await writeAudit(serverId, _u, resolution === 'resolved' ? 'REPORT_RESOLVED' : 'REPORT_DISMISSED', reportId, String(report.messageId ?? ''), `channel:${channelId}`);
  }
  return res.json({ resolved: true, resolution, report: result.row });
});

/**
 * @openapi
 * /servers/{serverId}/audit-log:
 *   get:
 *     summary: Sunucu denetim günlüğünü getir
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 500
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *           description: Eylem filtresi (örn. ban, kick, timeout)
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, csv]
 *           default: json
 *     responses:
 *       200:
 *         description: Denetim günlüğü kayıtları
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries:
 *                   type: array
 *                 total:
 *                   type: integer
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/audit-log:
 *   get:
 *     tags: [Moderation]
 *     summary: Denetim günlüğü
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *       - in: query
 *         name: before
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Denetim kayıtları
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/audit-log', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const limit = parseBoundedPositiveIntQuery(req.query.limit, 100, 500);
  const offset = parseNonNegativeSafeIntQuery(req.query.offset, 0);
  if (limit === null || offset === null) return res.status(400).json({ error: 'Geçersiz sayfalama değeri' });

  const actionRaw = req.query.action;
  if (actionRaw !== undefined && (typeof actionRaw !== 'string' || actionRaw.length > 64)) {
    return res.status(400).json({ error: 'Geçersiz action filtresi' });
  }
  const action = actionRaw as string | undefined;

  const formatRaw = req.query.format;
  if (formatRaw !== undefined && formatRaw !== 'json' && formatRaw !== 'csv') {
    return res.status(400).json({ error: 'format json veya csv olmalı' });
  }
  const format = (formatRaw || 'json') as 'json' | 'csv';

  const after = dateBoundary(req.query.after, false);
  const before = dateBoundary(req.query.before, true);
  if ((req.query.after !== undefined && after === undefined) ||
      (req.query.before !== undefined && before === undefined) ||
      (after !== undefined && before !== undefined && after > before)) {
    return res.status(400).json({ error: 'Geçersiz tarih aralığı' });
  }
  const uiMode = req.query.ui === '1';

  const { entries, total } = await Auth.getAuditLog(serverId, { limit, offset, action, after, before });

  let responseEntries = entries as AuditRow[];
  if (uiMode && responseEntries.length) {
    const channelIds = [...new Set(responseEntries.map(entry => String(entry.channelId ?? '')).filter(Boolean))];
    const roleIds = [...new Set(responseEntries.map(entry => String(entry.targetId ?? '')).filter(id => id && id !== '__everyone__' && id !== serverId))];
    const [channelRows, roleRows] = await Promise.all([
      channelIds.length ? Channels.findWhere({ _id: { $in: channelIds }, serverId }) : Promise.resolve([]),
      roleIds.length ? Roles.findWhere({ _id: { $in: roleIds }, serverId }) : Promise.resolve([]),
    ]);
    const channelNames = new Map(channelRows.map(row => [String(row._id), String(row.name ?? row._id)]));
    const roleNames = new Map(roleRows.map(row => [String(row._id), String(row.name ?? row._id)]));
    const canManageChannels = hasPermission(perms, PERMS.MANAGE_CHANNELS) || hasPermission(perms, PERMS.ADMIN);

    responseEntries = await Promise.all(responseEntries.map(async entry => {
      const supported = SAFE_PERMISSION_UNDO_ACTIONS.has(String(entry.action ?? ''));
      const undo = canManageChannels
        ? await permissionUndoAssessment(serverId, entry)
        : supported
          ? { supported: true, canUndo: false, reason: 'Geri alma için kanalları yönetme yetkisi gerekir.' }
          : { supported: false, canUndo: false };
      const channelId = String(entry.channelId ?? '');
      const targetId = String(entry.targetId ?? '');
      return {
        ...entry,
        old: parseAuditJson(entry.old),
        new: parseAuditJson(entry.new),
        extra: parseAuditJson(entry.extra),
        ...(channelId ? { channelName: channelNames.get(channelId) ?? channelId } : {}),
        ...(targetId ? {
          targetName: targetId === '__everyone__' || targetId === serverId
            ? '@everyone'
            : roleNames.get(targetId) ?? entry.targetName ?? targetId,
        } : {}),
        undo,
      };
    }));
  }

  if (format === 'csv') {
    const header = 'timestamp,actor,action,target,detail';
    const rows   = responseEntries.map(e =>
      [e.createdAt, e.actorName, e.action, e.targetName, e.detail].map(csvCell).join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${serverId}.csv"`);
    return res.send([header, ...rows].join('\n'));
  }

  res.json({ entries: responseEntries, total });
});

/**
 * Dar ve kanıtlanabilir geri alma kapsamı: yalnız kanal izin override'ı.
 * İşlem; hedef, audit sırası ve güncel durum doğrulandıktan sonra mevcut
 * allow/deny değerlerini WHERE koşuluna da koyan karşılaştırmalı mutasyonla
 * uygulanır. Kick/ban/timeout veya genel rollback burada kasıtlı olarak yoktur.
 */
router.post('/audit-log/:auditId/undo', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const auditId = String(req.params.auditId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  }

  const matches = await Auth.findAuditLogsWhere({ _id: auditId, serverId }) as AuditRow[];
  const entry = matches[0];
  if (!entry) return res.status(404).json({ error: 'Denetim kaydı bulunamadı.' });

  const assessment = await permissionUndoAssessment(serverId, entry);
  if (!assessment.supported) {
    return res.status(400).json({ error: 'Bu işlem güvenli geri alma kapsamına dahil değil.' });
  }
  if (!assessment.canUndo) {
    return res.status(409).json({ error: assessment.reason || 'İşlem artık güvenle geri alınamaz.' });
  }

  const channelId = String(entry.channelId);
  const roleId = String(entry.targetId);
  const oldState = decodePermissionState(entry.old);
  const newState = decodePermissionState(entry.new);
  if (!oldState.ok || !newState.ok) {
    return res.status(409).json({ error: 'Denetim kaydındaki durum doğrulanamıyor.' });
  }

  const expectedCurrent = entry.action === 'PERM_UPDATE' ? newState.value : null;
  const restored = oldState.value;
  try {
    if (expectedCurrent && restored) {
      const result = await ChannelPermissions.update(
        { channelId, roleId, allow: expectedCurrent.allow, deny: expectedCurrent.deny },
        { $set: { allow: restored.allow, deny: restored.deny, updatedAt: Date.now() } },
      );
      if (result?.updated !== 1) return res.status(409).json({ error: 'İzin durumu işlem sırasında değişti; geri alma uygulanmadı.' });
    } else if (expectedCurrent && restored === null) {
      const result = await ChannelPermissions.remove({
        channelId, roleId, allow: expectedCurrent.allow, deny: expectedCurrent.deny,
      });
      if (result?.deleted !== 1) return res.status(409).json({ error: 'İzin durumu işlem sırasında değişti; geri alma uygulanmadı.' });
    } else if (expectedCurrent === null && restored) {
      await ChannelPermissions.insert({
        _id: uuidv4(), serverId, channelId, roleId,
        allow: restored.allow, deny: restored.deny,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      const inserted = await ChannelPermissions.findOne({ channelId, roleId }) as Record<string, unknown> | null;
      if (!samePermissionState(inserted, restored)) {
        return res.status(409).json({ error: 'İzin durumu işlem sırasında değişti; geri alma uygulanmadı.' });
      }
    } else {
      return res.status(409).json({ error: 'Geri yüklenecek doğrulanmış bir izin durumu yok.' });
    }
  } catch {
    return res.status(409).json({ error: 'İzin durumu işlem sırasında değişti; geri alma uygulanmadı.' });
  }

  const actor = await Users.findById(_u.id);
  const actorName = actor?.displayName || actor?.username || _u.displayName || _u.username || _u.id;
  const targetName = String(entry.targetName ?? roleId);
  await writePermAudit(
    serverId, _u.id, channelId, roleId, 'PERM_UNDO', expectedCurrent, restored,
    { actorName, targetName, sourceAuditId: auditId },
  );
  await sendPermLogMessage(req, serverId, channelId, 'PERM_UNDO', actorName, targetName, expectedCurrent, restored);
  invalidatePerms(serverId, null, channelId);
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), serverId, channelId);
  emitPermsUpdated(req, serverId, channelId);

  return res.json({ ok: true, scope: 'channel_permission' });
});

/**
 * @openapi
 * /servers/{serverId}/members/{userId}/timeout:
 *   post:
 *     summary: Üyeye timeout uygula
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [durationMs]
 *             properties:
 *               durationMs:
 *                 type: integer
 *                 description: Timeout süresi (ms). 0 = kaldır.
 *                 example: 300000
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Timeout uygulandı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Üye bulunamadı
 */
/**
 * @openapi
 * /servers/{sid}/members/{userId}/timeout:
 *   post:
 *     tags: [Moderation]
 *     summary: Kullanıcıyı sustur (timeout)
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               duration: { type: integer, description: 'Süre (dakika)' }
 *               reason: { type: string }
 *     responses:
 *       200: { description: Timeout uygulandı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/members/:userId/timeout', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const userId = String(req.params.userId ?? '');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const rawDurationMs = body.durationMs;
  const reason = body.reason;
  const durationMs = rawDurationMs === undefined ? null : parseNonNegativeSafeIntValue(rawDurationMs, 0);
  // A malformed/missing duration must never silently become `0`, because 0 means
  // "remove the timeout". JSON numeric strings are intentionally rejected so
  // coercion cannot accidentally turn hostile input into a state-changing action.
  if (durationMs === null || durationMs < 0 || durationMs > MAX_MEMBER_TIMEOUT_MS) {
    return res.status(400).json({ error: 'durationMs must be a safe integer between 0 and 28 days' });
  }
  if (reason !== undefined && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string' });
  }

  // Güvenlik: kendine timeout önleme
  if (_u.id === userId) return res.status(400).json({ error: 'Kendinize timeout uygulayamazsınız' });

  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.TIMEOUT_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  // Güvenlik: sunucu sahibine timeout önleme
  const server = await Servers.findById(serverId);
  if (server?.ownerId === userId) {
    return res.status(403).json({ error: 'Sunucu sahibine timeout uygulanamaz' });
  }

  // Server ownership is allowed to bypass role hierarchy, but it must not
  // turn an arbitrary global user into a successful server-member mutation.
  if (!await Members.findOne(userId, serverId)) {
    return res.status(404).json({ error: 'Üye bulunamadı' });
  }

  // Güvenlik: daha yüksek yetkili üyeye timeout önleme
  if (!(await canActOn(_u.id, userId, serverId))) {
    return res.status(403).json({ error: 'Daha yüksek yetkili bir üyeye timeout uygulayamazsınız' });
  }

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const until = durationMs > 0 ? new Date(Date.now() + durationMs) : null;
  const timeoutResult = await Members.setTimeout(serverId, userId, until);
  if (timeoutResult?.updated !== 1) {
    return res.status(409).json({ error: 'Üyelik işlem sırasında değişti' });
  }
  await writeAudit(serverId, _u, durationMs > 0 ? 'timeout' : 'timeout_remove', userId, target.username, reason || '');
  // Sprint 121 FIX 12: Timeout sonrası permCache temizle
  invalidatePerms(serverId, userId);
  // A timed-out member may not stay in a live call: the SFU only checks the
  // timeout when an operation starts (P2 media lab: media kept flowing).
  if (durationMs > 0) await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), serverId, null);

  res.json({ ok: true, until });
});

/**
 * @openapi
 * /servers/{serverId}/members/{userId}/kick:
 *   post:
 *     summary: Üyeyi sunucudan at
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Üye atıldı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/members/{userId}/kick:
 *   post:
 *     tags: [Moderation]
 *     summary: Kullanıcıyı at
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: Kullanıcı atıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/members/:userId/kick', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const userId = String(req.params.userId ?? '');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const reason = body.reason;
  if (reason !== undefined && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string' });
  }

  // Güvenlik: kendini kick etmeyi engelle
  if (_u.id === userId) return res.status(400).json({ error: 'Kendinizi kickleyemezsiniz' });

  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.KICK_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  // Güvenlik: sunucu sahibini kick etmeyi engelle
  const server = await Servers.findById(serverId);
  if (server?.ownerId === userId) {
    return res.status(403).json({ error: 'Sunucu sahibi kicklenemez' });
  }

  if (!await Members.findOne(userId, serverId)) {
    return res.status(404).json({ error: 'Üye bulunamadı' });
  }

  // Güvenlik: hedefin izin seviyesi aktörün seviyesinden yüksekse engelle
  if (!(await canActOn(_u.id, userId, serverId))) {
    return res.status(403).json({ error: 'Daha yüksek yetkili bir üzeyi kickleyemezsiniz' });
  }

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  // P7 B2: past the moderation burst (5 destructive actions / 60 s / actor) a
  // `moderation-burst` proof is needed; ordinary moderation is never asked.
  if (!(await enforceStepUp(req, res, _u.id, 'moderation.kick'))) return;

  const removal = await Members.removeMember(userId, serverId);
  if (removal?.deleted !== 1) {
    return res.status(409).json({ error: 'Üyelik işlem sırasında değişti' });
  }
  await writeAudit(serverId, _u, 'kick', userId, target.username, reason || '');
  // Sprint 121 FIX 12: Kick sonrası permCache temizle — kullanıcı eski izinleriyle erişemez
  invalidatePerms(serverId, userId);
  await evictUserFromServerRooms(req.app.get('io'), userId, serverId);

  res.json({ ok: true });
});

/**
 * @openapi
 * /servers/{serverId}/bans:
 *   get:
 *     summary: Ban listesini getir
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Banlı kullanıcı listesi
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     summary: Kullanıcıyı banla
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               reason:
 *                 type: string
 *               deleteMessageDays:
 *                 type: integer
 *                 default: 0
 *     responses:
 *       200:
 *         description: Kullanıcı banlandı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/bans:
 *   get:
 *     tags: [Moderation]
 *     summary: Ban listesi
 *     responses:
 *       200:
 *         description: Banlı kullanıcılar
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/bans', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.BAN_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bans = await Members.getBans(serverId);
  res.json(bans);
});

/**
 * @openapi
 * /servers/{sid}/bans:
 *   post:
 *     tags: [Moderation]
 *     summary: Kullanıcıyı banla
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: string }
 *               reason: { type: string }
 *               deleteMessageDays: { type: integer, default: 0, maximum: 7 }
 *     responses:
 *       200: { description: Kullanıcı banlandı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/bans', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const userId = body.userId;
  const reason = body.reason;
  const deleteMessageDays = parseNonNegativeSafeIntValue(body.deleteMessageDays, 0);
  if (typeof userId !== 'string' || !userId.trim()) return res.status(400).json({ error: 'userId required' });
  if (reason !== undefined && typeof reason !== 'string') return res.status(400).json({ error: 'reason must be a string' });
  // Keep the runtime contract aligned with the documented moderation safety bound.
  // Invalid input must not turn into an unexpectedly broad history deletion.
  if (deleteMessageDays === null || deleteMessageDays > 7) {
    return res.status(400).json({ error: 'deleteMessageDays must be an integer between 0 and 7' });
  }

  // Güvenlik: kendini banlama önleme
  if (_u.id === userId) return res.status(400).json({ error: 'Kendinizi banlayamazsınız' });

  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.BAN_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  // Güvenlik: sunucu sahibini banlama önleme
  const server = await Servers.findById(serverId);
  if (server?.ownerId === userId) {
    return res.status(403).json({ error: 'Sunucu sahibi banlanamaz' });
  }

  // Güvenlik: hedefin izin seviyesi aktörden yüksekse engelle
  if (!(await canActOn(_u.id, userId, serverId))) {
    return res.status(403).json({ error: 'Daha yüksek yetkili bir üyeyi banlayamazsınız' });
  }

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  // P7 B2: moderation-burst step-up (see kick above).
  if (!(await enforceStepUp(req, res, _u.id, 'moderation.ban'))) return;

  await Members.banMember(serverId, userId, reason);
  if (deleteMessageDays > 0) {
    const since = new Date(Date.now() - deleteMessageDays * 864e5);
    await Messages.deleteUserMessages(userId, serverId, since);
  }
  await writeAudit(serverId, _u, 'ban', userId, target.username, reason || '');
  // Sprint 121 FIX 12: Ban sonrası permCache temizle
  invalidatePerms(serverId, userId);
  await evictUserFromServerRooms(req.app.get('io'), userId, serverId);

  res.json({ ok: true });
});

/**
 * @openapi
 * /servers/{serverId}/bans/{userId}:
 *   delete:
 *     summary: Banı kaldır (unban)
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Ban kaldırıldı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/bans/{userId}:
 *   delete:
 *     tags: [Moderation]
 *     summary: Ban kaldır
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Ban kaldırıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/bans/:userId', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const userId = String(req.params.userId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.BAN_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const target = await Users.findById(userId);
  const removal = await Members.unbanMember(serverId, userId);
  if (removal?.deleted !== 1) {
    return res.status(404).json({ error: 'Ban kaydı bulunamadı' });
  }
  await writeAudit(serverId, _u, 'unban', userId, target?.username || userId, '');
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
