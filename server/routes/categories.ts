// server/routes/categories.ts — Channel Categories
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router({ mergeParams: true });
import { Channels, Members } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { getMemberPerms, hasPermission, PERMS } from './roles';
import { limits } from '../middleware/rateLimit';
import { parseNonNegativeSafeIntValue } from '../lib/queryNumbers';

/**
 * @openapi
 * /servers/{serverId}/categories:
 *   get:
 *     summary: Sunucudaki kategori listesi
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Kategori listesi
 *       403:
 *         description: Üye değil
 */
// GET /api/servers/:serverId/categories
router.get('/'
, authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const cats = await Channels.findCategoriesByServer(serverId);
  res.json(cats);
});

/**
 * @openapi
 * /servers/{serverId}/categories:
 *   post:
 *     summary: Yeni kategori oluştur
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: Oluşturulan kategori
 *       403:
 *         description: İzin yok
 */
// POST /api/servers/:serverId/categories
router.post('/'
, authMiddleware, limits.channels(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const body = req.body as Record<string, unknown>;
  const name = body.name;
  if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const count = await Channels.countCategories(serverId);
  const cat = await Channels.insertCategory({
    serverId, name: name.trim().toUpperCase(), position: count, collapsed: false,
  });
  res.json(cat);
});

/**
 * @openapi
 * /servers/{serverId}/categories/{catId}:
 *   patch:
 *     summary: Kategoriyi güncelle
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: catId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:      { type: string }
 *               position:  { type: integer }
 *               collapsed: { type: boolean }
 *     responses:
 *       200:
 *         description: Güncelleme başarılı
 *       403:
 *         description: İzin yok
 */
// PATCH /api/servers/:serverId/categories/:catId
router.patch('/:catId'
, authMiddleware, limits.channels(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const catId = String(req.params.catId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const { name, position, collapsed } = req.body as Record<string, unknown>;
  const $set: Record<string, unknown> = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name must be a non-empty string' });
    $set.name = name.trim().toUpperCase();
  }
  if (position !== undefined) {
    const parsed = parseNonNegativeSafeIntValue(position, 0);
    if (parsed === null) return res.status(400).json({ error: 'position must be a non-negative safe integer' });
    $set.position = parsed;
  }
  if (collapsed !== undefined) {
    if (typeof collapsed !== 'boolean') return res.status(400).json({ error: 'collapsed must be a boolean' });
    $set.collapsed = collapsed;
  }
  await Channels.updateCategory(catId, serverId, $set);
  res.json({ ok: true });
});

/**
 * @openapi
 * /servers/{serverId}/categories/{catId}:
 *   delete:
 *     summary: Kategoriyi sil
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: catId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Silme başarılı
 *       403:
 *         description: İzin yok
 */
// DELETE /api/servers/:serverId/categories/:catId
router.delete('/:catId'
, authMiddleware, limits.channels(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const catId = String(req.params.catId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const deleted = await Channels.deleteCategoryAtomic(catId, serverId);
  if (!deleted) return res.status(404).json({ error: 'Category not found' });
  res.json({ ok: true });
});

/**
 * @openapi
 * /servers/{serverId}/categories/reorder:
 *   post:
 *     summary: Kategorileri yeniden sırala
 *     tags: [Categories]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [order]
 *             properties:
 *               order:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     id:       { type: string }
 *                     position: { type: integer }
 *     responses:
 *       200:
 *         description: Sıralama güncellendi
 *       400:
 *         description: order dizisi gerekli
 *       403:
 *         description: İzin yok
 */
// POST /api/servers/:serverId/categories/reorder — bulk position update
router.post('/reorder', authMiddleware, limits.channels(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const { order } = req.body as { order?: unknown };
  if (!Array.isArray(order) || order.length > 500) return res.status(400).json({ error: 'order array required' });
  const normalized: Array<{ id: string; position: number }> = [];
  const seen = new Set<string>();
  for (const raw of order) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return res.status(400).json({ error: 'invalid category order item' });
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || seen.has(item.id)) return res.status(400).json({ error: 'invalid or duplicate category id' });
    const position = parseNonNegativeSafeIntValue(item.position, 0);
    if (position === null) return res.status(400).json({ error: 'position must be a non-negative safe integer' });
    seen.add(item.id);
    normalized.push({ id: item.id, position });
  }
  const updated = await Channels.reorderCategoriesAtomic(serverId, normalized);
  if (!updated) return res.status(404).json({ error: 'Category not found' });
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
