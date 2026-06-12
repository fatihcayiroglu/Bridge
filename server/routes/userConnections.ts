// server/routes/userConnections.ts
// Kullanıcı sosyal bağlantıları (GitHub, Twitter/X, Steam, Spotify, YouTube, Twitch, vb.)


import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Social } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';

const PLATFORMS = {
  github:   { label: 'GitHub',     icon: '🐙', urlPrefix: 'https://github.com/',            usernameRe: /^[a-zA-Z0-9_-]{1,39}$/ },
  twitter:  { label: 'X (Twitter)',icon: '🐦', urlPrefix: 'https://x.com/',                 usernameRe: /^[a-zA-Z0-9_]{1,50}$/ },
  twitch:   { label: 'Twitch',     icon: '💜', urlPrefix: 'https://twitch.tv/',              usernameRe: /^[a-zA-Z0-9_]{1,25}$/ },
  youtube:  { label: 'YouTube',    icon: '▶️',  urlPrefix: 'https://youtube.com/@',          usernameRe: /^[a-zA-Z0-9_@.-]{1,60}$/ },
  steam:    { label: 'Steam',      icon: '🎮', urlPrefix: 'https://steamcommunity.com/id/',  usernameRe: /^[a-zA-Z0-9_-]{2,32}$/ },
  spotify:  { label: 'Spotify',    icon: '🎵', urlPrefix: 'https://open.spotify.com/user/', usernameRe: /^[a-zA-Z0-9_.-]{1,50}$/ },
  linkedin: { label: 'LinkedIn',   icon: '💼', urlPrefix: 'https://linkedin.com/in/',        usernameRe: /^[a-zA-Z0-9_-]{3,100}$/ },
  website:  { label: 'Website',    icon: '🌐', urlPrefix: '',                                usernameRe: /^https?:\/\/.{3,200}$/ },
} as const;
type PlatformKey = keyof typeof PLATFORMS;
function isPlatformKey(value: string): value is PlatformKey { return value in PLATFORMS; }

/**
 * @openapi
 * /connections/users/{userId}:
 *   get:
 *     summary: Kullanıcının sosyal bağlantılarını listele
 *     tags: [Connections]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Platform/username/url listesi
 */
router.get('/users/:userId/connections'
, authMiddleware, async (req, res) => {
  const connections = await Social.findConnectionsByUser(String(req.params.userId ?? ''));
  res.json(connections.map(c => ({
    platform: c.platform,
    username: c.username,
    url:      c.url,
    label:    isPlatformKey(c.platform) ? PLATFORMS[c.platform].label : c.platform,
    icon:     isPlatformKey(c.platform) ? PLATFORMS[c.platform].icon : '🔗',
  })));
});

/**
 * @openapi
 * /connections/me:
 *   get:
 *     summary: Kendi sosyal bağlantılarımı getir
 *     tags: [Connections]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Kendi bağlantı listesi
 */
router.get('/me/connections'
, authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const connections = await Social.findConnectionsByUser(_u.id);
  res.json(connections.map(c => ({
    ...c,
    label: isPlatformKey(c.platform) ? PLATFORMS[c.platform].label : c.platform,
    icon:  isPlatformKey(c.platform) ? PLATFORMS[c.platform].icon : '🔗',
  })));
});

/**
 * @openapi
 * /connections/me/{platform}:
 *   put:
 *     summary: Sosyal bağlantı ekle veya güncelle
 *     tags: [Connections]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: platform, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username]
 *             properties:
 *               username: { type: string }
 *     responses:
 *       200:
 *         description: Eklenen/güncellenen bağlantı
 *       400:
 *         description: Geçersiz platform veya kullanıcı adı
 */
router.put('/me/connections/:platform'
, authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const platform = String(req.params.platform ?? '');
  if (!isPlatformKey(platform)) {
    return res.status(400).json({ error: `Desteklenmeyen platform. Desteklenenler: ${Object.keys(PLATFORMS).join(', ')}` });
  }

  const { username } = req.body as Record<string, string>;
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
});

/**
 * @openapi
 * /connections/me/{platform}:
 *   delete:
 *     summary: Sosyal bağlantıyı kaldır
 *     tags: [Connections]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: platform, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Silme başarılı
 *       404:
 *         description: Bağlantı bulunamadı
 */
router.delete('/me/connections/:platform'
, authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const platform = String(req.params.platform ?? '');
  const existing = await Social.findConnection(_u.id, platform);
  if (!existing) return res.status(404).json({ error: 'Bağlantı bulunamadı' });
  await Social.removeConnection(_u.id, platform);
  res.json({ deleted: true });
});

/**
 * @openapi
 * /connections/platforms:
 *   get:
 *     summary: Desteklenen platformların listesi
 *     tags: [Connections]
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: id/label/icon listesi
 */
router.get('/connections/platforms'
, authMiddleware, (req, res) => {
  res.json(Object.entries(PLATFORMS).map(([id, p]) => ({ id, label: p.label, icon: p.icon })));
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
