// @ts-nocheck
// server/routes/channelPerms/overrides.js.1
// Tek kanal override CRUD + audit-log okuma + kalıtım görselleştirme
'use strict';

const express      = require('express');
const router       = express.Router({ mergeParams: true });
const { ChannelPermissions, Roles, Users, Auth } = require('../../db/repositories');
const { authMiddleware, castAuthed } = require('../../middleware/auth');
const { resolvePermissions, hasPermission, PERMS, validateBitmask, DEFAULT_PERMISSIONS } = require('../../lib/permissions');
const { invalidatePerms } = require('../../lib/permCache');
const asyncHandler = require('../../middleware/asyncHandler');
const { v4: uuidv4 } = require('uuid');
const {
  permReadLimiter, permWriteLimiter,
  emitPermsUpdated, writePermAudit, sendPermLogMessage,
} = require('./helpers');

// GET /api/servers/:sid/channels/:cid/permissions
router.get('/', authMiddleware, permReadLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const overrides = await ChannelPermissions.findByChannel(cid) || [];
  const roles     = await Roles.findWhere({ serverId: sid }) || [];
  res.json({ overrides, roles });
}));

// GET /api/servers/:sid/channels/:cid/permissions/audit-log
// Query params: action, targetId, since (ms), until (ms), limit (max 200)
router.get('/audit-log', authMiddleware, permReadLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { action, targetId, since, until, limit: limitParam } = req.query;
  const limit = Math.min(parseInt(limitParam) || 100, 200);

  const query = { serverId: sid, channelId: cid };
  if (action)   query.action   = action;
  if (targetId) query.targetId = targetId;
  if (since || until) {
    query.createdAt = {};
    if (since) query.createdAt.$gte = parseInt(since);
    if (until) query.createdAt.$lte = parseInt(until);
  }

  let logs = await Auth.auditLogsFind(query).sort({ createdAt: -1 }).limit(limit).catch(() => []) || [];
  if (!Array.isArray(logs)) logs = await logs || [];

  const actorIds = [...new Set(logs.map(l => l.actorId).filter(Boolean))];
  const actors   = actorIds.length ? await Users.findByIds(actorIds) || [] : [];
  const actorMap = Object.fromEntries(actors.map(u => [u._id, u.username || u.displayName || u._id]));

  const roleIds = [...new Set(logs.map(l => l.targetId).filter(id => id && id !== '__everyone__'))];
  const roleRows = roleIds.length ? await Roles.findWhere({ _id: { $in: roleIds } }) || [] : [];
  const roleMap = Object.fromEntries(roleRows.map(r => [r._id, r.name]));

  const enriched = logs.map(l => {
    let oldVal = l.old, newVal = l.new;
    if (typeof l.old === 'string') { try { oldVal = JSON.parse(l.old); } catch { oldVal = null; } }
    if (typeof l.new === 'string') { try { newVal = JSON.parse(l.new); } catch { newVal = null; } }
    return {
      ...l,
      old:        oldVal,
      new:        newVal,
      actorName:  actorMap[l.actorId]  || l.actorName || l.actorId,
      targetName: l.targetId === '__everyone__' ? '@everyone' : (roleMap[l.targetId] || l.targetName || l.targetId),
    };
  });

  res.json({
    logs: enriched,
    hasMore: logs.length === limit,
    nextCursor: logs.length === limit ? logs[logs.length - 1].createdAt : null,
  });
}));

// PUT /api/servers/:sid/channels/:cid/permissions/:roleId
router.put('/:roleId', authMiddleware, permWriteLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid, roleId } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { allow = 0, deny = 0, targetType, targetId, targetName } = req.body;

  const bitmaskCheck = validateBitmask(Number(allow), Number(deny));
  if (!bitmaskCheck.ok)
    return res.status(400).json({ error: `Geçersiz bitmask: ${bitmaskCheck.error}` });

  const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
  const oldVals  = existing ? { allow: existing.allow, deny: existing.deny } : null;

  if (existing) {
    await ChannelPermissions.update(
      { channelId: cid, roleId },
      { $set: { allow, deny, updatedAt: Date.now() } }
    );
  } else {
    await ChannelPermissions.insert({
      _id: uuidv4(), channelId: cid, roleId, serverId: sid,
      allow, deny,
      ...(targetType && { targetType }),
      ...(targetId   && { targetId }),
      ...(targetName && { targetName }),
      createdAt: Date.now(),
    });
  }

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  await writePermAudit(sid, _u.id, cid, roleId, 'PERM_UPDATE', oldVals, { allow, deny },
    { targetType: targetType || 'role', targetName, actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_UPDATE', actorName, targetName || roleId, oldVals, { allow, deny });

  invalidatePerms(sid, null, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({ ok: true });
}));

// DELETE /api/servers/:sid/channels/:cid/permissions/:roleId
router.delete('/:roleId', authMiddleware, permWriteLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid, roleId } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const existing = await ChannelPermissions.findOne({ channelId: cid, roleId });
  await ChannelPermissions.remove({ channelId: cid, roleId }, {});

  const actorUser = await Users.findById(_u.id);
  const actorName = actorUser?.displayName || actorUser?.username || _u.id;
  const oldVals   = existing ? { allow: existing.allow, deny: existing.deny } : null;

  await writePermAudit(sid, _u.id, cid, roleId, 'PERM_DELETE', oldVals, null, { actorName });
  await sendPermLogMessage(req, sid, cid, 'PERM_DELETE', actorName, roleId, oldVals, null);

  invalidatePerms(sid, null, cid);
  emitPermsUpdated(req, sid, cid);
  res.json({ ok: true });
}));

// GET /api/servers/:sid/channels/:cid/permissions/inheritance/:roleId
router.get('/inheritance/:roleId', authMiddleware, permReadLimiter, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, cid, roleId } = req.params;
  const perms = await resolvePermissions(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { PERMS: PERM_FLAGS } = require('../../lib/permissions');

  let roleName  = '@everyone';
  let rolePerms = 0;
  let isUser    = false;

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
  const ALL_BITS = Object.values(PERM_FLAGS).filter(v => Number.isInteger(v) && v !== PERM_FLAGS.ADMINISTRATOR);
  const bitSources = {};

  for (const bit of ALL_BITS) {
    const fromRole    = !isUser && (rolePerms & bit) !== 0;
    const fromDefault = (DEFAULT_PERMISSIONS & bit) !== 0;

    if (override) {
      if      ((override.allow & bit) !== 0) bitSources[bit] = { source: 'channel_override', state: 'allow', label: 'Kanal override (izin veriliyor)' };
      else if ((override.deny  & bit) !== 0) bitSources[bit] = { source: 'channel_override', state: 'deny',  label: 'Kanal override (reddediliyor)' };
      else if (fromRole)                     bitSources[bit] = { source: 'role',           state: 'allow', label: `Rol: ${roleName}` };
      else if (fromDefault)                  bitSources[bit] = { source: 'server_default', state: 'allow', label: 'Sunucu varsayılanı' };
      else                                   bitSources[bit] = { source: 'none',           state: 'deny',  label: 'Hiçbir kaynaktan verilmemiş' };
    } else if (fromRole)    bitSources[bit] = { source: 'role',           state: 'allow', label: `Rol: ${roleName}` };
    else if   (fromDefault) bitSources[bit] = { source: 'server_default', state: 'allow', label: 'Sunucu varsayılanı' };
    else                    bitSources[bit] = { source: 'none',           state: 'deny',  label: 'Hiçbir kaynaktan verilmemiş' };
  }

  res.json({
    roleId, roleName, isUser,
    hasOverride: !!override,
    override:    override ? { allow: override.allow, deny: override.deny } : null,
    rolePermissions: rolePerms,
    serverDefault:   DEFAULT_PERMISSIONS,
    bitSources,
  });
}));

module.exports = router;
export {};
