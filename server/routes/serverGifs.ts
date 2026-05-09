// server/routes/serverGifs.js — Server GIF Collections
const express = require('express');
const router  = express.Router({ mergeParams: true });
const path    = require('path');
const fs      = require('fs');
const { Members, Servers, ServerAssets } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// Helper: verify membership + return member perms
async function requireMember(userId, serverId, res) {
  const membership = await Members.findOne(userId, serverId);
  if (!membership) { res.status(403).json({ error: 'Not a member' }); return null; }
  return membership;
}

// GET /api/servers/:id/gifs — get this server's GIF collection
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { id: serverId } = req.params;
  if (!await requireMember(_u.id, serverId, res)) return;
  const q = req.query.q?.trim().toLowerCase();
  let gifs = await ServerAssets.findGifs(serverId);
  if (q) gifs = gifs.filter(g => g.name.toLowerCase().includes(q) || (g.tags || []).some(t => t.includes(q)));
  res.json(gifs);
}));

// GET /api/servers/@me/all-gifs — all GIFs from all servers the user is in
router.get('/all', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const serverIds = memberships.map(m => m.serverId);
  const gifs = await ServerAssets.findGifsByServerIds(serverIds);

  // Fetch server names for grouping
  const servers = await Servers.find({ _id: { $in: serverIds } });
  const serverMap = {};
  for (const s of servers) serverMap[s._id] = { name: s.name, icon: s.icon };

  // Group by server
  const grouped = {};
  for (const gif of gifs) {
    const sid = gif.serverId;
    if (!grouped[sid]) grouped[sid] = { server: serverMap[sid] || { name: 'Unknown' }, gifs: [] };
    grouped[sid].gifs.push(gif);
  }
  res.json(grouped);
}));

// POST /api/servers/:id/gifs — admin uploads a GIF (file must be pre-uploaded via /api/upload/server-gif)
router.post('/', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { id: serverId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS) && !hasPermission(perms, PERMS.ADMINISTRATOR)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });
  }
  const { name, tags, url, fileType } = req.body;
  if (!name?.trim() || !url?.startsWith('/uploads/')) {
    return res.status(400).json({ error: 'name and valid url are required' });
  }
  const gif = await ServerAssets.insertGif({
    serverId,
    name: name.trim().slice(0, 64),
    tags: Array.isArray(tags) ? tags.map(t => String(t).toLowerCase().slice(0, 32)).slice(0, 10) : [],
    url,
    fileType: fileType || 'image/gif',
    uploadedBy: _u.id,
    createdAt: Date.now(),
  });
  res.json(gif);
}));

// DELETE /api/servers/:id/gifs/:gifId — admin removes a GIF
router.delete('/:gifId', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { id: serverId, gifId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS) && !hasPermission(perms, PERMS.ADMINISTRATOR)) {
    return res.status(403).json({ error: 'Missing permission' });
  }
  const gif = await ServerAssets.findGifByIdAndServer(gifId, serverId);
  if (!gif) return res.status(404).json({ error: 'GIF not found' });

  // Delete file from disk
  const filePath = path.join(__dirname, '../uploads', path.basename(gif.url));
  fs.unlink(filePath, () => {});
  await ServerAssets.deleteGif(gifId, serverId);
  res.json({ deleted: true });
}));

module.exports = router;
export {};
