// @ts-nocheck
// server/routes/channelPerms/bulk.js.1 (PG-compat patch)
// Toplu işlemler: bulk-sync, batch PUT, export, import
// FIXED: _sqlite transaction blocks replaced with PG-compatible async db calls
'use strict';

const express      = require('express');
const router       = express.Router({ mergeParams: true });
const { Channels, ChannelPermissions, Roles, Servers, Users } = require('../../db/repositories');
const { authMiddleware, castAuthed } = require('../../middleware/auth');
const { resolvePermissions, hasPermission, PERMS, validateBitmask } = require('../../lib/permissions');
const { invalidatePerms } = require('../../lib/permCache');
const asyncHandler = require('../../middleware/asyncHandler');
const { v4: uuidv4 } = require('uuid');
const {
  permReadLimiter, permWriteLimiter, getIo,
  emitPermsUpdated, writePermAudit, sendPermLogMessage,
} = require('./helpers');

// POST /bulk-sync — Bu kanalın izin ayarlarını belirtilen kanallara uygular
router.post('/bulk-sync', authMiddleware, permWriteLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { channelIds = [], overrides = [] } = req.body;
  if (!Array.isArray(channelIds) || channelIds.length === 0)
    return res.status(400).json({ error: 'channelIds boş olamaz' });

  const targetChannels = await Channels.findWhere({ _id: { $in: channelIds }, serverId: sid }) || [];
  if (targetChannels.length === 0)
    return res.status(400).json({ error: 'Geçerli kanal bulunamadı' });

  const validIds = targetChannels.map(c => c._id).filter(id => id !== cid);

  // PG-compatible: sequential async ops (no _sqlite.transaction)
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

  // Birden fazla kanal etkilendi — sunucu geneli önbelleği temizle
  invalidatePerms(sid);

  const io = getIo(req);
  if (io) {
    for (const targetCid of validIds) {
      io.to(`server:${sid}`).emit('permissions:updated', { serverId: sid, channelId: targetCid });
    }
  }

  res.json({ ok: true, updated: validIds.length });
}));

// POST /bulk-sync/preview — Diff özeti döner (kaydet yapmaz)
router.post('/bulk-sync/preview', authMiddleware, permReadLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { channelIds = [], overrides = [] } = req.body;
  if (!Array.isArray(channelIds) || channelIds.length === 0)
    return res.status(400).json({ error: 'channelIds boş olamaz' });

  const targetChannels = await Channels.findWhere({ _id: { $in: channelIds }, serverId: sid }) || [];
  const validChannels  = targetChannels.filter(c => c._id !== cid);
  const srcRoleIds     = new Set(overrides.map(o => o.roleId));

  const preview = await Promise.all(validChannels.map(async ch => {
    const existing    = await ChannelPermissions.findByChannel(ch._id) || [];
    const existingMap = new Map(existing.map(o => [o.roleId, o]));
    let added = 0, updated = 0, removed = 0, unchanged = 0;

    for (const ex of existing) {
      if (!srcRoleIds.has(ex.roleId)) removed++;
    }
    for (const ovr of overrides) {
      const ex = existingMap.get(ovr.roleId);
      if (!ex)                                                              added++;
      else if (ex.allow !== (ovr.allow ?? 0) || ex.deny !== (ovr.deny ?? 0)) updated++;
      else                                                                   unchanged++;
    }

    return {
      channelId: ch._id, channelName: ch.name, channelType: ch.type || 'text',
      added, updated, removed, unchanged, totalChanges: added + updated + removed,
    };
  }));

  res.json({
    preview,
    summary: {
      totalChannels:       preview.length,
      channelsWithChanges: preview.filter(p => p.totalChanges > 0).length,
      totalAdded:    preview.reduce((s, p) => s + p.added,   0),
      totalUpdated:  preview.reduce((s, p) => s + p.updated, 0),
      totalRemoved:  preview.reduce((s, p) => s + p.removed, 0),
    },
  });
}));

// PUT /batch — N override'ı tek HTTP isteğiyle kaydet
router.put('/batch', authMiddleware, permWriteLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { overrides = [], deletes = [] } = req.body;
  if (!Array.isArray(overrides) && !Array.isArray(deletes))
    return res.status(400).json({ error: 'overrides veya deletes dizisi gerekli' });

  // Bitmask validation — I/O gerektirmez, önce yapılır
  for (const ovr of overrides) {
    const a = Number(ovr.allow ?? 0);
    const d = Number(ovr.deny  ?? 0);
    if (!Number.isInteger(a) || a < 0 || !Number.isInteger(d) || d < 0)
      return res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId}): sayısal tam sayı olmalı` });
    if ((a & d) !== 0)
      return res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId}): allow ve deny aynı biti içeremez` });
    if (validateBitmask) {
      const check = validateBitmask(a, d);
      if (!check.ok)
        return res.status(400).json({ error: `Geçersiz bitmask (roleId=${ovr.roleId}): ${check.error}` });
    }
  }

  const auditEntries = [];

  // PG-compatible: async upsert/delete per override
  for (const ovr of overrides) {
    const { roleId, allow = 0, deny = 0, targetType, targetId, targetName } = ovr;
    const bitmaskCheck = validateBitmask(Number(allow), Number(deny));
    if (!bitmaskCheck.ok)
      return res.status(400).json({ error: `Geçersiz bitmask: roleId=${roleId}: ${bitmaskCheck.error}` });

    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
    const oldVals  = existing ? { allow: existing.allow, deny: existing.deny } : null;
    auditEntries.push({ roleId, action: 'PERM_UPDATE', oldVals, newVals: { allow, deny },
      extra: { targetType: targetType || 'role', targetName } });

    if (existing) {
      await ChannelPermissions.update({ channelId: cid, roleId }, { $set: { allow, deny, updatedAt: Date.now() } });
    } else {
      await ChannelPermissions.insert({
        _id: uuidv4(), channelId: cid, roleId, serverId: sid,
        allow, deny, targetType: targetType ?? null, targetId: targetId ?? null,
        targetName: targetName ?? null, createdAt: Date.now(),
      });
    }
  }

  for (const roleId of deletes) {
    const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
    auditEntries.push({ roleId, action: 'PERM_DELETE',
      oldVals: existing ? { allow: existing.allow, deny: existing.deny } : null,
      newVals: null, extra: {} });
    await ChannelPermissions.remove({ channelId: cid, roleId });
  }

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;

  for (const entry of auditEntries) {
    await writePermAudit(sid, _u.id, cid, entry.roleId, entry.action,
      entry.oldVals, entry.newVals, { ...entry.extra, actorName });
  }

  if (auditEntries.length > 0) {
    const updateCount = auditEntries.filter(e => e.action === 'PERM_UPDATE').length;
    const deleteCount = auditEntries.filter(e => e.action === 'PERM_DELETE').length;
    const parts = [];
    if (updateCount) parts.push(`${updateCount} güncelleme`);
    if (deleteCount) parts.push(`${deleteCount} silme`);
    await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName,
      `Toplu kayıt (${parts.join(', ')})`, null, null);
  }

  invalidatePerms(sid, null, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({ ok: true, saved: overrides.length, deleted: deletes.length });
}));

// GET /export — Override'ları JSON olarak indir
router.get('/export', authMiddleware, permReadLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const overrides = await ChannelPermissions.findByChannel(cid) || [];
  const roles     = await Roles.findWhere({ serverId: sid }) || [];
  const channel   = await Channels.findById(cid);
  const server    = await Servers.findById(sid);
  const roleMap   = Object.fromEntries(roles.map(r => [r._id, r.name]));

  const exportData = {
    version: 1, exportedAt: Date.now(),
    sourceServer:  server?.name  || sid,
    sourceChannel: channel?.name || cid,
    overrides: overrides.map(o => ({
      roleId:     o.roleId,
      roleName:   o.roleId === '__everyone__' ? '@everyone' : (roleMap[o.roleId] || o.roleId),
      targetType: o.targetType || 'role',
      allow:      o.allow,
      deny:       o.deny,
    })),
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition',
    `attachment; filename="permissions-${(channel?.name || cid).replace(/[^a-z0-9]/gi, '_')}.json"`);
  res.json(exportData);
}));

// POST /import — JSON'dan override yükle
router.post('/import', authMiddleware, permWriteLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { overrides, merge = false } = req.body;
  if (!Array.isArray(overrides) || overrides.length === 0)
    return res.status(400).json({ error: 'overrides dizisi boş olamaz' });

  for (const o of overrides) {
    if (typeof o.allow !== 'number' || typeof o.deny !== 'number')
      return res.status(400).json({ error: 'Her override allow ve deny sayısı içermeli' });
    const bitmaskCheck = validateBitmask(Number(o.allow), Number(o.deny));
    if (!bitmaskCheck.ok)
      return res.status(400).json({ error: `Import verisi geçersiz bitmask içeriyor: ${bitmaskCheck.error}` });
  }

  const serverRoles = await Roles.findWhere({ serverId: sid }) || [];
  const roleByName  = Object.fromEntries(serverRoles.map(r => [r.name.toLowerCase(), r._id]));
  const importedOverrides = [];
  const skippedUserOverrides = [];

  // PG-compatible: async ops instead of _sqlite.transaction
  if (!merge) {
    await ChannelPermissions.remove({ channelId: cid });
  }

  for (const o of overrides) {
    if (o.targetType === 'user') {
      skippedUserOverrides.push({
        roleId: o.roleId, roleName: o.roleName || o.roleId,
        targetType: 'user', allow: o.allow, deny: o.deny,
        reason: 'user override cross-server import sırasında atlandı',
      });
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
      await ChannelPermissions.update(
        { channelId: cid, roleId: resolvedRoleId },
        { $set: { allow: o.allow, deny: o.deny, updatedAt: Date.now() } },
      );
    } else {
      await ChannelPermissions.insert({
        _id: uuidv4(), channelId: cid, roleId: resolvedRoleId, serverId: sid,
        allow: o.allow, deny: o.deny, targetType: o.targetType ?? 'role',
        targetId: null, targetName: o.roleName ?? null, createdAt: Date.now(),
      });
    }
    importedOverrides.push({ roleId: resolvedRoleId, allow: o.allow, deny: o.deny });
  }

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  await writePermAudit(sid, _u.id, cid, '__import__', 'PERM_UPDATE',
    null, { importedCount: importedOverrides.length, merge },
    { actorName, targetName: `Import (${importedOverrides.length} override)` });
  await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName,
    `İzin import (${importedOverrides.length} override, ${merge ? 'birleştir' : 'değiştir'})`, null, null);

  invalidatePerms(sid, null, cid);
  emitPermsUpdated(req, sid, cid);

  res.json({
    ok: true, imported: importedOverrides.length, merge,
    ...(skippedUserOverrides.length > 0 && {
      skipped: skippedUserOverrides,
      skippedCount: skippedUserOverrides.length,
      skippedWarning: `${skippedUserOverrides.length} kullanıcı override'ı cross-server import sırasında atlandı — kullanıcı ID'leri sunucular arasında eşleşmez.`,
    }),
  });
}));

module.exports = router;
