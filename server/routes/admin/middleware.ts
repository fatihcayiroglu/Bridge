// server/routes/admin/middleware.ts
// Sprint 105: admin/core.ts'den ayrıştırıldı — adminOnly + logAction yardımcıları

import { Response, NextFunction } from 'express';
import { Users, Auth } from '../../db/repositories';
import type { AuthedRequest } from '../../middleware/auth';

// ── Admin kontrol middleware ───────────────────────────────────
// next: NextFunction (non-optional) — Express middleware zincirinde daima sağlanır.
// req: AuthedRequest — authMiddleware'den sonra geldiği garantilidir; req.user her zaman dolu.
async function adminOnly(req: AuthedRequest, res: Response, next: NextFunction) {
  const user = await Users.findById(req.user.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  req.adminUser = user as unknown as typeof req.adminUser;
  next();
}

async function logAction(adminId: string, action: string, target: string | null = null, detail: Record<string, unknown> | null = null): Promise<void> {
  await Auth.insertAdminLog({
    adminId, action, target,
    detail: detail ? JSON.stringify(detail) : null,
  });
}

/**
 * @openapi
 * /admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: Sistem istatistikleri
 *     description: Kullanıcı, sunucu, mesaj sayıları ve sistem bilgisi. Sadece isAdmin kullanıcılar.
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: İstatistikler
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:    { type: integer }
 *                 servers:  { type: integer }
 *                 messages: { type: integer }
 *                 uptime:   { type: number }
 *                 version:  { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: Tüm kullanıcıları listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, description: 'Kullanıcı adı araması' }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *     responses:
 *       200:
 *         description: Kullanıcı listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /admin/users/{id}:
 *   patch:
 *     tags: [Admin]
 *     summary: Kullanıcı güncelle (ban, isAdmin, vb.)
 *     security: [{ bearerAuth: [] }]
 */

export { adminOnly, logAction };
