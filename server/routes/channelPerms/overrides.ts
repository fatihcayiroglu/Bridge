/**
 * @openapi
 * tags:
 *   - name: ChannelPerms
 *     description: ChannelPerms API endpoints

 *
 * /servers/{sid}/channels/{cid}/perms:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal izin override'larini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Override listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channels/{cid}/perms/audit-log:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal izin degisiklik gecmisi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Audit log
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channels/{cid}/perms/{roleId}:
 *   put:
 *     tags: [Channels]
 *     summary: Rol icin kanal izni ayarla
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               allow: { type: integer }
 *               deny:  { type: integer }
 *     responses:
 *       200:
 *         description: Izin ayarlandi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Channels]
 *     summary: Rol icin kanal izni override'ini kaldir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Override kaldirildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channels/{cid}/perms/inheritance/{roleId}:
 *   get:
 *     tags: [Channels]
 *     summary: Rol izin miras zincirini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: roleId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Miras zinciri
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/channelPerms/overrides.ts
// Tek kanal override CRUD + audit-log okuma + kalıtım görselleştirme
import express, { Request, Response, Router } from 'express';
import { evictSocketsWithoutChannelAccessBestEffort } from '../../lib/liveMembership';
import { authMiddleware} from '../../middleware/auth';
import {
  explainResolvedPermission, resolvePermissionResolution, resolvePermissions,
  hasPermission, PERMS, validateBitmask, DEFAULT_PERMISSIONS,
} from '../../lib/permissions';
import { invalidatePerms } from '../../lib/permCache';
import { ChannelPermissions, Roles, Users, Auth } from '../../db/repositories';
import { permReadLimiter, permWriteLimiter, emitPermsUpdated, writePermAudit, sendPermLogMessage, assertChannelInServer, assertRoleInServer } from './helpers';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../../lib/queryNumbers';
interface _PermRow { _id: string; channelId: string; roleId: string; allow: number; deny: number; targetType?: string; targetId?: string; targetName?: string }
interface _AuditRow { actorId?: string; actorName?: string; targetId?: string; targetName?: string; old?: unknown; new?: unknown; createdAt?: number; [k: string]: unknown }

const router: Router = express.Router({ mergeParams: true });

const EXPLAINED_PERMISSIONS = [
  { key: 'VIEW_CHANNELS', label: 'Kanalı görüntüle', flag: PERMS.VIEW_CHANNELS, denied: 'Bu kanalı görüntüleme yetkiniz yok.' },
  { key: 'SEND_MESSAGES', label: 'Mesaj gönder', flag: PERMS.SEND_MESSAGES, denied: 'Bu kanala mesaj gönderme yetkiniz yok.' },
  { key: 'ATTACH_FILES', label: 'Dosya ekle', flag: PERMS.ATTACH_FILES, denied: 'Bu kanala dosya gönderme yetkiniz yok.' },
  { key: 'MANAGE_MESSAGES', label: 'Mesajları yönet', flag: PERMS.MANAGE_MESSAGES, denied: 'Bu kanaldaki mesajları yönetme yetkiniz yok.' },
  { key: 'CONNECT', label: 'Sese bağlan', flag: PERMS.CONNECT, denied: 'Bu ses kanalına bağlanma yetkiniz yok.' },
  { key: 'SPEAK', label: 'Seste konuş', flag: PERMS.SPEAK, denied: 'Bu ses kanalında konuşma yetkiniz yok.' },
] as const;

router.get('/', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });
  res.json({ overrides: await ChannelPermissions.findByChannel(cid) || [], roles: await Roles.findWhere({ serverId: sid }) || [] });
});

/**
 * Admin-only explanation for the caller's effective access in this channel.
 * The trace comes from the same resolver used by authorization. Raw masks are
 * deliberately transformed away before the response leaves the server.
 */
router.get('/explain/me', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const requesterPermissions = await resolvePermissions(_u.id, sid);
  if (!hasPermission(requesterPermissions, PERMS.MANAGE_CHANNELS)) {
    return void res.status(403).json({ error: 'Forbidden' });
  }
  if (!await assertChannelInServer(cid, sid)) {
    return void res.status(404).json({ error: 'Channel not found in this server' });
  }

  const resolution = await resolvePermissionResolution(_u.id, sid, cid);
  const permissions = EXPLAINED_PERMISSIONS.map(permission => ({
    key: permission.key,
    label: permission.label,
    ...explainResolvedPermission(resolution, permission.flag, permission.denied),
  }));

  res.json({
    channelId: cid,
    subject: resolution.subject,
    permissions,
  });
});

router.get('/audit-log', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });

  const { action, targetId, since, until, limit: limitParam } = req.query;
  if ((action !== undefined && (typeof action !== 'string' || action.length > 128)) ||
      (targetId !== undefined && (typeof targetId !== 'string' || targetId.length > 160)))
    return void res.status(400).json({ error: 'Invalid audit filter' });
  const limit = parseBoundedPositiveIntQuery(limitParam, 100, 200);
  if (limit === null) return void res.status(400).json({ error: 'limit must be a positive safe integer' });
  const sinceTs = since === undefined ? undefined : parseNonNegativeSafeIntQuery(since, 0);
  const untilTs = until === undefined ? undefined : parseNonNegativeSafeIntQuery(until, 0);
  if ((since !== undefined && sinceTs === null) || (until !== undefined && untilTs === null))
    return void res.status(400).json({ error: 'since/until geçerli epoch-millis olmalı' });
  if (sinceTs !== undefined && sinceTs !== null && untilTs !== undefined && untilTs !== null && sinceTs > untilTs)
    return void res.status(400).json({ error: 'since, until değerinden büyük olamaz' });
  const query: Record<string, unknown> = { serverId: sid, channelId: cid };
  if (action)   query['action']   = action;
  if (targetId) query['targetId'] = targetId;
  if (sinceTs !== undefined || untilTs !== undefined) {
    const createdAt: Record<string, number> = {};
    if (sinceTs !== undefined && sinceTs !== null) createdAt['$gte'] = sinceTs;
    if (untilTs !== undefined && untilTs !== null) createdAt['$lte'] = untilTs;
    query['createdAt'] = createdAt;
  }
  let logs: _AuditRow[];
  let actors: Array<{ _id: string; username?: string; displayName?: string }>;
  let roleRows: Array<{ _id: string; name?: string }>;
  try {
    const auditCursor = Auth.auditLogsFind(query);
    logs = auditCursor ? await Promise.resolve(auditCursor.sort({ createdAt: -1 }).limit(limit)) as _AuditRow[] : [];
    const actorIds = [...new Set(logs.map(l => l.actorId).filter(Boolean))] as string[];
    actors = actorIds.length ? await Users.findByIds(actorIds) || [] : [];
    const roleIds = [...new Set(logs.map(l => l.targetId).filter(id => id && id !== '__everyone__'))] as string[];
    roleRows = roleIds.length ? await Roles.findWhere({ _id: { $in: roleIds }, serverId: sid }) || [] : [];
  } catch {
    return void res.status(503).json({ error: 'Permission audit log temporarily unavailable' });
  }
  const actorMap: Record<string, string> = Object.fromEntries(actors.map(u => [u._id, u.username || u.displayName || u._id]));
  const roleMap: Record<string, string> = Object.fromEntries(roleRows.map(r => [r._id, r.name || r._id]));
  const enriched  = logs.map(l => {
    let oldVal = l.old, newVal = l.new;
    if (typeof l.old === 'string') { try { oldVal = JSON.parse(l.old); } catch { oldVal = null; } }
    if (typeof l.new === 'string') { try { newVal = JSON.parse(l.new); } catch { newVal = null; } }
    return { ...l, old: oldVal, new: newVal, actorName: actorMap[String(l.actorId ?? '')] || l.actorName || l.actorId,
      targetName: l.targetId === '__everyone__' ? '@everyone' : (roleMap[String(l.targetId ?? '')] || l.targetName || l.targetId) };
  });
  res.json(enriched);
});

router.put('/:roleId', authMiddleware, permWriteLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const roleId = String(req.params.roleId ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });
  if (!await assertRoleInServer(roleId, sid))
    return void res.status(404).json({ error: 'Role not found in this server' });
  const { allow = 0, deny = 0, targetType, targetId: _targetId, targetName } = req.body as { allow?: number; deny?: number; targetType?: string; targetId?: string; targetName?: string };
  const check = validateBitmask(allow, deny);
  if (!check.ok) return void res.status(400).json({ error: `Geçersiz bitmask: ${check.error}` });
  const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
  const oldVals  = existing ? { allow: existing.allow, deny: existing.deny } : null;
  const applied = await ChannelPermissions.applyChannelBatchAtomic(sid, cid, [{ roleId, allow, deny }], []);
  if (!applied) return void res.status(404).json({ error: 'Channel not found in this server' });
  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  await writePermAudit(sid, _u.id, cid, roleId, 'PERM_UPDATE', oldVals, { allow, deny }, { targetType: targetType || 'role', targetName, actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName, targetName || roleId, oldVals, { allow, deny });
  invalidatePerms(sid, null, cid);
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({ ok: true });
});

router.delete('/:roleId', authMiddleware, permWriteLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const roleId = String(req.params.roleId ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });
  if (!await assertRoleInServer(roleId, sid))
    return void res.status(404).json({ error: 'Role not found in this server' });
  const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
  await ChannelPermissions.remove({ channelId: cid, roleId });
  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  const oldVals   = existing ? { allow: existing.allow, deny: existing.deny } : null;
  await writePermAudit(sid, _u.id, cid, roleId, 'PERM_DELETE', oldVals, null, { actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_DELETE', actorName, roleId, oldVals, null);
  invalidatePerms(sid, null, cid);
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({ ok: true });
});

router.get('/inheritance/:roleId', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const roleId = String(req.params.roleId ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });
  if (!await assertRoleInServer(roleId, sid))
    return void res.status(404).json({ error: 'Role not found in this server' });

  let roleName = '@everyone', rolePerms = 0;
  if (roleId === '__everyone__') {
    rolePerms = DEFAULT_PERMISSIONS;
  } else {
    const role = await Roles.findByIdAndServer(roleId, sid);
    if (role) { roleName = role.name; rolePerms = role.permissions || 0; }
  }

  const override = await ChannelPermissions.findOne({ channelId: cid, roleId }) || null;
  const ALL_BITS = Object.values(PERMS).filter(v => Number.isInteger(v) && v !== PERMS.ADMINISTRATOR) as number[];
  const bitSources: Record<number, object> = {};

  for (const bit of ALL_BITS) {
    const fromRole    = (rolePerms & bit) !== 0;
    const fromDefault = (DEFAULT_PERMISSIONS & bit) !== 0;
    if (override) {
      if      (((override.allow ?? 0) & bit) !== 0) bitSources[bit] = { source: 'channel_override', state: 'allow', label: 'Kanal override (izin veriliyor)' };
      else if (((override.deny ?? 0)  & bit) !== 0) bitSources[bit] = { source: 'channel_override', state: 'deny',  label: 'Kanal override (reddediliyor)' };
      else if (fromRole)                     bitSources[bit] = { source: 'role',           state: 'allow', label: `Rol: ${roleName}` };
      else if (fromDefault)                  bitSources[bit] = { source: 'server_default', state: 'allow', label: 'Sunucu varsayılanı' };
      else                                   bitSources[bit] = { source: 'none',           state: 'deny',  label: 'Hiçbir kaynaktan verilmemiş' };
    } else if (fromRole)    bitSources[bit] = { source: 'role',           state: 'allow', label: `Rol: ${roleName}` };
    else if   (fromDefault) bitSources[bit] = { source: 'server_default', state: 'allow', label: 'Sunucu varsayılanı' };
    else                    bitSources[bit] = { source: 'none',           state: 'deny',  label: 'Hiçbir kaynaktan verilmemiş' };
  }

  res.json({ roleId, roleName, isUser: false, hasOverride: !!override, override: override ? { allow: override.allow, deny: override.deny } : null, rolePermissions: rolePerms, serverDefault: DEFAULT_PERMISSIONS, bitSources });
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
