// server/routes/servers/core.ts — Server CRUD routes
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

import { tryRequire } from '../../lib/_optional-require';
const _dispatchEvent = tryRequire<{ dispatchEvent: (sid: string, ev: string, d: unknown) => Promise<unknown> }>('../outgoingWebhooks')?.dispatchEvent ?? null;
const _pluginHooks   = tryRequire<{ hooks: { emit: (ev: string, d: unknown) => unknown } }>('../../plugins/loader')?.hooks ?? null;

import { Users, Servers, Channels, Members, Messages, Roles, Invites, ServerAssets, ScheduledMessages, Auth } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { sanitizeUser } from '../../lib/userUtils';
import { getMemberPerms, hasPermission, PERMS } from '../roles';
import { limits } from '../../middleware/rateLimit';
import { invalidateMemberships } from '../../lib/presenceCache';
import { invalidateMemberCount } from '../discover';

// GET /api/servers
/**
 * @openapi
 * /servers:
 *   get:
 *     tags: [Servers]
 *     summary: Kullanıcının üye olduğu sunucuları listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Sunucu listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Server' }

 *
 * /servers:
 *   get:
 *     tags: [Servers]
 *     summary: Kullanicinin katildigi sunuculari listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Sunucu listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Server' }
 *   post:
 *     tags: [Servers]
 *     summary: Yeni sunucu olustur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, maxLength: 100 }
 *               description: { type: string, maxLength: 500 }
 *               icon:        { type: string }
 *     responses:
 *       201:
 *         description: Sunucu olusturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Server' }
 *
 * /servers/{sid}:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu detayini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sunucu detayi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Server' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Servers]
 *     summary: Sunucu ayarlarini guncelle
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
 *             properties:
 *               name:        { type: string }
 *               description: { type: string }
 *               icon:        { type: string }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Sunucuyu sil (sadece sahip)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/leave:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucudan ayril
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ayrilindi
 *
 * /servers/{sid}/members:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu uyelerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *     responses:
 *       200:
 *         description: Uye listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/members/{uid}:
 *   patch:
 *     tags: [Servers]
 *     summary: Uye bilgilerini guncelle (nick, roller)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nick:  { type: string, maxLength: 32 }
 *               roles: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Uyeyi sunucudan kick et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Kicklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/audit-log:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu denetim logu
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Denetim logu
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map(m => m.serverId);
  const servers     = (await Servers.find({ _id: { $in: serverIds } })).sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  res.json(servers);
});

// POST /api/servers
/**
 * @openapi
 * /servers:
 *   post:
 *     tags: [Servers]
 *     summary: Yeni sunucu oluştur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 50, example: "Bridge HQ" }
 *               icon: { type: string, example: "🌐" }
 *     responses:
 *       200:
 *         description: Oluşturulan sunucu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Server' }
 *       400: { description: Geçersiz istek }
 */
router.post('/', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { name, icon } = req.body as Record<string, string>;
  if (!name?.trim())           return res.status(400).json({ error: 'Server name required' });
  if (name.trim().length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });

  // SECURITY: Kullanıcı başına sunucu üst sınırı — resource exhaustion önleme
  const MAX_SERVERS_PER_USER = parseInt(process.env.MAX_SERVERS_PER_USER || '100', 10);
  const ownedServers = await Servers.findByOwner(_u.id);
  if (ownedServers.length >= MAX_SERVERS_PER_USER)
    return res.status(400).json({ error: `Server creation limit reached (max ${MAX_SERVERS_PER_USER})` });

  // SECURITY: icon alanı sanitize — XSS ve script injection önleme
  // Yalnızca tek emoji veya boş string kabul edilir; uzun string veya HTML reddedilir.
  let safeIcon = '🌐';
  if (icon && typeof icon === 'string') {
    const trimmed = icon.trim().slice(0, 10); // Unicode emoji max 2 codepoint = 8 byte
    // HTML/script içeriyorsa reddet
    if (/<|>|javascript:|on\w+\s*=/i.test(trimmed)) {
      return res.status(400).json({ error: 'Invalid icon value' });
    }
    safeIcon = trimmed || '🌐';
  }

  const serverId  = uuidv4();
  const newServer = await Servers.create({
    _id:       serverId,
    name:      name.trim(),
    icon:      safeIcon,
    ownerId:   _u.id,
    createdAt: Date.now(),
  });

  await Channels.insert({ _id: uuidv4(), serverId, name: 'general',       type: 'text',  topic: 'General chat', category: 'GENERAL', order: 0, createdAt: Date.now() });
  await Channels.insert({ _id: uuidv4(), serverId, name: 'General Voice', type: 'voice', topic: '',             category: 'VOICE',   order: 1, createdAt: Date.now() });
  await Members.insert(_u.id, serverId);
  if (_dispatchEvent) _dispatchEvent(serverId, 'member:join', { userId: _u.id }).catch(() => {});

  res.json(newServer);
});

// PATCH /api/servers/:sid
/**
 * @openapi
 * /servers/{serverId}:
 *   patch:
 *     tags: [Servers]
 *     summary: Sunucu bilgilerini güncelle (yalnızca sahip)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, maxLength: 50 }
 *               icon: { type: string }
 *     responses:
 *       200: { description: Güncellenmiş sunucu }
 *       403: { description: Yetki yok }
 *       404: { description: Sunucu bulunamadı }
 *   delete:
 *     tags: [Servers]
 *     summary: Sunucuyu sil (yalnızca sahip)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Silindi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *       403: { description: Yetki yok }
 *       404: { description: Sunucu bulunamadı }
 */
router.patch('/:sid', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only the server owner can rename it' });

  const { name, icon, mfaLevel } = req.body as Record<string, string>;
  const updates: Record<string, unknown> = {};
  if (name?.trim()) {
    if (name.trim().length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });
    updates.name = name.trim();
  }
  if (icon?.trim()) {
    // SECURITY: icon XSS validation
    if (/<|>|javascript:|on\w+\s*=/i.test(icon.trim())) {
      return res.status(400).json({ error: 'Invalid icon value' });
    }
    updates.icon = icon.trim().slice(0, 10);
  }
  // Sprint 121 FIX 15: mfaLevel — sadece sunucu sahibi ayarlayabilir (0/1/2)
  if (mfaLevel !== undefined) {
    if (![0, 1, 2].includes(Number(mfaLevel))) {
      return res.status(400).json({ error: 'mfaLevel must be 0, 1, or 2' });
    }
    updates.mfaLevel = Number(mfaLevel);
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await Servers.update(String(req.params.sid ?? ''), updates);
  const updated = await Servers.findById(String(req.params.sid ?? ''));
  res.json(updated);
});

// POST /api/servers/:sid/leave
/**
 * @openapi
 * /servers/{serverId}/members:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu üyelerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Üye listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/UserProfile' }
 * /servers/{serverId}/leave:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucudan ayrıl
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Ayrıldı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left: { type: boolean }
 *       400: { description: Sahip ayrılamaz }
 * /servers/{serverId}/join:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucuya katıl (public)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Katıldı }
 *       400: { description: Zaten üye }
 *       404: { description: Sunucu bulunamadı }
 */
router.post('/:sid/leave', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId === _u.id)
    return res.status(400).json({ error: 'Owner cannot leave — delete the server instead' });

  const membership = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!membership) return res.status(400).json({ error: 'Not a member' });

  await Members.remove(_u.id, String(req.params.sid ?? ''));
  await invalidateMemberships(_u.id);
  invalidateMemberCount(String(req.params.sid ?? '')).catch(() => {});
  res.json({ left: true });
});

// DELETE /api/servers/:sid
router.delete('/:sid', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only the server owner can delete it' });

  const sid = String(String(req.params.sid ?? '') ?? "");
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
});

// POST /api/servers/:sid/join
router.post('/:sid/join', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const existing = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (existing) return res.status(400).json({ error: 'Already a member' });

  // Sprint 121 FIX 15: mfaLevel enforcement — sunucu 2FA zorunluluğu
  // mfaLevel 0 = kapalı, 1 = mod/admin zorunlu (join'de 1 de enforce edilir), 2 = herkes
  const mfaLevel = Number((server as unknown as Record<string, unknown>).mfaLevel ?? 0);
  if (mfaLevel >= 1) {
    // Kullanıcının kayıtlı passkey'i var mı?
    const credentials = await Auth.findCredentialsByUser(_u.id).catch(() => []);
    if (!credentials.length) {
      return res.status(403).json({
        error: 'MFA_REQUIRED',
        message: 'Bu sunucuya katılmak için bir güvenlik anahtarı (passkey) kaydetmeniz gerekiyor.',
        mfaLevel,
      });
    }
  }

  await Members.insert(_u.id, String(req.params.sid ?? ''));
  await invalidateMemberships(_u.id);
  invalidateMemberCount(String(req.params.sid ?? '')).catch(() => {});
  if (_dispatchEvent) _dispatchEvent(String(req.params.sid ?? ''), 'member:join', { userId: _u.id }).catch(() => {});
  if (_pluginHooks) (_pluginHooks.emit as Function)('member:joined', { userId: _u.id, serverId: String(req.params.sid ?? ''), displayName: _u.displayName, username: _u.username });
  res.json(server);
});

// GET /api/servers/:sid/members
router.get('/:sid/members', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const memberships = await Members.findByServer(String(req.params.sid ?? ''));
  const users       = await Users.findByIds(memberships.map(m => m.userId));
  const nickMap: Record<string, string> = {};
  memberships.forEach(m => { if (m.nickname) nickMap[m.userId] = m.nickname; });

  res.json(users.map(u => {
    const safe = sanitizeUser(u) as unknown as Record<string, unknown>;
    if (nickMap[u._id]) safe.nickname = nickMap[u._id];
    return safe;
  }));
});

// PATCH /api/servers/:sid/members/:uid/nickname
router.patch('/:sid/members/:uid/nickname', authMiddleware, limits.servers(), async (req, res) => {
  const _u    = castAuthed(req).user;
  const isSelf = _u.id === String(req.params.uid ?? '');
  if (!isSelf) {
    const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
    if (!hasPermission(perms, PERMS.MANAGE_MEMBERS))
      return res.status(403).json({ error: 'Missing permission: MANAGE_MEMBERS' });
  }

  const { nickname } = req.body as Record<string, string>;
  const safeName = nickname ? String(nickname).trim().slice(0, 32) : null;
  await Members.update(String(req.params.uid ?? ''), String(req.params.sid ?? ''), { nickname: safeName });

  const io = req.app.get('io');
  if (io) {
    io.to(`server:${String(req.params.sid ?? '')}`).emit('member:nicknameUpdate', {
      userId: String(req.params.uid ?? ''), serverId: String(req.params.sid ?? ''), nickname: safeName,
    });
  }
  res.json({ nickname: safeName });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
