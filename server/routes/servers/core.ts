// server/routes/servers/core.ts — Server CRUD routes
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

import { Users, Servers, Members, Auth } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { sanitizeUser } from '../../lib/userUtils';
import { getMemberPerms, hasPermission, PERMS } from '../roles';
import { limits } from '../../middleware/rateLimit';
import { invalidateMemberships } from '../../lib/presenceCache';
import { invalidatePerms } from '../../lib/permCache';
import { invalidateMemberCount } from '../discover';
import { evictUserFromServerRooms } from '../../lib/liveMembership';
import { envSafeInt } from '../../lib/envNumbers';
import { joinDiscoverableServer, afterMemberJoined } from '../../lib/serverMembership';
import { parseServerMfaLevelWrite } from '../../lib/serverMfaPolicy';
import {
  raidProtectionStatus,
  type RaidMitigationLevel,
} from '../../lib/raidProtection';
import logger from '../../lib/logger';
import { enforceStepUp } from '../../lib/stepUp';

// GET /api/servers
/**
 * @openapi
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
 *         description: Enables the structured cursor response; maximum 100.
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 100 }
 *       - in: query
 *         name: cursor
 *         description: Opaque nextCursor from a previous structured response.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Legacy array without query parameters, otherwise a structured cursor page.
 *       403: { $ref: '#/components/responses/Forbidden' }
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
  // Faz 10.11 — GÖVDE TİP DOĞRULAMASI.
  // `name?.trim()` yalnız null/undefined'a karşı korumalıydı; sayı veya nesne
  // gönderildiğinde `.trim` bir fonksiyon olmadığı için TypeError fırlıyor ve
  // istemci açıklanamayan 500 alıyordu (tests/server-create-join.test.ts).
  // Yalnız düz string kabul edilir; diğer her tip 400'dür.
  const body     = req.body as Record<string, unknown> | undefined;
  const rawName  = body?.name;
  const icon     = typeof body?.icon === 'string' ? body.icon : undefined;
  const name     = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name)           return res.status(400).json({ error: 'Server name required' });
  if (name.length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });

  // SECURITY: the repository enforces this limit inside the same per-owner
  // PostgreSQL transaction/lock as creation, so concurrent requests cannot
  // both pass a racy count and exceed the resource bound.
  const MAX_SERVERS_PER_USER = envSafeInt('MAX_SERVERS_PER_USER', 100, { min: 1, max: 100_000 });

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

  const serverId = uuidv4();
  const createdAt = Date.now();
  const created = await Servers.createWithDefaultsAtomic({
    serverId,
    ownerId: _u.id,
    name,
    icon: safeIcon,
    textChannelId: uuidv4(),
    voiceChannelId: uuidv4(),
    createdAt,
    maxOwnedServers: MAX_SERVERS_PER_USER,
  });
  if (created.status === 'limit') {
    return res.status(400).json({ error: `Server creation limit reached (max ${MAX_SERVERS_PER_USER})` });
  }

  await afterMemberJoined(
    { id: _u.id, username: _u.username, displayName: _u.displayName },
    serverId,
  );
  return res.json(created.server);
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
 *               aiEnabled: { type: boolean, description: "P6: false = this server's content is never sent to an AI provider" }
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

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const { name, icon, mfaLevel, aiEnabled } = body;
  const updates: Record<string, unknown> = {};
  // P6 — per-server AI opt-out. Owner only (this route is owner-only); a strict
  // boolean, never coerced: "false" or 0 from a careless client is refused
  // rather than silently re-enabling or disabling AI.
  if (aiEnabled !== undefined) {
    if (typeof aiEnabled !== 'boolean') return res.status(400).json({ error: 'aiEnabled must be a boolean' });
    updates.aiEnabled = aiEnabled;
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Server name must be a string' });
  }
  if (icon !== undefined && typeof icon !== 'string') {
    return res.status(400).json({ error: 'Server icon must be a string' });
  }
  if (typeof name === 'string' && name.trim()) {
    if (name.trim().length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });
    updates.name = name.trim();
  }
  if (typeof icon === 'string' && icon.trim()) {
    // SECURITY: icon XSS validation
    if (/<|>|javascript:|on\w+\s*=/i.test(icon.trim())) {
      return res.status(400).json({ error: 'Invalid icon value' });
    }
    updates.icon = icon.trim().slice(0, 10);
  }
  // Sprint 121 FIX 15: mfaLevel — sadece sunucu sahibi ayarlayabilir (0/1/2)
  if (mfaLevel !== undefined) {
    const parsedMfaLevel = parseServerMfaLevelWrite(mfaLevel);
    if (parsedMfaLevel === null) {
      return res.status(400).json({ error: 'mfaLevel must be the integer 0, 1, or 2' });
    }
    updates.mfaLevel = parsedMfaLevel;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await Servers.update(String(req.params.sid ?? ''), updates);
  const updated = await Servers.findById(String(req.params.sid ?? ''));
  res.json(updated);
});

// GET/PATCH /api/servers/:sid/raid-protection
//
// P7 B1 — moderator-visible and reversible anti-raid controls. The configured
// level and exact thresholds are returned so enforcement is explainable.
// MANAGE_SERVER is the authorization boundary; UI visibility is not.
router.get('/:sid/raid-protection', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid) as Record<string, unknown> | null;
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  }

  return res.json(raidProtectionStatus(server));
});

router.patch('/:sid/raid-protection', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid) as Record<string, unknown> | null;
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const hasLevel = Object.prototype.hasOwnProperty.call(body, 'level');
  const hasClear = Object.prototype.hasOwnProperty.call(body, 'clearLockdown');

  let level: RaidMitigationLevel | undefined;
  if (hasLevel) {
    if (body.level !== 'off' && body.level !== 'balanced' && body.level !== 'strict') {
      return res.status(400).json({ error: 'level must be off, balanced, or strict' });
    }
    level = body.level;
  }

  let clearLockdown = false;
  if (hasClear) {
    if (typeof body.clearLockdown !== 'boolean') {
      return res.status(400).json({ error: 'clearLockdown must be a boolean' });
    }
    clearLockdown = body.clearLockdown;
  }

  if (!hasLevel && !clearLockdown) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const previous = raidProtectionStatus(server);
  const updates: Record<string, unknown> = {};
  if (level !== undefined) updates.raidMitigationLevel = level;
  if (clearLockdown || level === 'off') updates.raidLockdownUntil = null;

  await Servers.update(sid, updates);
  // Ending raid mode also lifts the posting holds it placed (and only those).
  const releasedHolds = (clearLockdown || level === 'off') && previous.lockdownUntil !== null
    ? await Members.releaseRaidHold(sid, previous.lockdownUntil)
    : 0;
  const updated = await Servers.findById(sid) as Record<string, unknown> | null;
  if (!updated) return res.status(404).json({ error: 'Server not found' });
  const next = raidProtectionStatus(updated);

  try {
    await Auth.insertAuditLog({
      serverId: sid,
      actorId: _u.id,
      actorName: _u.displayName || _u.username || _u.id,
      action: clearLockdown || level === 'off'
        ? 'raid_protection_reversed'
        : 'raid_protection_updated',
      target: sid,
      extra: {
        previous: {
          level: previous.level,
          lockdownUntil: previous.lockdownUntil,
        },
        next: {
          level: next.level,
          lockdownUntil: next.lockdownUntil,
        },
        releasedHolds,
      },
    });
  } catch (auditError) {
    // The policy update is already durable; do not falsely report it failed.
    // Audit degradation is still operationally visible.
    logger.warn({
      event: 'raid.config.audit_failed',
      serverId: sid,
      actorId: _u.id,
      err: auditError instanceof Error ? auditError.message : String(auditError),
    }, 'Raid protection update committed but audit logging failed.');
  }

  return res.json({ ...next, releasedHolds });
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
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Parametresiz çağrıda eski dizi; limit/cursor ile yapılandırılmış cursor sayfası
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: array
 *                   items: { $ref: '#/components/schemas/UserProfile' }
 *                 - type: object
 *                   required: [members, hasMore, nextCursor, limit, count]
 *                   properties:
 *                     members:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/UserProfile' }
 *                     hasMore: { type: boolean }
 *                     nextCursor: { type: string, nullable: true }
 *                     limit: { type: integer }
 *                     count: { type: integer }
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

  const leavingServerId = String(req.params.sid ?? '');
  await Members.remove(_u.id, leavingServerId);
  invalidatePerms(leavingServerId, _u.id);
  await invalidateMemberships(_u.id);
  await evictUserFromServerRooms(req.app.get('io'), _u.id, leavingServerId);
  invalidateMemberCount(String(req.params.sid ?? '')).catch(() => {});
  res.json({ left: true });
});

// DELETE /api/servers/:sid
router.delete('/:sid', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only the server owner can delete it' });
  // P7 B2: irreversible for every member — the owner proves it is still them
  // (`destructive-admin` step-up). Checked after ownership so only the owner is asked.
  if (!(await enforceStepUp(req, res, _u.id, 'server.delete'))) return;

  const sid = String(req.params.sid ?? '');
  // Tek canonical owner: production PostgreSQL'de bütün server graph tek
  // transaction'da silinir. Route-level paralel kaskadlar yarım tenant ve
  // yeni tablolar eklendikçe orphan veri bırakıyordu.
  const result = await Servers.deleteGraphAtomic(sid, _u.id);
  if (result === 'not_found') return res.status(404).json({ error: 'Server not found' });
  if (result === 'owner_mismatch') return res.status(403).json({ error: 'Only the current server owner can delete it' });
  res.json({ deleted: true });
});

// POST /api/servers/:sid/join
router.post('/:sid/join', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const result = await joinDiscoverableServer(
    { id: _u.id, username: _u.username, displayName: _u.displayName },
    sid,
  );

  if (result.status === 'not_found') return res.status(404).json({ error: 'Server not found' });
  if (result.status === 'invite_required') {
    return res.status(403).json({ error: 'INVITE_REQUIRED', message: 'Bu sunucuya yalnızca davet ile katılabilirsiniz.' });
  }
  if (result.status === 'banned') {
    return res.status(403).json({ error: 'BANNED', message: 'Bu sunucudan yasaklandınız.' });
  }
  if (result.status === 'raid_lockdown') {
    const retryAfterMs = Math.max(1, result.retryAfterMs ?? 1_000);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    return res.status(429).json({
      error: 'RAID_LOCKDOWN',
      retryAfterMs,
      lockdownUntil: result.lockdownUntil ?? null,
      level: result.raidLevel,
    });
  }
  if (result.status === 'raid_authority_unavailable') {
    const retryAfterMs = Math.max(1, result.retryAfterMs ?? 1_000);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    return res.status(503).json({
      error: 'RAID_PROTECTION_UNAVAILABLE',
      retryAfterMs,
    });
  }
  if (result.status === 'already_member') return res.status(400).json({ error: 'Already a member' });
  if (result.status === 'mfa_required') {
    return res.status(403).json({
      error: 'MFA_REQUIRED',
      message: 'Bu sunucuya katılmak için bir güvenlik anahtarı (passkey) kaydetmeniz gerekiyor.',
      mfaLevel: result.mfaLevel,
    });
  }

  return res.json(result.server);
});

// GET /api/servers/:sid/members
router.get('/:sid/members', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const paginationRequested = req.query.limit !== undefined || req.query.cursor !== undefined;
  if (!paginationRequested) {
    // Backward compatibility: clients that omit pagination parameters retain
    // the historical bare-array response until every consumer has migrated.
    const memberships = await Members.findByServer(serverId);
    const users       = await Users.findByIds(memberships.map(m => m.userId));
    const nickMap: Record<string, string> = {};
    memberships.forEach(m => { if (m.nickname) nickMap[m.userId] = m.nickname; });

    return res.json(users.map(u => {
      const safe = sanitizeUser(u) as unknown as Record<string, unknown>;
      if (nickMap[u._id]) safe.nickname = nickMap[u._id];
      return safe;
    }));
  }

  let limit = 100;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
    const parsed = Number(req.query.limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
    limit = parsed;
  }

  let cursor: { joinedAt: number; userId: string } | undefined;
  if (req.query.cursor !== undefined) {
    const rawCursor = req.query.cursor;
    if (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 512) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    try {
      const decoded = JSON.parse(Buffer.from(rawCursor, 'base64').toString('utf8')) as {
        joinedAt?: unknown;
        userId?: unknown;
      } | null;
      if (!decoded || typeof decoded !== 'object' ||
          !Number.isSafeInteger(decoded.joinedAt) || Number(decoded.joinedAt) < 0 ||
          typeof decoded.userId !== 'string' || decoded.userId.length === 0 || decoded.userId.length > 200) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
      cursor = { joinedAt: Number(decoded.joinedAt), userId: decoded.userId };
    } catch {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const rawPage = await Members.findPageByServer(serverId, { limit: limit + 1, cursor });
  const hasMore = rawPage.length > limit;
  const page = hasMore ? rawPage.slice(0, limit) : rawPage;
  const userIds = page.map(row => String(row.userId));
  const users = await Users.findByIds(userIds);
  const usersById = new Map(users.map(user => [user._id, user]));
  const members = page.flatMap(row => {
    const userId = String(row.userId);
    const user = usersById.get(userId);
    if (!user) return [];
    const safe = sanitizeUser(user) as unknown as Record<string, unknown>;
    if (row.nickname) safe.nickname = String(row.nickname);
    return [safe];
  });
  const boundary = page.at(-1);
  const nextCursor = hasMore && boundary
    ? Buffer.from(JSON.stringify({
      joinedAt: Number(boundary.joinedAt),
      userId: String(boundary.userId),
    })).toString('base64')
    : null;

  return res.json({ members, hasMore, nextCursor, limit, count: members.length });
});

/**
 * GET /api/servers/:sid/me/permissions
 *
 * FAZ C2 — İSTEMCİ YETKİ SİNYALİ.
 *
 * İstemcinin, çağıranın ÇÖZÜLMÜŞ sunucu düzeyi izin bitlerini öğrenebileceği
 * hiçbir uç yoktu. Bu yüzden "MANAGE_CHANNELS varsa göster" gibi bir açıcı
 * yazılamıyordu: istemci ya herkese ölü bir kontrol gösterecekti ya da yalnız
 * sahibe gösterip rol tabanlı yöneticileri dışarıda bırakacaktı.
 *
 * Bu uç YALNIZCA ÇAĞIRANIN KENDİ bitlerini döner — başkasının izinleri
 * sızdırılmaz. Kanal izin rotaları da yetkilendirmeyi tam olarak bu düzeyde
 * yapar (`resolvePermissions(user, sid)`, kanal kimliği verilmeden), bu yüzden
 * sinyal ile gerçek kapı AYNI değeri kullanır ve sapamaz.
 *
 * GÜVENLİK: bu bir GÖRÜNÜRLÜK sinyalidir, yetki sınırı DEĞİLDİR. Gerçek sınır
 * her zaman yazma rotalarındaki kontrollerdir. Üye olmayan veya var olmayan
 * sunucu için ayrım yapılmadan 0 döner (varlık sızıntısı yok).
 */
router.get('/:sid/me/permissions', authMiddleware, async (req, res) => {
  const _u  = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  if (!sid) return res.json({ permissions: 0 });

  const permissions = await getMemberPerms(_u.id, sid);
  res.json({ permissions: Number(permissions) || 0 });
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
