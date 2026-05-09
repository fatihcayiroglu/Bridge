// @ts-nocheck
// server/routes/federation/peers.js
// Bridge sunucu keşfi, peer yönetimi ve federation sağlık kontrolü

'use strict';

const express      = require('express');
const router       = express.Router();
const { Users, Servers, Members, Channels, Federation } = require('../../db/repositories');
const { authMiddleware, castAuthed } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { limits }   = require('../../middleware/rateLimit');

const PKG_VERSION = require('../../../package.json').version;
const USER_AGENT  = `Bridge/${PKG_VERSION}`;

// ── GET /api/federation/info — Bu sunucunun genel bilgisi ──────
router.get('/info', (req, res) => {
  res.json({
    name:        process.env.INSTANCE_NAME    || 'Bridge Instance',
    description: process.env.INSTANCE_DESC   || 'A Bridge chat server',
    url:         process.env.INSTANCE_URL    || `http://localhost:${process.env.PORT || 3001}`,
    version:     PKG_VERSION,
    federation:  true,
    software:    'bridge',
  });
});

// ── GET /api/federation/servers — Keşfe açık sunucular ────────
router.get('/servers', asyncHandler(async (req, res) => {
  const servers = await Servers.find({ discoverable: 1 });
  const result  = await Promise.all(servers.map(async s => {
    const members  = await Members.findByServer(s._id);
    const channels = await Channels.findWhere({ serverId: s._id, type: 'text' });
    return {
      id:           s._id,
      name:         s.name,
      description:  s.description || '',
      icon:         s.icon,
      tags:         s.tags || [],
      memberCount:  members.length,
      channelCount: channels.length,
      inviteUrl:    `${process.env.INSTANCE_URL || 'http://localhost:3001'}/invite-server/${s._id}`,
    };
  }));
  res.json({ instance: process.env.INSTANCE_URL || 'http://localhost:3001', servers: result });
}));

// ── GET /api/federation/stats ──────────────────────────────────
router.get('/stats', asyncHandler(async (req, res) => {
  const peers = await Federation.findPeers();
  const verifiedPeers = peers.filter(p => p.verified);
  res.json({
    peerCount:         peers.length,
    verifiedPeerCount: verifiedPeers.length,
    instance:          process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`,
    instanceName:      process.env.INSTANCE_NAME || 'Bridge Instance',
    federation:        true,
  });
}));

// ── GET /api/federation/peers ──────────────────────────────────
router.get('/peers', authMiddleware, asyncHandler(async (req, res) => {
  const peers = await Federation.findPeers();
  res.json(peers.map(p => ({
    id:       p._id,
    url:      p.url,
    name:     p.name,
    addedAt:  p.addedAt,
    lastSeen: p.lastSeen,
    verified: p.verified,
  })));
}));

// ── POST /api/federation/peers — Admin yeni peer ekle ─────────
router.post('/peers', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  let remoteInfo;
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/api/federation/info`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) throw new Error('Remote server returned ' + resp.status);
    remoteInfo = await resp.json();
    if (remoteInfo.software !== 'bridge') throw new Error('Not a Bridge instance');
  } catch (e) {
    return res.status(400).json({ error: `Could not reach remote server: ${e.message}` });
  }

  const existing = await Federation.findPeerByUrl(remoteInfo.url || url);
  if (existing) return res.status(409).json({ error: 'Peer already added' });

  const { v4: uuidv4 } = require('uuid');
  const peer = {
    _id:      uuidv4(),
    url:      remoteInfo.url || url,
    name:     remoteInfo.name || url,
    desc:     remoteInfo.description || '',
    addedAt:  Date.now(),
    lastSeen: Date.now(),
    verified: true,
  };
  await Federation.insertPeer(peer);
  res.json({ ok: true, peer });
}));

// ── DELETE /api/federation/peers/:id ──────────────────────────
router.delete('/peers/:id', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  await Federation.removePeerById(req.params.id);
  res.json({ ok: true });
}));

// ── GET /api/federation/discover ──────────────────────────────
router.get('/discover', authMiddleware, asyncHandler(async (req, res) => {
  const { q = '', tag = '' } = req.query;
  const peers = await Federation.findPeers();

  const results = await Promise.allSettled(
    peers.map(async peer => {
      try {
        const resp = await fetch(`${peer.url.replace(/\/$/, '')}/api/federation/servers`, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': USER_AGENT },
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        return (data.servers || []).map(s => ({
          ...s,
          _instanceUrl:  peer.url,
          _instanceName: peer.name,
          _remote: true,
        }));
      } catch {
        return [];
      }
    })
  );

  let allServers = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  if (q) {
    const lq = q.toLowerCase();
    allServers = allServers.filter(s =>
      s.name?.toLowerCase().includes(lq) ||
      s.description?.toLowerCase().includes(lq) ||
      (s.tags || []).some(t => t.toLowerCase().includes(lq))
    );
  }
  if (tag) {
    allServers = allServers.filter(s =>
      (s.tags || []).some(t => t.toLowerCase() === tag.toLowerCase())
    );
  }

  allServers.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
  res.json({ count: allServers.length, servers: allServers.slice(0, 100) });
}));

// ── POST /api/federation/ping ──────────────────────────────────
router.post('/ping', asyncHandler(async (req, res) => {
  const { verifyFederationRequest } = require('../../lib/httpSignature');
  if (!verifyFederationRequest(req)) {
    return res.status(401).json({ error: 'Invalid federation signature' });
  }
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  await Federation.updatePeersWhere(
    { url },
    { $set: { lastSeen: Date.now(), verified: true } }
  );
  res.json({ ok: true, ts: Date.now() });
}));

// ── GET /api/federation/health ─────────────────────────────────
router.get('/health', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const peers = await Federation.findPeers();
  const now   = Date.now();
  const STALE_MS = 10 * 60 * 1000;

  const result = peers.map(p => ({
    id:       p._id,
    url:      p.url,
    name:     p.name,
    lastSeen: p.lastSeen,
    online:   p.lastSeen && (now - p.lastSeen) < STALE_MS,
    ageMins:  p.lastSeen ? Math.floor((now - p.lastSeen) / 60000) : null,
  }));

  res.json({ peers: result, total: result.length, online: result.filter(p => p.online).length });
}));

// ── POST /api/federation/join-remote ──────────────────────────
router.post('/join-remote', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const { instanceUrl, serverId } = req.body;
  if (!instanceUrl || !serverId) return res.status(400).json({ error: 'instanceUrl and serverId required' });

  try {
    const resp = await fetch(
      `${instanceUrl.replace(/\/$/, '')}/api/federation/servers`,
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': USER_AGENT } }
    );
    if (!resp.ok) throw new Error('Remote unreachable');
    const data = await resp.json();
    const server = (data.servers || []).find(s => s.id === serverId);
    if (!server) return res.status(404).json({ error: 'Server not found on remote instance' });

    res.json({
      ok:        true,
      server,
      inviteUrl: server.inviteUrl || `${instanceUrl}/invite-server/${serverId}`,
      message:   'Visit inviteUrl to join this server',
    });
  } catch (e) {
    res.status(502).json({ error: `Remote instance error: ${e.message}` });
  }
}));

// ── GET /api/federation/fetch-remote — CORS proxy ─────────────
router.get('/fetch-remote', authMiddleware, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url gerekli' });

  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return res.status(400).json({ error: 'Only http/https URLs are supported' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) return res.status(502).json({ error: `Remote server returned ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach remote server: ${err.message}` });
  }
}));

module.exports = router;
export {};
