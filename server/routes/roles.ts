// server/routes/roles.ts
// PERMS, hasPermission, getMemberPerms burada backward-compat için tutulur.
// Yeni kod için: require('../lib/permissions') kullan
import express, { Request, Response, Router } from 'express';
import { authMiddleware} from '../middleware/auth';

import { Channels, Members, Roles, Servers } from '../db/repositories';
import { PERMS, hasPermission, resolvePermissions, resolveRolePermissionResolution, actorRolePosition, canActOn, canManageRole, logAudit, validateBitmask } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';
import { invalidatePerms } from '../lib/permCache';
import { evictUserFromServerRooms, evictSocketsWithoutChannelAccessBestEffort } from '../lib/liveMembership';
import { parsePermissionMask } from '../lib/permissionMaskInvariant';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
interface RoleRow {
  _id: string;
  serverId: string;
  name: string;
  color: string;
  permissions: number;
  position: number;
  displayOnProfile?: boolean;
}

async function getMemberPerms(userId: string, serverId: string): Promise<number> {
  return resolvePermissions(userId, serverId);
}

function sanitizeColor(color: unknown): string {
  if (typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  return '#99aab5';
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * YENI ROLUN HIYERARSI KONUMU
 * ════════════════════════════════════════════════════════════════════════════
 * OLCULEN KUSUR: her rol `position: 0` ile yaratiliyordu ve konumu degistiren
 * BASKA hicbir uc yoktu. Bu yuzden bir sunucudaki TUM roller ayni duzeydeydi.
 *
 * `canManageRole` ve `canActOn` KESIN USTUNLUK arar (`actorTop > target`).
 * Herkes 0'da oldugundan bu karsilastirma sunucu SAHIBI disinda hicbir zaman
 * saglanamiyordu. Sonuc: MANAGE_ROLES verilmis bir moderator kendi yarattigi
 * rolu bile ATAYAMIYOR, KICK_MEMBERS verilmis biri kimseyi ATAMIYORDU.
 * Yetki devri urunde vardi ama CALISMIYORDU.
 *
 * ── KONUM KURALI (YETKI GENISLETMEZ) ────────────────────────────────────────
 * · SAHIP yaratirsa: mevcut en yuksek konumun BIR USTU. Sahibin yetkisi zaten
 *   mutlaktir; bu, devredilen rollere gercek bir duzey kazandirir.
 * · DEVREDILMIS bir aktor yaratirsa: KENDI konumunun BIR ALTI. Boylece
 *   yarattigi rolu yonetebilir, ama kendine esit ya da ustun bir rol
 *   URETEMEZ. Izin kumesi ayrica `grantExceedsActor` ile zaten sinirlidir.
 *
 * Hicbir yetkilendirme kontrolu KALDIRILMADI ya da GEVSETILMEDI; yalnizca
 * karsilastirmalarin uzerinde calistigi siralama gercek hale getirildi.
 */
async function newRolePosition(actorId: string, serverId: string): Promise<number> {
  const actorTop = await actorRolePosition(actorId, serverId);
  if (Number.isFinite(actorTop)) return Math.max(0, actorTop - 1);

  // Sahip: mevcut yiginin uzerine yeni bir duzey acilir.
  const existing = await Roles.findByServer(serverId) as Array<{ position?: number }>;
  const highest = existing.length ? Math.max(0, ...existing.map(r => Number(r.position || 0))) : 0;
  return highest + 1;
}

/**
 * KENDI uyeligi uzerinde rol islemi.
 *
 * `canActOn` KESIN ustunluk arar; bir aktor kendi kendisinden ustun olamaz,
 * dolayisiyla kendi uzerinde HICBIR rol islemi yapamiyordu. Oysa buradaki
 * yetkilendirme zaten iki bagimsiz kapiyla saglanir:
 *
 *   · `canManageRole` — rol, aktorun konumunun ALTINDA olmalidir,
 *   · `grantExceedsActor` — rolun izinleri aktorun izinlerinin ALT KUMESI
 *     olmalidir.
 *
 * Bu iki kapidan gecen bir rolu kendine vermek YENI bir yetki uretmez.
 * Hiyerarsi kurali BASKALARI icin aynen korunur.
 *
 * Moderasyon uclari (kick/ban/timeout) BILEREK bu yardimciyi KULLANMAZ:
 * oradaki "kendine uygulama" sorusu ayri bir urun kararidir ve
 * DEGISTIRILMEMISTIR.
 */
async function canManageOwnOrLowerMember(
  actorId: string, targetUserId: string, serverId: string,
): Promise<boolean> {
  if (actorId === targetUserId) return true;
  return canActOn(actorId, targetUserId, serverId);
}

type ParsedRolePermissions = { ok: true; value: number } | { ok: false; error: string };

/**
 * Role permissions are a persisted authorization boundary, not a loose form field.
 * Preserve an explicit zero mask, reject malformed/unknown bits, and only apply the
 * caller-provided fallback when the field is genuinely omitted.
 */
function parseRolePermissions(value: unknown, fallback: number): ParsedRolePermissions {
  if (value === undefined) return { ok: true, value: fallback };
  try {
    const parsed = parsePermissionMask(value, 'permissions');
    const check = validateBitmask(parsed, 0);
    if (!check.ok) return { ok: false, error: `Invalid permissions: ${check.error}` };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, error: 'permissions must be a canonical non-negative integer bitmask' };
  }
}

const router: Router = express.Router();

/**
 * @openapi
 * /servers/{sid}/roles:
 *   get:
 *     tags: [Roles]
 *     summary: Sunucu rolleri listele
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Rol listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Role' }
 */
router.get('/:sid/roles', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!membership) return void res.status(403).json({ error: 'Not a member' });
  res.json(await Roles.findByServer(String(req.params.sid ?? '')));
});

/**
 * Admin-only, read-only role simulation. This endpoint never creates a user,
 * membership, session, or token; it asks the canonical permission resolver
 * what one role can do in every channel and returns only safe booleans.
 */
router.get('/:sid/roles/:rid/preview', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const rid = String(req.params.rid ?? '');
  const requesterPermissions = await resolvePermissions(_u.id, sid);
  if (!hasPermission(requesterPermissions, PERMS.MANAGE_CHANNELS)) {
    return void res.status(403).json({ error: 'Forbidden' });
  }

  const role = rid === '__everyone__'
    ? { _id: '__everyone__', name: '@everyone' }
    : await Roles.findByIdAndServer(rid, sid) as RoleRow | null;
  if (!role) return void res.status(404).json({ error: 'Role not found in this server' });

  const channels = await Channels.findByServer(sid) as Array<{
    _id: string; name?: string; type?: string; categoryId?: string | null;
  }>;
  const previewChannels = [] as Array<{
    channelId: string;
    name: string;
    type: string;
    categoryId: string | null;
    visible: boolean;
    capabilities: {
      sendMessages: boolean;
      attachFiles: boolean;
      manageMessages: boolean;
      connect: boolean;
      speak: boolean;
    };
  }>;

  for (const channel of channels) {
    const resolution = await resolveRolePermissionResolution(rid, sid, channel._id);
    if (!resolution) return void res.status(404).json({ error: 'Role not found in this server' });
    previewChannels.push({
      channelId: channel._id,
      name: String(channel.name || 'Adsız kanal'),
      type: String(channel.type || 'text'),
      categoryId: channel.categoryId ? String(channel.categoryId) : null,
      visible: hasPermission(resolution.permissions, PERMS.VIEW_CHANNELS),
      capabilities: {
        sendMessages: hasPermission(resolution.permissions, PERMS.SEND_MESSAGES),
        attachFiles: hasPermission(resolution.permissions, PERMS.ATTACH_FILES),
        manageMessages: hasPermission(resolution.permissions, PERMS.MANAGE_MESSAGES),
        connect: hasPermission(resolution.permissions, PERMS.CONNECT),
        speak: hasPermission(resolution.permissions, PERMS.SPEAK),
      },
    });
  }

  res.json({
    simulation: true,
    role: { id: role._id, name: role.name },
    summary: {
      totalChannels: previewChannels.length,
      visibleChannels: previewChannels.filter(channel => channel.visible).length,
      sendableChannels: previewChannels.filter(channel => channel.visible && channel.capabilities.sendMessages).length,
      attachableChannels: previewChannels.filter(channel => channel.visible && channel.capabilities.attachFiles).length,
      manageableChannels: previewChannels.filter(channel => channel.visible && channel.capabilities.manageMessages).length,
    },
    channels: previewChannels,
  });
});

/**
 * @openapi
 * /servers/{sid}/roles:
 *   post:
 *     tags: [Roles]
 *     summary: Rol oluştur
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
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               color: { type: string }
 *               permissions: { type: integer }
 *     responses:
 *       201:
 *         description: Rol oluşturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Role' }
 */

// ════════════════════════════════════════════════════════════════════════════
// YETKI YUKSELTME KORUMASI — KENDINDE OLMAYAN IZIN VERILEMEZ
// ════════════════════════════════════════════════════════════════════════════
// OLCULEN ACIK (gercek API ile dogrulandi):
//   bob'a YALNIZCA MANAGE_ROLES verildi (ADMINISTRATOR YOK).
//     POST /api/servers/:sid/roles { permissions: 1073741824 }  → 200
//       (1073741824 = 1<<30 = ADMINISTRATOR)
//     POST /api/servers/:sid/members/<bob>/roles { roleId }     → 200
//   Sonuc: bob kendine ADMINISTRATOR verdi. Kazanilan gercek yetkiler:
//     kanal olusturma      → 200
//     denetim gunlugu      → 200
//     giden webhook acma   → 201   (mesaj icerigini disari tasiyan yuzey)
//
// KOK SEBEP: rol olusturma/guncelleme, govdeden gelen `permissions` degerini
// AKTORUN KENDI IZINLERIYLE KARSILASTIRMADAN yaziyordu. "Rolleri yonet"
// yetkisi, sunucu sahibinin guvendigi birine verilebilecek SINIRLI bir
// delegasyondur; sessizce ADMINISTRATOR'e yukselmemelidir.
//
// KURAL (Discord ile ayni model): bir aktor YALNIZCA kendisinde bulunan
// izinleri verebilir. Sunucu sahibi ve ADMINISTRATOR sahibi muaftir —
// zaten tum izinlere sahiptirler.
async function grantExceedsActor(
  actorId: string,
  serverId: string,
  actorPerms: number,
  requested: number,
): Promise<boolean> {
  if (hasPermission(actorPerms, PERMS.ADMINISTRATOR)) return false;
  const server = await Servers.findById(serverId) as { ownerId?: string } | null;
  if (server?.ownerId === actorId) return false;
  // Aktorde OLMAYAN her bit bir yukseltmedir.
  return (requested & ~actorPerms) !== 0;
}

router.post('/:sid/roles', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const { name, color, permissions } = body;
  if (typeof name !== 'string' || !name.trim()) return void res.status(400).json({ error: 'Role name required' });
  if (color !== undefined && typeof color !== 'string') return void res.status(400).json({ error: 'Role color must be a string' });

  const parsedPermissions = parseRolePermissions(permissions, PERMS.SEND_MESSAGES);
  if (!parsedPermissions.ok) return void res.status(400).json({ error: parsedPermissions.error });
  const requestedPerms = parsedPermissions.value;
  if (await grantExceedsActor(_u.id, String(req.params.sid ?? ''), Number(perms) || 0, requestedPerms)) {
    return void res.status(403).json({ error: 'Kendinizde olmayan izinleri veremezsiniz' });
  }

  const role = await Roles.insert({
    serverId:    String(req.params.sid ?? ''),
    name:        name.trim().slice(0, 32),
    color:       sanitizeColor(color),
    permissions: requestedPerms,
    position:    await newRolePosition(_u.id, String(req.params.sid ?? '')),
  });
  res.json(role);
});

/**
 * @openapi
 * /servers/{sid}/roles/{rid}:
 *   patch:
 *     tags: [Roles]
 *     summary: Rol güncelle
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               color: { type: string }
 *               permissions: { type: integer }
 *     responses:
 *       200:
 *         description: Güncellenmiş rol
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Role' }
 */
router.patch('/:sid/roles/:rid', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const rid = String(req.params.rid ?? '');
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  // Tenant siniri: yalniz URL'deki sunucuya ait rol okunabilir/guncellenebilir.
  // `findById()` ile cevaplamak, baska sunucudaki bilinen bir rol kimligini
  // MANAGE_ROLES sahibi bir kullaniciya sizdiriyordu.
  const existing = await Roles.findByIdAndServer(rid, sid) as RoleRow | null;
  if (!existing) return void res.status(404).json({ error: 'Role not found in this server' });
  if (!await canManageRole(_u.id, rid, sid))
    return void res.status(403).json({ error: 'Role hierarchy prevents managing this role' });

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
  const { name, color, permissions, displayOnProfile } = body;
  if (name !== undefined && typeof name !== 'string') return void res.status(400).json({ error: 'Role name must be a string' });
  if (color !== undefined && typeof color !== 'string') return void res.status(400).json({ error: 'Role color must be a string' });
  const updates: Record<string, unknown> = {};
  if (typeof name === 'string' && name.trim()) updates['name'] = name.trim().slice(0, 32);
  if (typeof color === 'string' && color) updates['color'] = sanitizeColor(color);
  if (permissions !== undefined) {
    const parsedPermissions = parseRolePermissions(permissions, 0);
    if (!parsedPermissions.ok) return void res.status(400).json({ error: parsedPermissions.error });
    const requestedPerms = parsedPermissions.value;
    // Guncelleme yolu da yukseltmeye acikti: mevcut bir rolu duzenleyerek
    // ADMINISTRATOR eklemek, yeni rol olusturmakla ayni sonucu verirdi.
    if (await grantExceedsActor(_u.id, sid, Number(perms) || 0, requestedPerms)) {
      return void res.status(403).json({ error: 'Kendinizde olmayan izinleri veremezsiniz' });
    }
    updates['permissions'] = requestedPerms;
  }
  // SUNUM AYARI — YETKI DEGILDIR.
  // `displayOnProfile` yalnizca rolun uye profilinde gosterilip
  // gosterilmeyecegini belirler. Izin vermez, izin kaldirmaz, hiyerarsiyi
  // (position) veya kanal yetkilendirmesini ETKILEMEZ. Yine de yalnizca
  // MANAGE_ROLES sahibi degistirebilir (yukaridaki denetim).
  if (displayOnProfile !== undefined) {
    if (typeof displayOnProfile !== 'boolean')
      return void res.status(400).json({ error: 'displayOnProfile must be a boolean' });
    updates['displayOnProfile'] = displayOnProfile;
  }

  await Roles.update(rid, sid, updates);
  const updated = await Roles.findByIdAndServer(rid, sid) as RoleRow | null;

  if (displayOnProfile !== undefined && displayOnProfile !== (existing.displayOnProfile !== false)) {
    await logAudit(sid, _u.id, 'ROLE_PROFILE_VISIBILITY_UPDATE', rid, {
      roleName: existing.name,
      before: { displayOnProfile: existing.displayOnProfile !== false },
      after:  { displayOnProfile },
    });
  }

  // Sunum bayragi izin cozumunu etkilemez. Yalniz permission biti gercekten
  // degistiyse kanonik izin onbellegi gecersizlestirilir.
  if (permissions !== undefined) invalidatePerms(sid);
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, null);
  res.json(updated);
});

/**
 * @openapi
 * /servers/{sid}/roles/{rid}:
 *   delete:
 *     tags: [Roles]
 *     summary: Rol sil
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Rol silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/:sid/roles/:rid', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });
  const sid = String(req.params.sid ?? '');
  const rid = String(req.params.rid ?? '');
  const role = await Roles.findByIdAndServer(rid, sid);
  if (!role) return void res.status(404).json({ error: 'Role not found in this server' });
  if (!await canManageRole(_u.id, rid, sid))
    return void res.status(403).json({ error: 'Role hierarchy prevents managing this role' });
  await Roles.delete(rid, sid);
  invalidatePerms(String(req.params.sid ?? ''));
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), String(req.params.sid ?? ''), null);
  res.json({ deleted: true });
});

/**
 * @openapi
 * /servers/{sid}/members/{uid}/roles:
 *   post:
 *     tags: [Roles]
 *     summary: Üyeye rol ata
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
 *             required: [roleId]
 *             properties:
 *               roleId: { type: string }
 *     responses:
 *       200: { description: Rol atandı }
 */
/**
 * GET /api/servers/:sid/members/:uid/roles
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UYE PROFILINDE ROL GOSTERIMI ICIN SUNUM SOZLESMESI
 * ════════════════════════════════════════════════════════════════════════════
 * Onceden uye->rol eslemesi HICBIR uctan okunamiyordu: `/:sid/members`
 * yalnizca kullanici + `nickname` donuyordu. Bu yuzden profilde rol
 * gosterilemiyordu.
 *
 * BU UC YETKI ICERIGI SIZDIRMAZ: `permissions` bit alani DONDURULMEZ.
 * Yalnizca sunum icin gerekli alanlar doner:
 *     _id, name, color, position
 * Ayrica `displayOnProfile = false` olan roller HIC DONMEZ — gizleme
 * SUNUCUDA uygulanir, istemci filtresine guvenilmez.
 *
 * ERISIM: yalnizca ayni sunucunun uyeleri (istekte bulunan kisi uye olmali).
 * Hiyerarsi sirasi korunur (position DESC) — alfabetik DEGIL.
 */
router.get('/:sid/members/:uid/roles', authMiddleware, async (req: Request, res: Response) => {
  const _u  = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const uid = String(req.params.uid ?? '');

  // Isteyen kisi sunucunun uyesi olmali.
  const viewer = await Members.findOne(_u.id, sid);
  if (!viewer) return void res.status(403).json({ error: 'Not a member' });

  const target = await Members.findOne(uid, sid);
  if (!target) return void res.json([]);

  const raw = (target as { roles?: unknown }).roles;
  const assigned: string[] = Array.isArray(raw)
    ? raw.map(String)
    : (typeof raw === 'string' ? (() => { try { return (JSON.parse(raw) as unknown[]).map(String); } catch { return []; } })() : []);
  if (!assigned.length) return void res.json([]);

  const all = await Roles.findByServer(sid) as Array<{
    _id: string; name?: string; color?: string; position?: number; displayOnProfile?: boolean;
  }>;

  const visible = all
    .filter(r => assigned.includes(String(r._id)))
    .filter(r => r.displayOnProfile !== false)          // SUNUCUDA gizleme
    .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
    .map(r => ({                                        // izin bitleri ASLA cikmaz
      _id: String(r._id),
      name: String(r.name ?? ''),
      color: String(r.color ?? '#99aab5'),
      position: Number(r.position ?? 0),
    }));

  res.json(visible);
});

router.post('/:sid/members/:uid/roles', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const roleIdRaw = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? (req.body as Record<string, unknown>).roleId : undefined;
  if (typeof roleIdRaw !== 'string' || !roleIdRaw.trim() || roleIdRaw.length > 128) return void res.status(400).json({ error: 'roleId required' });
  const roleId = roleIdRaw.trim();

  const sid = String(req.params.sid ?? '');
  const role = await Roles.findByIdAndServer(roleId, sid);
  if (!role) return void res.status(404).json({ error: 'Role not found in this server' });
  if (!await canManageRole(_u.id, roleId, sid))
    return void res.status(403).json({ error: 'Role hierarchy prevents assigning this role' });

  // ATAMA da bir izin verme islemidir. Aktor, kendisinde olmayan izinleri
  // TASIYAN bir rolu kimseye (kendisi dahil) atayamaz — aksi halde
  // olusturma denetimi, var olan yuksek bir rolu atayarak atlatilirdi.
  if (await grantExceedsActor(
    _u.id, sid, Number(perms) || 0,
    Number((role as { permissions?: number }).permissions) || 0,
  )) {
    return void res.status(403).json({ error: 'Kendinizde olmayan izinleri veremezsiniz' });
  }

  const targetUserId = String(req.params.uid ?? '');
  const membership = await Members.findOne(targetUserId, sid);
  if (!membership) return void res.status(404).json({ error: 'Member not found' });
  if (!await canManageOwnOrLowerMember(_u.id, targetUserId, sid))
    return void res.status(403).json({ error: 'Role hierarchy prevents managing this member' });

  const roles = await Members.addRole(String(req.params.uid ?? ''), sid, roleId);
  if (!roles) return void res.status(404).json({ error: 'Member not found' });
  invalidatePerms(sid, String(req.params.uid ?? ''));
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), sid, null);
  res.json({ roles });
});

/**
 * @openapi
 * /servers/{sid}/members/{uid}/roles/{rid}:
 *   delete:
 *     tags: [Roles]
 *     summary: Üyeden rol kaldır
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Rol kaldırıldı }
 */
router.delete('/:sid/members/:uid/roles/:rid', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_ROLES))
    return void res.status(403).json({ error: 'Missing permission: MANAGE_ROLES' });

  const sid = String(req.params.sid ?? '');
  const rid = String(req.params.rid ?? '');
  const role = await Roles.findByIdAndServer(rid, sid);
  if (!role) return void res.status(404).json({ error: 'Role not found in this server' });
  if (!await canManageRole(_u.id, rid, sid))
    return void res.status(403).json({ error: 'Role hierarchy prevents removing this role' });

  const targetUserId = String(req.params.uid ?? '');
  const membership = await Members.findOne(targetUserId, sid);
  if (!membership) return void res.status(404).json({ error: 'Member not found' });
  if (!await canManageOwnOrLowerMember(_u.id, targetUserId, sid))
    return void res.status(403).json({ error: 'Role hierarchy prevents managing this member' });

  const roles = await Members.removeRole(String(req.params.uid ?? ''), String(req.params.sid ?? ''), rid);
  if (!roles) return void res.status(404).json({ error: 'Member not found' });
  invalidatePerms(String(req.params.sid ?? ''), String(req.params.uid ?? ''));
  await evictSocketsWithoutChannelAccessBestEffort(req.app.get('io'), String(req.params.sid ?? ''), null);
  res.json({ roles });
});

/**
 * @openapi
 * /servers/{sid}/members/{uid}/kick:
 *   post:
 *     tags: [Roles, Moderation]
 *     summary: Üyeyi sunucudan at
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
 *       200: { description: Üye atıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/:sid/members/:uid/kick', authMiddleware, limits.roles(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.KICK_MEMBERS))
    return void res.status(403).json({ error: 'Missing permission: KICK_MEMBERS' });
  if (String(req.params.uid ?? '') === _u.id)
    return void res.status(400).json({ error: 'Cannot kick yourself' });

  const targetUserId = String(req.params.uid ?? '');
  const targetServerId = String(req.params.sid ?? '');
  const server = await Servers.findById(targetServerId);
  if (targetUserId === server?.ownerId)
    return void res.status(403).json({ error: 'Cannot kick server owner' });
  const targetMembership = await Members.findOne(targetUserId, targetServerId);
  if (!targetMembership) return void res.status(404).json({ error: 'Member not found' });
  if (!await canActOn(_u.id, targetUserId, targetServerId))
    return void res.status(403).json({ error: 'Role hierarchy prevents kicking this member' });

  await Members.remove(targetUserId, targetServerId);
  invalidatePerms(targetServerId, targetUserId);
  await evictUserFromServerRooms(req.app.get('io'), targetUserId, targetServerId);
  res.json({ kicked: true });
});

export { router, getMemberPerms, hasPermission, PERMS, resolvePermissions, canActOn, canManageRole, logAudit };
export default router;
