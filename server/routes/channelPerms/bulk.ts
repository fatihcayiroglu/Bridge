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
import { evictSocketsWithoutChannelAccessBestEffort } from '../../lib/liveMembership';
import { Channels, ChannelPermissions, Roles, Servers, Users } from '../../db/repositories';
import { resolvePermissions, hasPermission, PERMS, validateBitmask } from '../../lib/permissions';
import { authMiddleware} from '../../middleware/auth';
import { invalidatePerms } from '../../lib/permCache';
import { permReadLimiter, permWriteLimiter, getIo, emitPermsUpdated, writePermAudit, sendPermLogMessage, assertChannelInServer, assertRoleInServer } from './helpers';

import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
interface _ChanRow  { _id: string; name: string; type?: string }
      // Kanonik semada olmayan sutunlar yazilmaz — bkz. overrides.ts'deki
      // ayrintili not. `channel_permissions` yalnizca allow/deny tutar;
      // targetType/targetId/targetName `roleId`den TURETILIR.
interface _PermRow  { _id: string; channelId: string; roleId: string; allow: number; deny: number; targetType?: string; targetId?: string; targetName?: string }
interface OvrInput { roleId: string; allow?: number; deny?: number; targetType?: string; targetId?: string; targetName?: string; roleName?: string }

function strictMasks(ovr: OvrInput): { allow: number; deny: number } | null {
  const allow = ovr.allow ?? 0, deny = ovr.deny ?? 0;
  if (typeof allow !== 'number' || typeof deny !== 'number' || !Number.isSafeInteger(allow) || !Number.isSafeInteger(deny)) return null;
  const check = validateBitmask(allow, deny);
  return check.ok ? { allow, deny } : null;
}
function hasDuplicateStrings(values: string[]): boolean { return new Set(values).size !== values.length; }
function requestBody(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const router: Router = express.Router({ mergeParams: true });

// POST /bulk-sync
router.post('/bulk-sync', authMiddleware, permWriteLimiter, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const cid = String(req.params.cid ?? '');
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });

  const { channelIds = [], overrides = [] } = requestBody(req.body) as { channelIds?: string[]; overrides?: OvrInput[] };
  if (!Array.isArray(channelIds) || channelIds.length === 0 || channelIds.some(id => typeof id !== 'string' || !id.trim()) || hasDuplicateStrings(channelIds))
    return void res.status(400).json({ error: 'channelIds benzersiz ve boş olmayan string değerler içermeli' });
  if (!Array.isArray(overrides)) return void res.status(400).json({ error: 'overrides bir dizi olmalı' });
  const roleIds = overrides.map(o => typeof o?.roleId === 'string' ? o.roleId : '');
  if (hasDuplicateStrings(roleIds)) return void res.status(400).json({ error: 'Aynı roleId birden fazla override içeremez' });
  const normalizedOverrides: Array<{ roleId: string; allow: number; deny: number }> = [];
  for (const ovr of overrides) {
    if (!ovr?.roleId || !await assertRoleInServer(ovr.roleId, sid))
      return void res.status(404).json({ error: `Role not found in this server: ${String(ovr?.roleId ?? '')}` });
    const masks = strictMasks(ovr);
    if (!masks) return void res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId})` });
    normalizedOverrides.push({ roleId: ovr.roleId, ...masks });
  }

  const requestedTargets = channelIds.filter(id => id !== cid);
  const targetChannels = requestedTargets.length ? await Channels.findWhere({ _id: { $in: requestedTargets }, serverId: sid }) || [] : [];
  const foundIds = new Set(targetChannels.map(c => String(c._id)));
  if (requestedTargets.some(id => !foundIds.has(id))) return void res.status(404).json({ error: 'Target channel not found in this server' });
  const validIds = requestedTargets;
  if (validIds.length && !await ChannelPermissions.replaceManyChannelsAtomic(sid, validIds, normalizedOverrides))
    return void res.status(404).json({ error: 'Target channel not found in this server' });
  for (const targetCid of validIds) {
    await writePermAudit(sid, _u.id, targetCid, '__bulk__', 'PERM_BULK_SYNC',
      null, { sourceChannelId: cid, overrideCount: overrides.length });
  }
  invalidatePerms(sid);
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, null);
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
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });

  const { channelIds = [], overrides = [] } = requestBody(req.body) as { channelIds?: string[]; overrides?: OvrInput[] };
  if (!Array.isArray(channelIds) || channelIds.length === 0 || channelIds.some(id => typeof id !== 'string' || !id.trim()) || hasDuplicateStrings(channelIds))
    return void res.status(400).json({ error: 'channelIds benzersiz ve boş olmayan string değerler içermeli' });
  if (!Array.isArray(overrides)) return void res.status(400).json({ error: 'overrides bir dizi olmalı' });
  const previewRoleIds = overrides.map(o => typeof o?.roleId === 'string' ? o.roleId : '');
  if (hasDuplicateStrings(previewRoleIds)) return void res.status(400).json({ error: 'Aynı roleId birden fazla override içeremez' });
  for (const ovr of overrides) {
    if (!ovr?.roleId || !await assertRoleInServer(ovr.roleId, sid))
      return void res.status(404).json({ error: `Role not found in this server: ${String(ovr?.roleId ?? '')}` });
    if (!strictMasks(ovr)) return void res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId})` });
  }

  const previewTargets = channelIds.filter(id => id !== cid);
  const targetChannels = previewTargets.length ? await Channels.findWhere({ _id: { $in: previewTargets }, serverId: sid }) || [] : [];
  const previewFound = new Set(targetChannels.map(c => String(c._id)));
  if (previewTargets.some(id => !previewFound.has(id))) return void res.status(404).json({ error: 'Target channel not found in this server' });
  const validChannels = targetChannels;
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
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });

  const { overrides = [], deletes = [] } = requestBody(req.body) as { overrides?: OvrInput[]; deletes?: string[] };
  if (!Array.isArray(overrides) || !Array.isArray(deletes)) return void res.status(400).json({ error: 'overrides ve deletes dizi olmalı' });
  if (deletes.some(roleId => typeof roleId !== 'string' || !roleId.trim()) || hasDuplicateStrings(deletes))
    return void res.status(400).json({ error: 'deletes benzersiz roleId stringleri içermeli' });
  const batchRoleIds = overrides.map(o => typeof o?.roleId === 'string' ? o.roleId : '');
  if (hasDuplicateStrings(batchRoleIds)) return void res.status(400).json({ error: 'Aynı roleId birden fazla override içeremez' });
  if (deletes.some(roleId => batchRoleIds.includes(roleId))) return void res.status(400).json({ error: 'Aynı roleId hem güncellenip hem silinemez' });
  for (const roleId of [...batchRoleIds, ...deletes]) {
    if (!roleId || !await assertRoleInServer(roleId, sid)) return void res.status(404).json({ error: `Role not found in this server: ${String(roleId ?? '')}` });
  }
  const batchWrites: Array<{ roleId: string; allow: number; deny: number }> = [];
  for (const ovr of overrides) {
    const masks = strictMasks(ovr);
    if (!masks) return void res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId})` });
    batchWrites.push({ roleId: ovr.roleId, ...masks });
  }

  const auditEntries: { roleId: string; action: string; oldVals: unknown; newVals: unknown; extra: object }[] = [];

  for (const ovr of overrides) {
    const masks = strictMasks(ovr)!;
    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId: ovr.roleId });
    auditEntries.push({ roleId: ovr.roleId, action: 'PERM_UPDATE', oldVals: existing ? { allow: existing.allow, deny: existing.deny } : null,
      newVals: masks, extra: { targetType: ovr.targetType || 'role', targetName: ovr.targetName } });
  }
  for (const roleId of deletes) {
    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
    auditEntries.push({ roleId, action: 'PERM_DELETE', oldVals: existing ? { allow: existing.allow, deny: existing.deny } : null, newVals: null, extra: {} });
  }
  if ((batchWrites.length || deletes.length) && !await ChannelPermissions.applyChannelBatchAtomic(sid, cid, batchWrites, deletes))
    return void res.status(404).json({ error: 'Channel not found in this server' });

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
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, cid);
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
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });

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
  if (!await assertChannelInServer(cid, sid))
    return void res.status(404).json({ error: 'Channel not found in this server' });

  const { overrides, merge = false } = requestBody(req.body) as { overrides?: OvrInput[]; merge?: boolean };
  if (typeof merge !== 'boolean') return void res.status(400).json({ error: 'merge boolean olmalı' });
  if (!Array.isArray(overrides) || overrides.length === 0)
    return void res.status(400).json({ error: 'overrides dizisi boş olamaz' });

  for (const raw of overrides as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return void res.status(400).json({ error: 'Her override nesne olmalı' });
    const o = raw as OvrInput;
    if (typeof o.roleId !== 'string' || !o.roleId.trim() || o.roleId.length > 128)
      return void res.status(400).json({ error: 'Her override geçerli roleId içermeli' });
    if (o.roleName !== undefined && (typeof o.roleName !== 'string' || o.roleName.length > 128))
      return void res.status(400).json({ error: 'roleName string olmalı' });
    if (o.targetType !== undefined && o.targetType !== 'role' && o.targetType !== 'user')
      return void res.status(400).json({ error: 'targetType role veya user olmalı' });
    if (typeof o.allow !== 'number' || typeof o.deny !== 'number' ||
        !Number.isSafeInteger(o.allow) || !Number.isSafeInteger(o.deny))
      return void res.status(400).json({ error: 'Her override allow ve deny güvenli tamsayı içermeli' });
    const check = validateBitmask(o.allow, o.deny);
    if (!check.ok) return void res.status(400).json({ error: `Import verisi geçersiz bitmask: ${check.error}` });
  }

  const serverRoles = await Roles.findWhere({ serverId: sid }) || [];
  const roleByName = Object.fromEntries(serverRoles
    .filter(r => typeof r?.name === 'string' && typeof r?._id === 'string')
    .map(r => [String(r.name).toLowerCase(), r._id]));
  const importedOverrides: object[] = [];
  const skippedUserOverrides: object[] = [];
  const skippedRoleOverrides: object[] = [];

  for (const o of overrides) {
    if (o.targetType === 'user') {
      skippedUserOverrides.push({ roleId: o.roleId, roleName: o.roleName || o.roleId, targetType: 'user', allow: o.allow, deny: o.deny, reason: 'user override atlandı' });
      continue;
    }
    let resolvedRoleId = o.roleId;
    if (o.roleId !== '__everyone__' && o.roleName) {
      const byName = roleByName[o.roleName.toLowerCase()];
      if (byName) resolvedRoleId = byName;
    }
    if (!resolvedRoleId || !await assertRoleInServer(String(resolvedRoleId), sid)) {
      skippedRoleOverrides.push({ roleId: o.roleId, roleName: o.roleName || o.roleId, targetType: o.targetType || 'role', reason: 'role not found in this server' });
      continue;
    }
    if (importedOverrides.some(row => (row as { roleId?: unknown }).roleId === resolvedRoleId))
      return void res.status(400).json({ error: `Import aynı hedef role birden fazla override eşliyor: ${resolvedRoleId}` });
    importedOverrides.push({ roleId: resolvedRoleId, allow: o.allow, deny: o.deny });
  }

  if (!merge && importedOverrides.length === 0)
    return void res.status(400).json({ error: 'Import uygulanabilir hiçbir override içermiyor; mevcut izinler korunuyor', skipped: [...skippedUserOverrides, ...skippedRoleOverrides] });
  const importWrites = importedOverrides as Array<{ roleId: string; allow: number; deny: number }>;
  const importOk = merge
    ? await ChannelPermissions.applyChannelBatchAtomic(sid, cid, importWrites, [])
    : await ChannelPermissions.replaceManyChannelsAtomic(sid, [cid], importWrites);
  if (!importOk) return void res.status(404).json({ error: 'Channel not found in this server' });

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  await writePermAudit(sid, _u.id, cid, '__import__', 'PERM_UPDATE', null, { importedCount: importedOverrides.length, merge }, { actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName, `İzin import (${importedOverrides.length} override, ${merge ? 'birleştir' : 'değiştir'})`, null, null);
  invalidatePerms(sid, null, cid);
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, cid);
  emitPermsUpdated(req, sid, cid);
  const skipped = [...skippedUserOverrides, ...skippedRoleOverrides];
  res.json({
    ok: true, imported: importedOverrides.length, merge,
    ...(skipped.length > 0 && { skipped, skippedCount: skipped.length }),
  });
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
