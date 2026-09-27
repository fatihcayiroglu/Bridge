/**
 * @openapi
 * tags:
 *   - name: ServerGifs
 *     description: ServerGifs API endpoints

 *
 * /servers/{sid}/gifs:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu GIF favorilerini listele (sayfalı)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: GIF listesi (sayfalı)
 *
 * /servers/{sid}/gifs/all:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu tüm GIF favorilerini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Tüm GIF favorileri
 *   post:
 *     tags: [Servers]
 *     summary: GIF favoriye ekle
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
 *             required: [url]
 *             properties:
 *               url:   { type: string, format: uri }
 *               title: { type: string }
 *     responses:
 *       201:
 *         description: GIF eklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/gifs/{gifId}:
 *   delete:
 *     tags: [Servers]
 *     summary: GIF favoriden çıkar
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: gifId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/serverGifs.ts — Server GIF Collections
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router({ mergeParams: true });
import { Members, Servers, ServerAssets } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { getMemberPerms, hasPermission, PERMS } from './roles';
import { limits } from '../middleware/rateLimit';
import { getStorageAdapter } from '../lib/storageAdapter';
import db from '../db/loader';
import logger from '../lib/logger';
import { hasLiveUploadReference, normalizeUploadKey } from '../lib/uploadReferenceSafety';

// Helper: verify membership + return member perms
async function requireMember(userId: string, serverId: string, res: import('express').Response): Promise<import('../db/repositories/types/entities').Member | null> {
  const membership = await Members.findOne(userId, serverId);
  if (!membership) { res.status(403).json({ error: 'Not a member' }); return null; }
  return membership;
}

// GET /api/servers/:id/gifs — get this server's GIF collection
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.id ?? '');
  if (!await requireMember(_u.id, serverId, res)) return;
  const q = (req.query.q as string | undefined)?.trim().toLowerCase();
  let gifs = await ServerAssets.findGifs(serverId);
  if (q) gifs = gifs.filter(g => (g.name ?? '').toLowerCase().includes(q) || (Array.isArray(g.tags) ? g.tags : typeof g.tags === 'string' ? JSON.parse(g.tags) as string[] : []).some((t: string) => t.includes(q)));
  res.json(gifs);
});

// GET /api/servers/@me/all-gifs — all GIFs from all servers the user is in
router.get('/all', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const serverIds = memberships.map(m => m.serverId);
  const gifs = await ServerAssets.findGifsByServerIds(serverIds);

  // Fetch server names for grouping
  const servers = await Servers.find({ _id: { $in: serverIds } });
  const serverMap: Record<string, unknown> = {};
  for (const s of servers) serverMap[s._id] = { name: s.name, icon: s.icon };

  // Group by server
  const grouped: Record<string, { server: unknown; gifs: unknown[] }> = {};
  for (const gif of gifs) {
    const sid = gif.serverId;
    if (!grouped[sid]) grouped[sid] = { server: serverMap[sid] || { name: 'Unknown' }, gifs: [] };
    grouped[sid].gifs.push(gif);
  }
  res.json(grouped);
});

// POST /api/servers/:id/gifs — admin uploads a GIF (file must be pre-uploaded via /api/upload/server-gif)
router.post('/', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.id ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS) && !hasPermission(perms, PERMS.ADMINISTRATOR)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  }
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const { name, tags, url, fileType } = body;
  if (typeof name !== 'string' || !name.trim() || typeof url !== 'string' || !url) {
    return res.status(400).json({ error: 'name and valid url are required' });
  }

  // Never persist an arbitrary client-supplied URL. The pre-upload endpoint
  // records an authenticated owner and a generated `uploads/server-gifs/...`
  // key; resolve that key, verify current ownership, then regenerate the
  // provider's canonical public URL server-side. This also keeps remote CDN
  // mode working without allowing an attacker-controlled external origin.
  const store = getStorageAdapter();
  if (tags !== undefined && (!Array.isArray(tags) || tags.some(t => typeof t !== 'string'))) return res.status(400).json({ error: 'tags must be a string array' });
  if (fileType !== undefined && typeof fileType !== 'string') return res.status(400).json({ error: 'fileType must be a string' });
  const extractedKey = store.keyFromUrl(url);
  const canonicalKey = normalizeUploadKey(
    extractedKey.startsWith('uploads/') ? extractedKey : `uploads/${extractedKey}`,
  );
  if (!canonicalKey || !/^uploads\/server-gifs\/gif_[0-9a-f-]{36}\.(?:gif|webp|png|jpe?g)$/i.test(canonicalKey)) {
    return res.status(400).json({ error: 'GIF must come from /api/upload/server-gif' });
  }
  const ownedUpload = await (db as unknown as { uploads: { findOne(q: Record<string, unknown>): Promise<unknown> } })
    .uploads.findOne({ key: canonicalKey, userId: _u.id });
  if (!ownedUpload) {
    return res.status(403).json({ error: 'GIF upload is not owned by the current user' });
  }
  const canonicalUrl = store.publicUrlForKey(canonicalKey);

  const gif = await ServerAssets.insertGif({
    serverId,
    name: name.trim().slice(0, 64),
    tags: Array.isArray(tags) ? tags.map(t => String(t).toLowerCase().slice(0, 32)).slice(0, 10) : [],
    url: canonicalUrl,
    fileType: fileType || 'image/gif',
    uploadedBy: _u.id,
    createdAt: Date.now(),
  });
  res.json(gif);
});

// DELETE /api/servers/:id/gifs/:gifId — admin removes a GIF
router.delete('/:gifId', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.id ?? '');
  const gifId = String(req.params.gifId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS) && !hasPermission(perms, PERMS.ADMINISTRATOR)) {
    return res.status(403).json({ error: 'Missing permission' });
  }
  const gif = await ServerAssets.findGifByIdAndServer(gifId, serverId);
  if (!gif) return res.status(404).json({ error: 'GIF not found' });

  // DB ownership first: if this mutation fails, the physical object must stay.
  await ServerAssets.deleteGif(gifId, serverId);

  // Physical cleanup is best-effort and shared-reference aware. Server GIF files
  // originate from the provider-agnostic upload route, so use the same adapter
  // for local/S3/R2/MinIO/B2 deletion instead of guessing a local basename.
  const store = getStorageAdapter();
  const storageKey = store.keyFromUrl(gif.url);
  const canonicalKey = normalizeUploadKey(
    storageKey.startsWith('uploads/') ? storageKey : `uploads/${storageKey}`,
  );
  if (canonicalKey) {
    try {
      if (!await hasLiveUploadReference(db._pool, canonicalKey)) {
        await store.deleteFile(storageKey);
      }
    } catch (error) {
      logger.error({ err: error, gifId, serverId, storageKey, event: 'server_gif.cleanup_failed' },
        'Server GIF DB row removed but physical cleanup failed/was blocked');
    }
  } else {
    logger.warn({ gifId, serverId, url: gif.url, event: 'server_gif.cleanup_invalid_key' },
      'Server GIF physical cleanup skipped because storage key was invalid');
  }
  res.json({ deleted: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
