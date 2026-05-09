// server/routes/discover.js Server Discovery
const express = require('express');
const router  = express.Router();
const { Servers, Members, Channels } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// GET /api/discover — public server discovery
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const { q, tag, sort = 'members' } = req.query;

  let servers = await Servers.find({ discoverable: 1 });

  if (!servers.length) {
    const allServers = await Servers.find({});
    const serverIds  = allServers.map(s => s._id);
    const memberCounts = {};
    for (const sid of serverIds) {
      const members = await Members.findByServer(sid);
      memberCounts[sid] = members.length;
    }
    servers = allServers.filter(s => memberCounts[s._id] > 1);
    servers.forEach(s => { s._memberCount = memberCounts[s._id]; });
  } else {
    for (const s of servers) {
      const members = await Members.findByServer(s._id);
      s._memberCount = members.length;
    }
  }

  if (q?.trim()) {
    const lq = q.trim().toLowerCase();
    servers = servers.filter(s =>
      s.name.toLowerCase().includes(lq) ||
      (s.description || '').toLowerCase().includes(lq) ||
      (s.tags || []).some(t => t.toLowerCase().includes(lq))
    );
  }

  if (tag?.trim()) {
    const lt = tag.trim().toLowerCase();
    servers = servers.filter(s => (s.tags || []).some(t => t.toLowerCase() === lt));
  }

  if (sort === 'members') servers.sort((a, b) => (b._memberCount || 0) - (a._memberCount || 0));
  else if (sort === 'newest') servers.sort((a, b) => b.createdAt - a.createdAt);
  else if (sort === 'name') servers.sort((a, b) => a.name.localeCompare(b.name));

  const result = await Promise.all(servers.slice(0, 50).map(async s => {
    const channels = await Channels.findWhere({ serverId: s._id, type: 'text' });
    return {
      _id:         s._id,
      name:        s.name,
      icon:        s.icon,
      iconUrl:     s.iconUrl,
      bannerUrl:   s.bannerUrl,
      description: s.description || '',
      tags:        s.tags || [],
      memberCount: s._memberCount || 0,
      channelCount: channels.length,
      createdAt:   s.createdAt,
    };
  }));

  res.json(result);
}));

router.patch('/settings', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId, discoverable, description, tags } = req.body;
  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only owner can update discovery' });

  const update: Record<string,any> = {};
  if (discoverable !== undefined) update.discoverable = discoverable ? 1 : 0;
  if (description  !== undefined) update.description  = String(description).trim().slice(0, 500);
  if (tags && Array.isArray(tags)) update.tags = tags.slice(0, 10).map(t => String(t).trim().toLowerCase().slice(0, 30));

  await Servers.update(serverId, update);
  res.json({ ok: true });
}));

module.exports = router;
export {};
