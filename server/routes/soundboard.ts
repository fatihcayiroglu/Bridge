// server/routes/soundboard.js Soundboard (Discord Nitro'da ücretli, Bridge'de bedava)
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router({ mergeParams: true });
const { Servers, Members, Roles, ServerAssets } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

const UPLOAD_DIR = path.join(__dirname, '../uploads/soundboard');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `sound_${uuidv4()}${ext}`);
  },
});

const soundUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowed = ['audio/mpeg','audio/mp3','audio/ogg','audio/wav','audio/webm','audio/aac','audio/flac'];
    cb(allowed.includes(file.mimetype) ? null : new Error('Only MP3, OGG, WAV, WEBM, AAC, FLAC allowed'), allowed.includes(file.mimetype));
  },
});

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
  return roles.some(r => (r.permissions & 64) || (r.permissions & 1));
}

// GET /api/servers/:sid/soundboard
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, req.params.sid);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const sounds = await ServerAssets.findSoundsSorted(req.params.sid);
  res.json(sounds);
}));

// POST /api/servers/:sid/soundboard — upload sound
router.post('/', authMiddleware, limits.write(), (req, res, next) => {
  soundUpload.single('sound')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Max 64 sounds per server
  const existing = await ServerAssets.findSounds(req.params.sid);
  if (existing.length >= 64) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Maximum 64 sounds per server' });
  }

  const name  = (req.body.name  || '').trim().slice(0, 32) || path.basename(req.file.originalname, path.extname(req.file.originalname)).slice(0, 32);
  const emoji = (req.body.emoji || '🔊').trim().slice(0, 8);

  const sound = await ServerAssets.insertSound({
    _id:        uuidv4(),
    serverId:   req.params.sid,
    name,
    emoji,
    url:        `/uploads/soundboard/${req.file.filename}`,
    uploadedBy: _u.id,
    createdAt:  Date.now(),
  });

  res.json(sound);
}));

// DELETE /api/servers/:sid/soundboard/:soundId
router.delete('/:soundId', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwnerOrAdmin(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const sound = await ServerAssets.findSoundByIdAndServer(req.params.soundId, req.params.sid);
  if (!sound) return res.status(404).json({ error: 'Sound not found' });

  const filePath = path.join(UPLOAD_DIR, path.basename(sound.url));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  await ServerAssets.deleteSound(req.params.soundId, req.params.sid);
  res.json({ ok: true });
}));

module.exports = router;
export {};
