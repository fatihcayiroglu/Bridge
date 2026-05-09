// @ts-nocheck
// server/routes/roles.js
// PERMS, hasPermission, getMemberPerms burada backward-compat için tutulur.
// Yeni kod için: require('../lib/permissions') kullan
const express    = require('express');
const router     = express.Router();
const { Members, Roles, Servers } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// lib/permissions'dan re-export — tüm eski require('./roles') çağrıları çalışır
const {
  PERMS,
  hasPermission,
  hasAnyPermission,
  resolvePermissions,
  canActOn,
  logAudit,
} = require('../lib/permissions');
const { limits } = require('../middleware/rateLimit'); // rate limiting

const { invalidatePerms } = require('../lib/permCache');

// getMemberPerms — backward compat wrapper (yeni kod: resolvePermissions kullan)
async function getMemberPerms(userId, serverId) {
  return resolvePermissions(userId, serverId);
}

// FIX: validate hex color to prevent CSS injection via role color
function sanitizeColor(color) {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  return '#99aab5';
}

// GET /api/servers/:sid/roles
router.get('/:sid/roles', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, req.params.sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const roles = await Roles.findByServer(req.params.sid);
  res.json(roles);
}));

// POST /api/servers/:sid/roles
router.post('/:sid/roles', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const { name, color, permissions } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Role name required' });

  const role = await Roles.insert({
    serverId:    req.params.sid,
    name:        name.trim().slice(0, 32),
    color:       sanitizeColor(color),
    permissions: parseInt(permissions) || PERMS.SEND_MESSAGES,
    position:    0,
  });
  res.json(role);
}));

// PATCH /api/servers/:sid/roles/:rid
router.patch('/:sid/roles/:rid', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const { name, color, permissions } = req.body;
  const updates: Record<string,any> = {};
  if (name?.trim())            updates.name        = name.trim().slice(0, 32);
  if (color)                   updates.color       = sanitizeColor(color);
  if (permissions !== undefined) updates.permissions = parseInt(permissions);

  await Roles.update(req.params.rid, req.params.sid, updates);
  const updated = await Roles.findById(req.params.rid);

  // Rol izinleri değişti — sunucu geneli önbelleği temizle
  invalidatePerms(req.params.sid);

  res.json(updated);
}));

// DELETE /api/servers/:sid/roles/:rid
router.delete('/:sid/roles/:rid', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  await Roles.delete(req.params.rid, req.params.sid);

  // Rol silindi — sunucu geneli önbelleği temizle
  invalidatePerms(req.params.sid);

  res.json({ deleted: true });
}));

// POST /api/servers/:sid/members/:uid/roles
router.post('/:sid/members/:uid/roles', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const { roleId } = req.body;
  if (!roleId) return res.status(400).json({ error: 'roleId required' });

  const role = await Roles.findByIdAndServer(roleId, req.params.sid);
  if (!role) return res.status(404).json({ error: 'Role not found in this server' });

  const membership = await Members.findOne(req.params.uid, req.params.sid);
  if (!membership) return res.status(404).json({ error: 'Member not found' });

  const roles = membership.roles || [];
  if (!roles.includes(roleId)) roles.push(roleId);
  await Members.setRoles(req.params.uid, req.params.sid, roles);

  // Kullanıcının rolleri değişti — sadece o kullanıcının önbelleğini temizle
  invalidatePerms(req.params.sid, req.params.uid);

  res.json({ roles });
}));

// DELETE /api/servers/:sid/members/:uid/roles/:rid
router.delete('/:sid/members/:uid/roles/:rid', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const membership = await Members.findOne(req.params.uid, req.params.sid);
  if (!membership) return res.status(404).json({ error: 'Member not found' });

  const roles = (membership.roles || []).filter(r => r !== req.params.rid);
  await Members.setRoles(req.params.uid, req.params.sid, roles);

  // Kullanıcının rolleri değişti — sadece o kullanıcının önbelleğini temizle
  invalidatePerms(req.params.sid, req.params.uid);

  res.json({ roles });
}));

// POST /api/servers/:sid/members/:uid/kick
router.post('/:sid/members/:uid/kick', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.KICK_MEMBERS))
    return res.status(403).json({ error: 'Missing permission: KICK_MEMBERS' });

  if (req.params.uid === _u.id)
    return res.status(400).json({ error: 'Cannot kick yourself' });

  const server = await Servers.findById(req.params.sid);
  if (req.params.uid === server.ownerId)
    return res.status(403).json({ error: 'Cannot kick server owner' });

  await Members.remove(req.params.uid, req.params.sid);
  res.json({ kicked: true });
}));

module.exports = { router, getMemberPerms, hasPermission, PERMS, resolvePermissions, canActOn, logAudit };
