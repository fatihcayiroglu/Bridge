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
 *       200: { description: Kullanıcı silindi (kanonik hesap silme politikası) }
 *       409: { description: Başka üyeleri olan sunucu/grup DM sahipliği önce devredilmeli ya da silinmeli }
 *       503: { description: PostgreSQL gerekli }
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
import { Users, Servers, Members, Auth } from '../../db/repositories';
import db from '../../db/loader';
import logger from '../../lib/logger';
import {
  eraseAccountData, ownershipBlockers, releaseAfterErasure,
  type Queryable, type TransactionRunner,
} from '../../lib/accountDeletion';
import { authMiddleware, _invalidateTokenCache } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { adminOnly, logAction } from './middleware';
import { requireStepUp } from '../../lib/stepUp';
import { disconnectLiveUserSessions } from '../../lib/sessionRevocation';
import { parseBoundedPositiveIntQuery } from '../../lib/queryNumbers';

// ── GET /api/admin/users ───────────────────────────────────────
usersRouter.get('/users', authMiddleware, adminOnly, async (req: Request, res: Response) => {
  const q      = String(req.query.q      ?? '');
  const pageNum = parseBoundedPositiveIntQuery(req.query.page, 1, 1_000_000);
  const limitNum = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  if (pageNum === null || limitNum === null) {
    return res.status(400).json({ error: 'page/limit must be positive safe integers' });
  }
  const offset = (pageNum - 1) * limitNum;

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
  const body = (req.body && typeof req.body === 'object') ? req.body as Record<string, unknown> : {};
  const isAdmin = body.isAdmin;
  const target = await Users.findById(String(req.params.id ?? ''));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot modify yourself' });

  if (typeof isAdmin !== 'boolean') return res.status(400).json({ error: 'isAdmin must be boolean' });
  const updates: Record<string, unknown> = { isAdmin };
  await Users.update(target._id, updates);
  await logAction(_u.id, 'update_user', target._id, { updates });
  res.json({ ok: true });
});

// ── DELETE /api/admin/users/:id ────────────────────────────────
usersRouter.delete('/users/:id', authMiddleware, limits.moderation(), adminOnly, requireStepUp('admin.user.delete'), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const target = await Users.findById(String(req.params.id ?? ''));
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot delete yourself' });

  // ── Final21 Faz 19: KANONİK POLİTİKA ──────────────────────────────────────
  // Bu uç eskiden yalnızca kanal mesajlarını ve üyelikleri silip `users` satırını
  // kaldırıyordu (işlemsiz `Promise.all`): WebAuthn/OAuth/push kayıtları, arkadaşlıklar,
  // DM/konu/sesli mesajlardaki ad ve avatar, profil görselleri geride kalıyor; kişinin
  // sahibi olduğu sunucular SAHİPSİZ kalıyordu. Artık kişinin kendi silmesiyle AYNI
  // uygulayıcı çalışır (lib/accountDeletion.ts). Tek fark moderasyon niyetidir: kişinin
  // KANAL mesajları anonimleştirilmek yerine silinir (bu ucun önceki davranışı).
  const p = (db as unknown as { _pool?: Queryable })._pool;
  if (!p || typeof p.query !== 'function') return res.status(503).json({ error: 'Requires PostgreSQL' });

  try {
    const blockers = await ownershipBlockers(p, target._id);
    if (blockers.length > 0) {
      // SESSİZ DEVİR YOK, SAHİPSİZ SUNUCU YOK — yönetici için de.
      return res.status(409).json({
        error: 'Ownership transfer required before deletion',
        blockers,
        remedy: 'Delete these servers/group DMs (DELETE /api/admin/servers/:id) or have ownership transferred, then retry.',
      });
    }

    const transaction = (db as unknown as { _transaction: TransactionRunner })._transaction;
    const { applied, plan } = await eraseAccountData(p, transaction, target._id, { purgeChannelMessages: true });

    // Silinen hesabın jetonu süreç içi sürüm önbelleğinden de düşer (bkz.
    // routes/account.ts): aksi halde tek düğümde 30 sn geçerli kalırdı.
    _invalidateTokenCache(target._id);
    await Auth.revokeAllForUser(target._id).catch(() => { /* satırlar zaten silindi */ });
    await disconnectLiveUserSessions(target._id, 'account_deleted_by_admin');
    const assets = await releaseAfterErasure(p, plan, (url, err) => {
      logger.error({ err, userId: target._id, url, event: 'admin.user_delete.asset_release_failed' },
        'Kullanıcı silindi ama bir profil görseli silinemedi.');
    });
    await logAction(_u.id, 'delete_user', target._id, { username: target.username });
    return res.json({ ok: true, applied, profileAssets: assets });
  } catch (err) {
    logger.error({ err, userId: target._id, event: 'admin.user_delete.failed' }, 'Yönetici kullanıcı silmesi başarısız.');
    return res.status(500).json({ error: 'Deletion failed' });
  }
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
usersRouter.delete('/servers/:id', authMiddleware, limits.moderation(), adminOnly, requireStepUp('admin.server.delete'), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.id ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });

  // Admin ve owner delete aynı graph/durability sahibini kullanır; iki ayrı
  // eksik cascade listesi zamanla birbirinden sapmamalı.
  const result = await Servers.deleteGraphAtomic(server._id);
  if (result === 'not_found') return res.status(404).json({ error: 'Server not found' });
  await logAction(_u.id, 'delete_server', server._id, { name: server.name });
  res.json({ ok: true });
});

