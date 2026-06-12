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
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../../middleware/auth';
import { resolvePermissions, hasPermission, PERMS, validateBitmask, DEFAULT_PERMISSIONS } from '../../lib/permissions';
import { invalidatePerms } from '../../lib/permCache';
import { ChannelPermissions, Roles, Users, Auth } from '../../db/repositories';
import { permReadLimiter, permWriteLimiter, emitPermsUpdated, writePermAudit, sendPermLogMessage } from './helpers';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
interface PermRow { _id: string; channelId: string; roleId: string; allow: number; deny: number; targetType?: string; targetId?: string; targetName?: string }
interface AuditRow { actorId?: string; actorName?: string; targetId?: string; targetName?: string; old?: unknown; new?: unknown; createdAt?: number; [k: string]: unknown }

const router: Router = express.Router({ mergeParams: true });

router.get('/', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  res.json({ overrides: await ChannelPermissions.findByChannel(cid) || [], roles: await Roles.findWhere({ serverId: sid }) || [] });
});

router.get('/audit-log', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { action, targetId, since, until, limit: limitParam } = req.query as Record<string, string | undefined>;
  const limit = Math.min(parseInt(limitParam ?? '') || 100, 200);
  const query: Record<string, unknown> = { serverId: sid, channelId: cid };
  if (action)   query['action']   = action;
  if (targetId) query['targetId'] = targetId;
  if (since || until) {
    const createdAt: Record<string, number> = {};
    if (since) createdAt['$gte'] = parseInt(since);
    if (until) createdAt['$lte'] = parseInt(until);
    query['createdAt'] = createdAt;
  }
  const auditCursor = Auth.auditLogsFind(query);
  const logs = auditCursor
    ? await Promise.resolve(auditCursor.sort({ createdAt: -1 }).limit(limit)).catch(() => [])
    : [];
  const actorIds  = [...new Set(logs.map(l => l.actorId).filter(Boolean))] as string[];
  const actors    = actorIds.length ? await Users.findByIds(actorIds) || [] : [];
  const actorMap: Record<string, string>  = Object.fromEntries(actors.map(u => [u._id, u.username || u.displayName || u._id]));
  const roleIds   = [...new Set(logs.map(l => l.targetId).filter(id => id && id !== '__everyone__'))] as string[];
  const roleRows  = roleIds.length ? await Roles.findWhere({ _id: { $in: roleIds } }) || [] : [];
  const roleMap: Record<string, string>   = Object.fromEntries(roleRows.map(r => [r._id, r.name]));
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
  const { allow = 0, deny = 0, targetType, targetId, targetName } = req.body as { allow?: number; deny?: number; targetType?: string; targetId?: string; targetName?: string };
  const check = validateBitmask(Number(allow), Number(deny));
  if (!check.ok) return void res.status(400).json({ error: `Geçersiz bitmask: ${check.error}` });
  const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
  const oldVals  = existing ? { allow: existing.allow, deny: existing.deny } : null;
  if (existing) {
    await ChannelPermissions.update({ channelId: cid, roleId }, { $set: { allow, deny, updatedAt: Date.now() } });
  } else {
    await ChannelPermissions.insert({ _id: uuidv4(), channelId: cid, roleId, serverId: sid, allow, deny,
      ...(targetType && { targetType }), ...(targetId && { targetId }), ...(targetName && { targetName }), createdAt: Date.now() });
  }
  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  await writePermAudit(sid, _u.id, cid, roleId, 'PERM_UPDATE', oldVals, { allow, deny }, { targetType: targetType || 'role', targetName, actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName, targetName || roleId, oldVals, { allow, deny });
  invalidatePerms(sid, null, cid);
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
  const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
  await ChannelPermissions.remove({ channelId: cid, roleId });
  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  const oldVals   = existing ? { allow: existing.allow, deny: existing.deny } : null;
  await writePermAudit(sid, _u.id, cid, roleId, 'PERM_DELETE', oldVals, null, { actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_DELETE', actorName, roleId, oldVals, null);
  invalidatePerms(sid, null, cid);
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

  let roleName = '@everyone', rolePerms = 0, isUser = false;
  if (roleId === '__everyone__') {
    rolePerms = DEFAULT_PERMISSIONS;
  } else if (roleId.startsWith('user:')) {
    isUser = true;
    const userId = roleId.replace('user:', '');
    const user   = await Users.findById(userId);
    roleName = user?.displayName || user?.username || userId;
  } else {
    const role = await Roles.findByIdAndServer(roleId, sid);
    if (role) { roleName = role.name; rolePerms = role.permissions || 0; }
  }

  const override = await ChannelPermissions.findOne({ channelId: cid, roleId }) || null;
  const ALL_BITS = Object.values(PERMS).filter(v => Number.isInteger(v) && v !== PERMS.ADMINISTRATOR) as number[];
  const bitSources: Record<number, object> = {};

  for (const bit of ALL_BITS) {
    const fromRole    = !isUser && (rolePerms & bit) !== 0;
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

  res.json({ roleId, roleName, isUser, hasOverride: !!override, override: override ? { allow: override.allow, deny: override.deny } : null, rolePermissions: rolePerms, serverDefault: DEFAULT_PERMISSIONS, bitSources });
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
