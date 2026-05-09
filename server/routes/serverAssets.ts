// server/routes/serverAssets.js — Server Banner & Icon Image Upload
const express    = require('express');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router({ mergeParams: true });
const { Servers, Members, Roles } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

const UPLOAD_DIR = path.join(__dirname, '../uploads/server-assets');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10).toLowerCase();
    cb(null, `sa_${uuidv4()}${ext}`);
  },
});

const assetUpload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/png','image/gif','image/webp','image/jpeg'].includes(file.mimetype);
    cb(ok ? null : new Error('Only images allowed'), ok);
  },
});

async function isOwner(userId, serverId) {
  const server = await Servers.findById(serverId);
  if (!server) return false;
  if (server.ownerId === userId) return true;
  const membership = await Members.findOne(userId, serverId);
  if (!membership) return false;
  const roleIds = membership.roles || [];
  if (!roleIds.length) return false;
  const roles = await Roles.findWhere({ _id: { $in: roleIds } });
  return roles.some(r => (r.permissions & 64) || (r.permissions & 1));
}

function deleteOldFile(url) {
  if (!url) return;
  const filePath = path.join(__dirname, '../uploads/server-assets', path.basename(url));
  if (fs.existsSync(filePath)) try { fs.unlinkSync(filePath); } catch {}
}

// POST /api/servers/:sid/banner
router.post('/banner', authMiddleware, limits.write(), (req, res, next) => {
  assetUpload.single('banner')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Only server admins can set a banner' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const server = await Servers.findById(req.params.sid);
  deleteOldFile(server?.bannerUrl);

  const bannerUrl = `/uploads/server-assets/${req.file.filename}`;
  await Servers.update(req.params.sid, { bannerUrl });
  res.json({ bannerUrl });
}));

// DELETE /api/servers/:sid/banner
router.delete('/banner', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Only server admins can remove the banner' });

  const server = await Servers.findById(req.params.sid);
  deleteOldFile(server?.bannerUrl);
  await Servers.update(req.params.sid, { bannerUrl: null });
  res.json({ bannerUrl: null });
}));

// POST /api/servers/:sid/icon-image
router.post('/icon-image', authMiddleware, limits.write(), (req, res, next) => {
  assetUpload.single('icon')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Only server admins can set a server icon' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const server = await Servers.findById(req.params.sid);
  deleteOldFile(server?.iconUrl);

  const iconUrl = `/uploads/server-assets/${req.file.filename}`;
  await Servers.update(req.params.sid, { iconUrl });
  res.json({ iconUrl });
}));

// DELETE /api/servers/:sid/icon-image
router.delete('/icon-image', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await isOwner(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Only server admins can remove the server icon' });

  const server = await Servers.findById(req.params.sid);
  deleteOldFile(server?.iconUrl);
  await Servers.update(req.params.sid, { iconUrl: null });
  res.json({ iconUrl: null });
}));

module.exports = router;
export {};
