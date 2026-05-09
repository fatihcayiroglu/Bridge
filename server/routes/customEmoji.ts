// server/routes/customEmoji.js — Server Custom Emoji (No Nitro Required)
const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router({ mergeParams: true });
const { Servers, Members, Roles, ServerAssets } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

const UPLOAD_DIR = path.join(__dirname, '../uploads/emojis');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `emoji_${uuidv4()}${ext}`);
  },
});

const emojiUpload = multer({
  storage,
  limits: { fileSize: 512 * 1024 }, // 512KB — animasyonlu GIF için daha geniş limit
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png','image/gif','image/webp','image/jpeg'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only PNG, GIF, WebP, JPEG allowed'), allowed.includes(file.mimetype));
  },
});

async function isMember(userId, serverId) {
  return !!(await Members.findOne(userId, serverId));
}

async function isOwnerOrAdmin(userId, serverId) {
  const server = await Servers.findById(serverId);
  if (!server) return false;
  if (server.ownerId === userId) return true;
  const membership = await Members.findOne(userId, serverId);
  if (!membership) return false;
  let roleIds = membership.roles || [];
  if (typeof roleIds === 'string') {
    try { roleIds = JSON.parse(roleIds); } catch { roleIds = []; }
  }
  if (!roleIds.length) return false;
  const roles = await Roles.findWhere({ _id: { $in: roleIds } });
  return roles.some(r => (r.permissions & 64) || (r.permissions & 1)); // ADMINISTRATOR or MANAGE_CHANNELS
}

// GET /api/servers/:sid/emojis
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isMember(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Not a member' });
  const emojis = await ServerAssets.findEmojisSorted(req.params.sid);
  res.json(emojis);
}));

// GET /api/servers/:sid/emojis/all — cross-server: tüm üye olduğun sunucuların emojileri
router.get('/all', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  // Kullanıcının üye olduğu tüm sunucuları bul
  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map(m => m.serverId);
  if (!serverIds.length) return res.json([]);

  // Tüm sunucuların emojilerini çek + sunucu adını ekle
  const allEmojis: any[] = [];
  for (const sid of serverIds) {
    const emojis = await ServerAssets.findEmojisSorted(sid);
    const server = await Servers.findById(sid);
    for (const e of emojis) {
      allEmojis.push({ ...e, serverName: server?.name || 'Unknown', serverIcon: server?.icon || '🌐' });
    }
  }
  res.json(allEmojis);
}));

// POST /api/servers/:sid/emojis — upload emoji
router.post('/', authMiddleware, limits.write(), (req, res, next) => {
  emojiUpload.single('emoji')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const name = (req.body.name || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
  if (!name) return res.status(400).json({ error: 'Emoji name required (a-z, 0-9, _)' });

  // Check dupe
  const existing = await ServerAssets.findEmojiByServerAndName(req.params.sid, name);
  if (existing) {
    fs.unlinkSync(req.file.path);
    return res.status(409).json({ error: `Emoji :${name}: already exists` });
  }

  // Limit yok — Discord Nitro'nun aksine Bridge'de emoji sınırsız

  const emoji = await ServerAssets.insertEmoji({
    _id: uuidv4(),
    serverId: req.params.sid,
    name,
    url: `/uploads/emojis/${req.file.filename}`,
    uploadedBy: _u.id,
    createdAt: Date.now(),
  });

  res.json(emoji);
}));

// DELETE /api/servers/:sid/emojis/:eid
router.delete('/:eid', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const emoji = await ServerAssets.findEmojiByIdAndServer(req.params.eid, req.params.sid);
  if (!emoji) return res.status(404).json({ error: 'Emoji not found' });

  // Delete file
  const filePath = path.join(__dirname, '../uploads/emojis', path.basename(emoji.url));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await ServerAssets.deleteEmoji(req.params.eid, req.params.sid);
  res.json({ ok: true });
}));

module.exports = router;
export {};
