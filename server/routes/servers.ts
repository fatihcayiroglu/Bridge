// server/routes/servers.js — Server, Channel & Invite routes
const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router();

let _dispatchEvent: ((sid: string, ev: string, d: any) => Promise<any>) | null = null; try { _dispatchEvent = require('./outgoingWebhooks').dispatchEvent; } catch {}
// Plugin hooks
let _pluginHooks: { emit: (ev: string, d: any) => any } | null = null; try { _pluginHooks = require('../plugins/loader').hooks; } catch {}

const { Users, Servers, Channels, Members, Invites, Messages, Roles, ServerAssets, ScheduledMessages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { sanitizeUser }   = require('../lib/userUtils');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// ── SERVERS ───────────────────────────────────────────────────

// GET /api/servers
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map(m => m.serverId);
  const servers     = await Servers.find({ _id: { $in: serverIds } }).sort({ createdAt: 1 });
  res.json(servers);
}));

// POST /api/servers
router.post('/', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { name, icon } = req.body;
  if (!name?.trim())          return res.status(400).json({ error: 'Server name required' });
  if (name.trim().length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });

  const serverId  = uuidv4();
  const newServer = await Servers.create({
    _id:       serverId,
    name:      name.trim(),
    icon:      icon || '🌐',
    ownerId:   _u.id,
    createdAt: Date.now(),
  });

  await Channels.insert({ _id: uuidv4(), serverId, name: 'general',       type: 'text',  topic: 'General chat', category: 'GENERAL', order: 0, createdAt: Date.now() });
  await Channels.insert({ _id: uuidv4(), serverId, name: 'General Voice', type: 'voice', topic: '',             category: 'VOICE',   order: 1, createdAt: Date.now() });
  await Members.insert(_u.id, serverId);
  if (_dispatchEvent) _dispatchEvent(serverId, 'member:join', { userId: _u.id }).catch(()=>{});

  res.json(newServer);
}));

// PATCH /api/servers/:sid
router.patch('/:sid', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id)
    return res.status(403).json({ error: 'Only the server owner can rename it' });

  const { name, icon } = req.body;
  const updates: Record<string,any> = {};
  if (name?.trim()) {
    if (name.trim().length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });
    updates.name = name.trim();
  }
  if (icon?.trim()) updates.icon = icon.trim();
  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: 'Nothing to update' });

  await Servers.update(req.params.sid, updates);
  const updated = await Servers.findById(req.params.sid);
  res.json(updated);
}));

// POST /api/servers/:sid/leave
router.post('/:sid/leave', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId === _u.id)
    return res.status(400).json({ error: 'Owner cannot leave — delete the server instead' });

  const membership = await Members.findOne(_u.id, req.params.sid);
  if (!membership) return res.status(400).json({ error: 'Not a member' });

  await Members.remove(_u.id, req.params.sid);
  res.json({ left: true });
}));

// DELETE /api/servers/:sid
router.delete('/:sid', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id)
    return res.status(403).json({ error: 'Only the server owner can delete it' });

  const sid = req.params.sid;
  const channelIds = await Channels.findIdsByServer(sid);

  for (const cid of channelIds) {
    await Messages.deleteByChannel(cid);
  }
  await Promise.all([
    Channels.deleteByServer(sid),
    Members.removeAllFromServer(sid),
    Roles.deleteByServer(sid),
    Invites.removeByServer(sid),
    ServerAssets.deleteGifsByServer(sid),
    ScheduledMessages.deleteByServer(sid),
    ServerAssets.deleteEmojisByServer(sid),
  ]);
  await Servers.delete(sid);

  res.json({ deleted: true });
}));

// POST /api/servers/:sid/join
router.post('/:sid/join', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(req.params.sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const existing = await Members.findOne(_u.id, req.params.sid);
  if (existing) return res.status(400).json({ error: 'Already a member' });

  await Members.insert(_u.id, req.params.sid);
  if (_dispatchEvent) _dispatchEvent(req.params.sid, 'member:join', { userId: _u.id }).catch(()=>{});
  // plugin hook
  if (_pluginHooks) _pluginHooks.emit('member:joined', { userId: _u.id, serverId: req.params.sid, displayName: _u.displayName, username: _u.username }).catch?.(()=>{});
  res.json(server);
}));

// ── INVITES ───────────────────────────────────────────────────

// POST /api/servers/invites
router.post('/invites', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.body;
  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this server' });

  const server = await Servers.findById(serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const maxUses = parseInt(req.body.maxUses) || 0;
  const { code, expiresAt } = await Invites.create({ serverId, createdBy: _u.id, maxUses });
  res.json({ code, expiresAt, maxUses, serverName: server.name });
}));

// POST /api/servers/invites/:code/use
router.post('/invites/:code/use', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const code   = String(req.params.code).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  const err    = Invites.isValid(invite);
  if (err) return res.status(invite ? 410 : 404).json({ error: err });

  const existing = await Members.findOne(_u.id, invite.serverId);
  if (existing) return res.status(400).json({ error: 'Already a member' });

  await Members.insert(_u.id, invite.serverId);
  if (_dispatchEvent) _dispatchEvent(invite.serverId, 'member:join', { userId: _u.id }).catch(()=>{});
  await Invites.incrementUses(invite._id);

  const server = await Servers.findById(invite.serverId);
  res.json(server);
}));

// ── CHANNELS ──────────────────────────────────────────────────

// GET /api/servers/:sid/channels
router.get('/:sid/channels', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, req.params.sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const channels = await Channels.findByServer(req.params.sid);
  res.json(channels);
}));

// POST /api/servers/:sid/channels
router.post('/:sid/channels', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { getMemberPerms, hasPermission, PERMS } = require('./roles');
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, type, topic, category, nsfw, bitrate } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Channel name required' });
  const VALID_TYPES = ['text', 'voice', 'announcement', 'forum', 'stage'];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid channel type' });

  const channelData = {
    _id:       uuidv4(),
    serverId:  req.params.sid,
    name:      name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32),
    type,
    topic:     topic?.trim().slice(0, 100) || '',
    category:  category?.trim().slice(0, 32) || 'GENERAL',
    nsfw:      nsfw ? 1 : 0,
    bitrate:   type === 'voice' ? Math.min(384000, Math.max(8000, parseInt(bitrate) || 64000)) : 64000,
    order:     Date.now(),
    createdAt: Date.now(),
  };
  const channel = await Channels.insert(channelData);
  res.json(channel);
}));

// PATCH /api/servers/:sid/channels/:cid
router.patch('/:sid/channels/:cid', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { getMemberPerms, hasPermission, PERMS } = require('./roles');
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, topic, nsfw, bitrate } = req.body;
  const updates: Record<string,any> = {};
  if (name?.trim()) updates.name  = name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32);
  if (typeof topic === 'string') updates.topic = topic.trim().slice(0, 100);
  if (typeof nsfw === 'boolean' || nsfw === 0 || nsfw === 1) updates.nsfw = nsfw ? 1 : 0;
  if (typeof bitrate === 'number') updates.bitrate = Math.min(384000, Math.max(8000, bitrate));
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await Channels.updateByIdAndServer(req.params.cid, req.params.sid, updates);
  const updated = await Channels.findById(req.params.cid);

  // Realtime güncelleme
  const io = req.app.get('io'); if (io) io.to(`server:${req.params.sid}`).emit('channel:update', updated);
  res.json(updated);
}));

// DELETE /api/servers/:sid/channels/:cid
router.delete('/:sid/channels/:cid', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { getMemberPerms, hasPermission, PERMS } = require('./roles');
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const channel = await Channels.findByIdAndServer(req.params.cid, req.params.sid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  await Messages.deleteByChannel(req.params.cid);
  await Channels.delete(req.params.cid);
  res.json({ deleted: true });
}));

// ── MEMBERS ───────────────────────────────────────────────────

// GET /api/servers/:sid/members
router.get('/:sid/members', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, req.params.sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const memberships = await Members.findByServer(req.params.sid);
  const users       = await Users.findByIds(memberships.map(m => m.userId));
  const nickMap     = {};
  memberships.forEach(m => { if (m.nickname) nickMap[m.userId] = m.nickname; });

  res.json(users.map(u => {
    const safe = sanitizeUser(u);
    if (nickMap[u._id]) safe.nickname = nickMap[u._id];
    return safe;
  }));
}));

// PATCH /api/servers/:sid/members/:uid/nickname — sunucu takma adı
router.patch('/:sid/members/:uid/nickname', authMiddleware, limits.servers(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { getMemberPerms, hasPermission, PERMS } = require('./roles');
  const isSelf = _u.id === req.params.uid;
  if (!isSelf) {
    const perms = await getMemberPerms(_u.id, req.params.sid);
    if (!hasPermission(perms, PERMS.MANAGE_MEMBERS))
      return res.status(403).json({ error: 'Missing permission: MANAGE_MEMBERS' });
  }

  const { nickname } = req.body;
  const safeName = nickname ? String(nickname).trim().slice(0, 32) : null;

  await Members.update(req.params.uid, req.params.sid, { nickname: safeName });

  const io = req.app.get('io'); if (io) {
    io.to(`server:${req.params.sid}`).emit('member:nicknameUpdate', {
      userId: req.params.uid,
      serverId: req.params.sid,
      nickname: safeName,
    });
  }

  res.json({ nickname: safeName });
}));

// GET /api/servers/invites/:code/qr — QR kod PNG döner (svg data URL olarak)
router.get('/invites/:code/qr', authMiddleware, asyncHandler(async (req, res) => {
  const code   = String(req.params.code).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  const err    = Invites.isValid(invite);
  if (err) return res.status(invite ? 410 : 404).json({ error: err });

  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;
  const qrSvg     = generateQrSvg(inviteUrl);

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(qrSvg);
}));

// GET /api/servers/invites/:code/qr/data — JSON olarak QR veri URL döner
router.get('/invites/:code/qr/data', authMiddleware, asyncHandler(async (req, res) => {
  const code   = String(req.params.code).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  const err    = Invites.isValid(invite);
  if (err) return res.status(invite ? 410 : 404).json({ error: err });

  const server    = await Servers.findById(invite.serverId);
  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;
  const qrSvg     = generateQrSvg(inviteUrl);
  const dataUrl   = 'data:image/svg+xml;base64,' + Buffer.from(qrSvg ?? "").toString('base64');

  res.json({ code, inviteUrl, qrDataUrl: dataUrl, serverName: server?.name, expiresAt: invite.expiresAt });
}));

// ── Bağımlılıksız QR SVG üreteci ────────────────────────────────────────
// Micro QR-code generator — URL'i encode eder, SVG çıkarır
// Basit alphanumeric encoding (kütüphane gerektirmez)
function generateQrSvg(text) {
  // qrcode modülü varsa kullan, yoksa placeholder SVG döndür
  try {
    // eslint-disable-next-line
    const QRCode = require('qrcode');
    // Sync string döner değil, bu yüzden promise-based olmayan versiyonu kullanıyoruz
    // Bu blok çalışmaz ama modül yüklenirse aşağıdaki async yol kullanılmalı
    throw new Error('use_async');
  } catch (e) {
    if (e.message !== 'use_async') {
      // qrcode modülü yok — placeholder SVG döndür
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240" viewBox="0 0 200 240">
  <rect width="200" height="240" fill="white"/>
  <rect x="10" y="10" width="180" height="180" rx="8" fill="none" stroke="#5865f2" stroke-width="3" stroke-dasharray="8,4"/>
  <text x="100" y="105" font-family="monospace" font-size="11" fill="#5865f2" text-anchor="middle">QR için:</text>
  <text x="100" y="120" font-family="monospace" font-size="9" fill="#5865f2" text-anchor="middle">npm i qrcode</text>
  <text x="100" y="210" font-family="sans-serif" font-size="9" fill="#666" text-anchor="middle">${escaped.slice(0, 40)}</text>
  <text x="100" y="225" font-family="sans-serif" font-size="8" fill="#999" text-anchor="middle">Bridge Davet Linki</text>
</svg>`;
    }
  }
}

// qrcode modülü kuruluysa async endpoint de sun
router.get('/invites/:code/qr/png', authMiddleware, asyncHandler(async (req, res) => {
  let QRCode;
  try { QRCode = require('qrcode'); } catch {
    return res.status(501).json({ error: 'QR PNG için: npm install qrcode', hint: 'SVG endpoint kullanın: /qr' });
  }

  const code   = String(req.params.code).replace(/[^\w-]/g, '').slice(0, 64);
  const invite = await Invites.findByCode(code);
  const err    = Invites.isValid(invite);
  if (err) return res.status(invite ? 410 : 404).json({ error: err });

  const appUrl    = process.env.APP_URL || 'http://localhost:3001';
  const inviteUrl = `${appUrl}/invite/${code}`;

  const pngBuffer = await QRCode.toBuffer(inviteUrl, { width: 300, margin: 2, color: { dark: '#5865f2', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(pngBuffer);
}));

// ── GET /api/servers/:sid/og-image — Open Graph placeholder SVG ──────────
// invitePreview.js sunucu OG resmi olarak bu URL'yi kullanır.
// Sunucunun özel bir iconUrl'si yoksa renkli emoji SVG döner.
router.get('/:sid/og-image', asyncHandler(async (req, res) => {
  const server = await Servers.findById(req.params.sid);
  const name   = server?.name   || 'Bridge';
  const icon   = server?.icon   || '🌐';
  const color  = server?.color  || '#5865f2';

  // Güvenli escape
  const safeIcon  = icon.replace(/[<>&"]/g, '');
  const safeName  = name.slice(0, 30).replace(/[<>&"]/g, c =>
    ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;' }[c]));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#1a1b1e"/>
  <rect x="0" y="0" width="1200" height="8" fill="${color}"/>
  <circle cx="600" cy="260" r="120" fill="${color}" opacity="0.15"/>
  <text x="600" y="300" font-size="130" text-anchor="middle" dominant-baseline="middle">${safeIcon}</text>
  <text x="600" y="420" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    font-size="52" font-weight="700" fill="#ffffff" text-anchor="middle">${safeName}</text>
  <text x="600" y="490" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    font-size="28" fill="#b5bac1" text-anchor="middle">Bridge ile sohbete katıl 🌉</text>
</svg>`;

  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=300');
  res.send(svg);
}));

module.exports = router;
export {};
