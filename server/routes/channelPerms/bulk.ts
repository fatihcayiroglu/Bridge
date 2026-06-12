/**
 * @openapi
 * tags:
 *   - name: ChannelPerms
 *     description: ChannelPerms API endpoints

 *
 * /servers/{sid}/channel-perms/bulk-sync:
 *   post:
 *     tags: [Channels]
 *     summary: Kanal izinlerini toplu senkronize et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               overrides: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Senkronize edildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channel-perms/bulk-sync/preview:
 *   post:
 *     tags: [Channels]
 *     summary: Toplu senkronizasyon onizlemesi (dry-run)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               overrides: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Uygulanan degisiklikler
 *
 * /servers/{sid}/channel-perms/batch:
 *   put:
 *     tags: [Channels]
 *     summary: Coklu izni tek seferde guncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               updates: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channel-perms/export:
 *   get:
 *     tags: [Channels]
 *     summary: Kanal izinlerini JSON olarak disari aktar
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Izin yapisi JSON
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/channel-perms/import:
 *   post:
 *     tags: [Channels]
 *     summary: Kanal izinlerini JSON'dan iceri aktar
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200:
 *         description: Iceri aktarildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/channelPerms/bulk.ts
// Toplu işlemler: bulk-sync, batch PUT, export, import
import express, { Request, Response, Router } from 'express';
import { Channels, ChannelPermissions, Roles, Servers, Users } from '../../db/repositories';
import { resolvePermissions, hasPermission, PERMS, validateBitmask } from '../../lib/permissions';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../../middleware/auth';
import { invalidatePerms } from '../../lib/permCache';
import { permReadLimiter, permWriteLimiter, getIo, emitPermsUpdated, writePermAudit, sendPermLogMessage } from './helpers';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
interface ChanRow  { _id: string; name: string; type?: string }
interface PermRow  { _id: string; channelId: string; roleId: string; allow: number; deny: number; targetType?: string; targetId?: string; targetName?: string }
interface OvrInput { roleId: string; allow?: number; deny?: number; targetType?: string; targetId?: string; targetName?: string; roleName?: string }

const router: Router = express.Router({ mergeParams: true });

// POST /bulk-sync
router.post('/bulk-sync', authMiddleware, permWriteLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { channelIds = [], overrides = [] } = req.body as { channelIds?: string[]; overrides?: OvrInput[] };
  if (!Array.isArray(channelIds) || channelIds.length === 0)
    return void res.status(400).json({ error: 'channelIds boş olamaz' });

  const targetChannels = await Channels.findWhere({ _id: { $in: channelIds }, serverId: sid }) || [];
  if (targetChannels.length === 0) return void res.status(400).json({ error: 'Geçerli kanal bulunamadı' });
  const validIds = targetChannels.map(c => c._id).filter((id): id is string => typeof id === 'string' && id !== cid);

  for (const targetCid of validIds) {
    await ChannelPermissions.remove({ channelId: targetCid });
    for (const ovr of overrides) {
      await ChannelPermissions.insert({
        _id: uuidv4(), channelId: targetCid, roleId: ovr.roleId, serverId: sid,
        allow: ovr.allow ?? 0, deny: ovr.deny ?? 0,
        targetType: ovr.targetType ?? null, targetId: ovr.targetId ?? null,
        targetName: ovr.targetName ?? null, createdAt: Date.now(),
      });
    }
  }
  for (const targetCid of validIds) {
    await writePermAudit(sid, _u.id, targetCid, '__bulk__', 'PERM_BULK_SYNC',
      null, { sourceChannelId: cid, overrideCount: overrides.length });
  }
  invalidatePerms(sid);
  const io = getIo(req);
  if (io) for (const targetCid of validIds)
    io.to(`server:${sid}`).emit('permissions:updated', { serverId: sid, channelId: targetCid });
  res.json({ ok: true, updated: validIds.length });
});

// POST /bulk-sync/preview
router.post('/bulk-sync/preview', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { channelIds = [], overrides = [] } = req.body as { channelIds?: string[]; overrides?: OvrInput[] };
  if (!Array.isArray(channelIds) || channelIds.length === 0)
    return void res.status(400).json({ error: 'channelIds boş olamaz' });

  const targetChannels = await Channels.findWhere({ _id: { $in: channelIds }, serverId: sid }) || [];
  const validChannels  = targetChannels.filter(c => c._id !== cid);
  const srcRoleIds     = new Set(overrides.map(o => o.roleId));

  const preview = await Promise.all(validChannels.map(async ch => {
    const existing    = await ChannelPermissions.findByChannel(String(ch._id)) || [];
    const existingMap = new Map(existing.map(o => [o.roleId, o]));
    let added = 0, updated = 0, removed = 0, unchanged = 0;
    for (const ex of existing) if (!srcRoleIds.has(String(ex.roleId))) removed++;
    for (const ovr of overrides) {
      const ex = existingMap.get(ovr.roleId);
      if (!ex) added++;
      else if (ex.allow !== (ovr.allow ?? 0) || ex.deny !== (ovr.deny ?? 0)) updated++;
      else unchanged++;
    }
    return { channelId: ch._id, channelName: ch.name, channelType: ch.type || 'text', added, updated, removed, unchanged, totalChanges: added + updated + removed };
  }));

  res.json({
    preview,
    summary: {
      totalChannels: preview.length, channelsWithChanges: preview.filter(p => p.totalChanges > 0).length,
      totalAdded: preview.reduce((s, p) => s + p.added, 0), totalUpdated: preview.reduce((s, p) => s + p.updated, 0),
      totalRemoved: preview.reduce((s, p) => s + p.removed, 0),
    },
  });
});

// PUT /batch
router.put('/batch', authMiddleware, permWriteLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { overrides = [], deletes = [] } = req.body as { overrides?: OvrInput[]; deletes?: string[] };
  for (const ovr of overrides) {
    const a = Number(ovr.allow ?? 0), d = Number(ovr.deny ?? 0);
    if (!Number.isInteger(a) || a < 0 || !Number.isInteger(d) || d < 0)
      return void res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId})` });
    if ((a & d) !== 0)
      return void res.status(400).json({ error: `Çakışan bitmask (roleId=${ovr.roleId})` });
    const check = validateBitmask(a, d);
    if (!check.ok) return void res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId}): ${check.error}` });
  }

  const auditEntries: { roleId: string; action: string; oldVals: unknown; newVals: unknown; extra: object }[] = [];

  for (const ovr of overrides) {
    const { roleId, allow = 0, deny = 0, targetType, targetId, targetName } = ovr;
    const check = validateBitmask(Number(allow), Number(deny));
    if (!check.ok) return void res.status(400).json({ error: `Geçersiz bitmask: roleId=${roleId}: ${check.error}` });
    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
    auditEntries.push({ roleId, action: 'PERM_UPDATE', oldVals: existing ? { allow: existing.allow, deny: existing.deny } : null,
      newVals: { allow, deny }, extra: { targetType: targetType || 'role', targetName } });
    if (existing) {
      await ChannelPermissions.update({ channelId: cid, roleId }, { $set: { allow, deny, updatedAt: Date.now() } });
    } else {
      await ChannelPermissions.insert({ _id: uuidv4(), channelId: cid, roleId, serverId: sid, allow, deny,
        targetType: targetType ?? null, targetId: targetId ?? null, targetName: targetName ?? null, createdAt: Date.now() });
    }
  }
  for (const roleId of deletes) {
    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
    auditEntries.push({ roleId, action: 'PERM_DELETE', oldVals: existing ? { allow: existing.allow, deny: existing.deny } : null, newVals: null, extra: {} });
    await ChannelPermissions.remove({ channelId: cid, roleId });
  }

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  for (const entry of auditEntries) {
    await writePermAudit(sid, _u.id, cid, entry.roleId, entry.action, entry.oldVals, entry.newVals, { ...entry.extra as object, actorName });
  }
  if (auditEntries.length > 0) {
    const uc = auditEntries.filter(e => e.action === 'PERM_UPDATE').length;
    const dc = auditEntries.filter(e => e.action === 'PERM_DELETE').length;
    const parts: string[] = [];
    if (uc) parts.push(`${uc} güncelleme`);
    if (dc) parts.push(`${dc} silme`);
    await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName, `Toplu kayıt (${parts.join(', ')})`, null, null);
  }
  invalidatePerms(sid, null, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({ ok: true, saved: overrides.length, deleted: deletes.length });
});

// GET /export
router.get('/export', authMiddleware, permReadLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const overrides = await ChannelPermissions.findByChannel(cid) || [];
  const roles     = await Roles.findWhere({ serverId: sid }) || [];
  const channel   = await Channels.findById(cid);
  const server    = await Servers.findById(sid);
  const roleMap: Record<string, string> = Object.fromEntries(roles.map(r => [String(r._id), String(r.name)]));

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition',
    `attachment; filename="permissions-${(channel?.name || cid).replace(/[^a-z0-9]/gi, '_')}.json"`);
  res.json({
    version: 1, exportedAt: Date.now(), sourceServer: server?.name || sid, sourceChannel: channel?.name || cid,
    overrides: overrides.map(o => ({
      roleId: o.roleId, roleName: o.roleId === '__everyone__' ? '@everyone' : (roleMap[String(o.roleId)] || o.roleId),
      targetType: o.targetType || 'role', allow: o.allow, deny: o.deny,
    })),
  });
});

// POST /import
router.post('/import', authMiddleware, permWriteLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { overrides, merge = false } = req.body as { overrides?: OvrInput[]; merge?: boolean };
  if (!Array.isArray(overrides) || overrides.length === 0)
    return void res.status(400).json({ error: 'overrides dizisi boş olamaz' });

  for (const o of overrides) {
    if (typeof o.allow !== 'number' || typeof o.deny !== 'number')
      return void res.status(400).json({ error: 'Her override allow ve deny sayısı içermeli' });
    const check = validateBitmask(Number(o.allow), Number(o.deny));
    if (!check.ok) return void res.status(400).json({ error: `Import verisi geçersiz bitmask: ${check.error}` });
  }

  const serverRoles = await Roles.findWhere({ serverId: sid }) || [];
  const roleByName  = Object.fromEntries(serverRoles.map(r => [r.name.toLowerCase(), r._id]));
  const importedOverrides: object[] = [];
  const skippedUserOverrides: object[] = [];

  if (!merge) await ChannelPermissions.remove({ channelId: cid });

  for (const o of overrides) {
    if (o.targetType === 'user') {
      skippedUserOverrides.push({ roleId: o.roleId, roleName: o.roleName || o.roleId, targetType: 'user', allow: o.allow, deny: o.deny, reason: 'user override atlandı' });
      continue;
    }
    let resolvedRoleId = o.roleId;
    if (o.roleId !== '__everyone__' && o.roleName) {
      const byName = roleByName[o.roleName.toLowerCase()];
      if (byName) resolvedRoleId = byName;
      else if (!serverRoles.find(r => r._id === o.roleId)) continue;
    }
    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId: resolvedRoleId });
    if (existing) {
      await ChannelPermissions.update({ channelId: cid, roleId: resolvedRoleId }, { $set: { allow: o.allow, deny: o.deny, updatedAt: Date.now() } });
    } else {
      await ChannelPermissions.insert({ _id: uuidv4(), channelId: cid, roleId: resolvedRoleId, serverId: sid, allow: o.allow, deny: o.deny,
        targetType: o.targetType ?? 'role', targetId: null, targetName: o.roleName ?? null, createdAt: Date.now() });
    }
    importedOverrides.push({ roleId: resolvedRoleId, allow: o.allow, deny: o.deny });
  }

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  await writePermAudit(sid, _u.id, cid, '__import__', 'PERM_UPDATE', null, { importedCount: importedOverrides.length, merge }, { actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName, `İzin import (${importedOverrides.length} override, ${merge ? 'birleştir' : 'değiştir'})`, null, null);
  invalidatePerms(sid, null, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({
    ok: true, imported: importedOverrides.length, merge,
    ...(skippedUserOverrides.length > 0 && { skipped: skippedUserOverrides, skippedCount: skippedUserOverrides.length }),
  });
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
