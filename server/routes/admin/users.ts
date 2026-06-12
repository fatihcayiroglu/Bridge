// server/routes/admin/users.ts
// Sprint 105: admin/core.ts'den ayrıştırıldı — Kullanıcı & Sunucu yönetimi
// GET  /api/admin/users
// PATCH /api/admin/users/:id
// DELETE /api/admin/users/:id
// GET  /api/admin/servers
// DELETE /api/admin/servers/:id

/**
 * @openapi
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: Kullanıcıları listele (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: q, in: query, schema: { type: string }, description: Arama sorgusu }
 *       - { name: page, in: query, schema: { type: integer, default: 1 } }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       200: { description: Kullanıcı listesi }
 *       403: { description: Admin yetkisi gerekli }
 * /admin/users/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Kullanıcıyı güncelle (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Kullanıcı güncellendi }
 *   delete:
 *     tags: [Admin]
 *     summary: Kullanıcıyı sil (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Kullanıcı silindi }
 * /admin/servers:
 *   get:
 *     tags: [Admin]
 *     summary: Sunucuları listele (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Sunucu listesi }
 * /admin/servers/{id}:
 *   delete:
 *     tags: [Admin]
 *     summary: Sunucuyu sil (admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Sunucu silindi }
 */

import express, { Request, Response } from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
export const usersRouter = express.Router();
import { Users, Servers, Members, Messages, Channels, Roles, Auth } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { adminOnly, logAction } from './middleware';

// ── GET /api/admin/users ───────────────────────────────────────
usersRouter.get('/users', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const q      = String(req.query.q      ?? '');
  const page   = String(req.query.page   ?? '1');
  const limit  = String(req.query.limit  ?? '50');
  const pageNum  = Math.max(1, parseInt(page)  || 1);
  const limitNum = Math.min(100, parseInt(limit) || 50);
  const offset   = (pageNum - 1) * limitNum;

  let query: Record<string, unknown> = {};
  if (q.trim()) {
    query = { $or: [
      { username:    { $regex: q.trim() } },
      { displayName: { $regex: q.trim() } },
      { email:       { $regex: q.trim() } },
    ]};
  }

  const total = await Users.count(query);
  const users = (await Users.searchPaginated(query, { skip: offset, limit: limitNum }))
    .map(u => ({
      _id: u._id, username: u.username, displayName: u.displayName,
      email: u.email || null, emailVerified: u.emailVerified || false,
      isAdmin: u.isAdmin || false, twoFactorEnabled: u.twoFactorEnabled || false,
      status: u.status, createdAt: u.createdAt,
    }));

  res.json({ users, total, page: pageNum, pages: Math.ceil(total / limitNum) });
});

// ── PATCH /api/admin/users/:id ─────────────────────────────────
usersRouter.patch('/users/:id', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { isAdmin } = req.body as Record<string, string>;
  const target = await Users.findById(String(req.params.id ?? ''));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot modify yourself' });

  const updates: Record<string, unknown> = {};
  if (typeof isAdmin === 'boolean') updates.isAdmin = isAdmin ? 1 : 0;
  if (Object.keys(updates).length) {
    await Users.update(target._id, updates);
    await logAction(_u.id, 'update_user', target._id, { updates });
  }
  res.json({ ok: true });
});

// ── DELETE /api/admin/users/:id ────────────────────────────────
usersRouter.delete('/users/:id', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const target = await Users.findById(String(req.params.id ?? ''));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  await Promise.all([
    Messages.removeByUser(target._id),
    Members.removeAllForUser(target._id),
    Auth.revokeAllForUser(target._id),
  ]);
  await Users.delete(target._id);
  await logAction(_u.id, 'delete_user', target._id, { username: target.username });
  res.json({ ok: true });
});

// ── GET /api/admin/servers ─────────────────────────────────────
usersRouter.get('/servers', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const allServers = await Servers.findRecentSorted(100);
  const serverIds  = allServers.map(s => s._id);
  const allMembers = await Members.findByServerIds(serverIds, { fields: { serverId: 1 } });
  const countMap: Record<string, number> = {};
  for (const m of allMembers) countMap[m.serverId] = (countMap[m.serverId] || 0) + 1;
  const result = allServers
    .map(s => ({ _id: s._id, name: s.name, icon: s.icon, discoverable: s.discoverable, createdAt: s.createdAt, memberCount: countMap[s._id] || 0 }))
    .sort((a, b) => b.memberCount - a.memberCount);
  res.json(result);
});

// ── DELETE /api/admin/servers/:id ──────────────────────────────
usersRouter.delete('/servers/:id', authMiddleware, limits.moderation(), adminOnly, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.id ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });

  await Promise.all([
    Messages.removeByServer(server._id),
    Channels.deleteByServer(server._id),
    Members.removeAllFromServer(server._id),
    Roles.deleteByServer(server._id),
  ]);
  await Servers.delete(server._id);
  await logAction(_u.id, 'delete_server', server._id, { name: server.name });
  res.json({ ok: true });
});

