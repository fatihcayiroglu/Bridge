// server/routes/userConnections.js
// Kullanıcı sosyal bağlantıları (GitHub, Twitter/X, Steam, Spotify, YouTube, Twitch, vb.)

'use strict';

const express    = require('express');
const router     = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Social } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

const PLATFORMS = {
  github:   { label: 'GitHub',     icon: '🐙', urlPrefix: 'https://github.com/',            usernameRe: /^[a-zA-Z0-9_-]{1,39}$/ },
  twitter:  { label: 'X (Twitter)',icon: '🐦', urlPrefix: 'https://x.com/',                 usernameRe: /^[a-zA-Z0-9_]{1,50}$/ },
  twitch:   { label: 'Twitch',     icon: '💜', urlPrefix: 'https://twitch.tv/',              usernameRe: /^[a-zA-Z0-9_]{1,25}$/ },
  youtube:  { label: 'YouTube',    icon: '▶️',  urlPrefix: 'https://youtube.com/@',          usernameRe: /^[a-zA-Z0-9_@.-]{1,60}$/ },
  steam:    { label: 'Steam',      icon: '🎮', urlPrefix: 'https://steamcommunity.com/id/',  usernameRe: /^[a-zA-Z0-9_-]{2,32}$/ },
  spotify:  { label: 'Spotify',    icon: '🎵', urlPrefix: 'https://open.spotify.com/user/', usernameRe: /^[a-zA-Z0-9_.-]{1,50}$/ },
  linkedin: { label: 'LinkedIn',   icon: '💼', urlPrefix: 'https://linkedin.com/in/',        usernameRe: /^[a-zA-Z0-9_-]{3,100}$/ },
  website:  { label: 'Website',    icon: '🌐', urlPrefix: '',                                usernameRe: /^https?:\/\/.{3,200}$/ },
};

router.get('/users/:userId/connections', authMiddleware, asyncHandler(async (req, res) => {
  const connections = await Social.findConnectionsByUser(req.params.userId);
  res.json(connections.map(c => ({
    platform: c.platform,
    username: c.username,
    url:      c.url,
    label:    PLATFORMS[c.platform]?.label || c.platform,
    icon:     PLATFORMS[c.platform]?.icon  || '🔗',
  })));
}));

router.get('/me/connections', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const connections = await Social.findConnectionsByUser(_u.id);
  res.json(connections.map(c => ({
    ...c,
    label: PLATFORMS[c.platform]?.label || c.platform,
    icon:  PLATFORMS[c.platform]?.icon  || '🔗',
  })));
}));

router.put('/me/connections/:platform', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { platform } = req.params;
  if (!PLATFORMS[platform]) {
    return res.status(400).json({ error: `Desteklenmeyen platform. Desteklenenler: ${Object.keys(PLATFORMS).join(', ')}` });
  }

  const { username } = req.body;
  if (!username?.trim()) return res.status(400).json({ error: 'username gerekli' });

  const meta = PLATFORMS[platform];
  const trimmed = username.trim();

  if (!meta.usernameRe.test(trimmed)) {
    return res.status(400).json({ error: `${meta.label} için geçersiz kullanıcı adı formatı` });
  }

  const url = platform === 'website' ? trimmed : `${meta.urlPrefix}${trimmed}`;

  const existing = await Social.findConnection(_u.id, platform);
  let connection;
  if (existing) {
    await Social.updateConnection(
      { userId: _u.id, platform },
      { $set: { username: trimmed, url } }
    );
    connection = await Social.findConnection(_u.id, platform);
  } else {
    const count = await Social.countConnections({ userId: _u.id });
    if (count >= 10) return res.status(429).json({ error: 'Maksimum 10 bağlantı' });

    connection = await Social.insertConnection({
      userId:    _u.id,
      platform,
      username:  trimmed,
      url,
      verified:  0,
    });
  }

  res.json({ ...connection, label: meta.label, icon: meta.icon });
}));

router.delete('/me/connections/:platform', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { platform } = req.params;
  const existing = await Social.findConnection(_u.id, platform);
  if (!existing) return res.status(404).json({ error: 'Bağlantı bulunamadı' });
  await Social.removeConnection(_u.id, platform);
  res.json({ deleted: true });
}));

router.get('/connections/platforms', authMiddleware, (req, res) => {
  res.json(Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label, icon: p.icon })));
});

module.exports = router;
export {};
