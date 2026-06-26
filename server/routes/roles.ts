// server/routes/roles.ts
// PERMS, hasPermission, getMemberPerms burada backward-compat için tutulur.
// Yeni kod için: require('../lib/permissions') kullan
import express, { Request, Response, Router } from 'express';
import { authMiddleware} from '../middleware/auth';

import { Members, Roles, Servers } from '../db/repositories';
import { PERMS, hasPermission, hasAnyPermission, resolvePermissions, canActOn, logAudit } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';
import { invalidatePerms } from '../lib/permCache';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
interface RoleRow { _id: string; serverId: string; name: string; color: string; permissions: number; position: number }
interface MemberRow { _id: string; roles?: string[] }

async function getMemberPerms(userId: string, serverId: string): Promise<number> {
  return resolvePermissions(userId, serverId);
}

function sanitizeColor(color: unknown): string {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  return '#99aab5';
}


function normalizeRoleIds(value: string | string[] | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return value ? [value] : [];
  }
}

const router: Router = express.Router();

/**
 * @openapi
 * /servers/{sid}/roles:
 *   get:
 *     tags: [Roles]
 *     summary: Sunucu rolleri listele
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Rol listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Role' }
 */
router.get('/:sid/roles', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!membership) return void res.status(403).json({ error: 'Not a member' });
  res.json(await Roles.findByServer(String(req.params.sid ?? '')));
});

/**
 * @openapi
 * /servers/{sid}/roles:
 *   post:
 *     tags: [Roles]
 *     summary: Rol oluştur
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
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               color: { type: string }
 *               permissions: { type: integer }
 *     responses:
 *       201:
 *         description: Rol oluşturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Role' }
 */
router.post('/:sid/roles', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const { name, color, permissions } = req.body as { name?: string; color?: string; permissions?: unknown };
  if (!name?.trim()) return void res.status(400).json({ error: 'Role name required' });

  const role = await Roles.insert({
    serverId:    String(req.params.sid ?? ''),
    name:        name.trim().slice(0, 32),
    color:       sanitizeColor(color),
    permissions: parseInt(String(permissions ?? '')) || PERMS.SEND_MESSAGES,
    position:    0,
  });
  res.json(role);
});

/**
 * @openapi
 * /servers/{sid}/roles/{rid}:
 *   patch:
 *     tags: [Roles]
 *     summary: Rol güncelle
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               color: { type: string }
 *               permissions: { type: integer }
 *     responses:
 *       200:
 *         description: Güncellenmiş rol
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Role' }
 */
router.patch('/:sid/roles/:rid', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const { name, color, permissions } = req.body as { name?: string; color?: string; permissions?: unknown };
  const updates: Record<string, unknown> = {};
  if (name?.trim())              updates['name']        = name.trim().slice(0, 32);
  if (color)                     updates['color']       = sanitizeColor(color);
  if (permissions !== undefined) updates['permissions'] = parseInt(String(permissions));

  await Roles.update(String(req.params.rid ?? ''), String(req.params.sid ?? ''), updates);
  const updated = await Roles.findById(String(req.params.rid ?? ''));
  invalidatePerms(String(req.params.sid ?? ''));
  res.json(updated);
});

/**
 * @openapi
 * /servers/{sid}/roles/{rid}:
 *   delete:
 *     tags: [Roles]
 *     summary: Rol sil
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Rol silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/:sid/roles/:rid', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });
  await Roles.delete(String(req.params.rid ?? ''), String(req.params.sid ?? ''));
  invalidatePerms(String(req.params.sid ?? ''));
  res.json({ deleted: true });
});

/**
 * @openapi
 * /servers/{sid}/members/{uid}/roles:
 *   post:
 *     tags: [Roles]
 *     summary: Üyeye rol ata
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [roleId]
 *             properties:
 *               roleId: { type: string }
 *     responses:
 *       200: { description: Rol atandı }
 */
router.post('/:sid/members/:uid/roles', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const { roleId } = req.body as { roleId?: string };
  if (!roleId) return void res.status(400).json({ error: 'roleId required' });

  const role = await Roles.findByIdAndServer(roleId, String(req.params.sid ?? ''));
  if (!role) return void res.status(404).json({ error: 'Role not found in this server' });

  const membership = await Members.findOne(String(req.params.uid ?? ''), String(req.params.sid ?? ''));
  if (!membership) return void res.status(404).json({ error: 'Member not found' });

  const roles = normalizeRoleIds(membership.roles);
  if (!roles.includes(roleId)) roles.push(roleId);
  await Members.setRoles(String(req.params.uid ?? ''), String(req.params.sid ?? ''), roles);
  invalidatePerms(String(req.params.sid ?? ''), String(req.params.uid ?? ''));
  res.json({ roles });
});

/**
 * @openapi
 * /servers/{sid}/members/{uid}/roles/{rid}:
 *   delete:
 *     tags: [Roles]
 *     summary: Üyeden rol kaldır
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Rol kaldırıldı }
 */
router.delete('/:sid/members/:uid/roles/:rid', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const membership = await Members.findOne(String(req.params.uid ?? ''), String(req.params.sid ?? ''));
  if (!membership) return void res.status(404).json({ error: 'Member not found' });

  const roles = normalizeRoleIds(membership.roles).filter((r: string) => r !== String(req.params.rid ?? ''));
  await Members.setRoles(String(req.params.uid ?? ''), String(req.params.sid ?? ''), roles);
  invalidatePerms(String(req.params.sid ?? ''), String(req.params.uid ?? ''));
  res.json({ roles });
});

/**
 * @openapi
 * /servers/{sid}/members/{uid}/kick:
 *   post:
 *     tags: [Roles, Moderation]
 *     summary: Üyeyi sunucudan at
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Üye atıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/:sid/members/:uid/kick', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.KICK_MEMBERS))
    return void res.status(403).json({ error: 'Missing permission: KICK_MEMBERS' });
  if (String(req.params.uid ?? '') === _u.id)
    return void res.status(400).json({ error: 'Cannot kick yourself' });

  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (String(req.params.uid ?? '') === server?.ownerId)
    return void res.status(403).json({ error: 'Cannot kick server owner' });

  await Members.remove(String(req.params.uid ?? ''), String(req.params.sid ?? ''));
  res.json({ kicked: true });
});

export { router, getMemberPerms, hasPermission, PERMS, resolvePermissions, canActOn, logAudit };
export default router;
