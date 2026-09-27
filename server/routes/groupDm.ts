// CANLI KUSUR: `sanitizeUser` './auth'ten import ediliyordu ama orada
// EXPORT EDILMIYOR (auth.ts onu yalnizca ithal ediyor). Sonuc: calisma
// zamaninda `(0, auth_2.sanitizeUser) is not a function` -> GRUP DM
// OLUSTURMA her seferinde 500. Kanonik kaynak: lib/userUtils (auth.ts:55
// zaten bunu soyluyor, friends.ts de boyle kullaniyor).
import { sanitizeUser } from '../lib/userUtils';
// server/routes/groupDm.ts
import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../middleware/auth';

import { GroupDms, Users } from '../db/repositories';

import { limits } from '../middleware/rateLimit';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { createLogger } from '../lib/logger';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../lib/queryNumbers';
import { parsePersistedEpochMillis } from '../lib/persistedEpoch';
const logger = createLogger('groupDm');
// Kanonik `GroupDm` varliginda `name` OPSIYONELDIR (DB kolonu `username`
// takma adidir ve NULL olabilir). Bu yerel daraltma onu ZORUNLU ilan ediyordu;
// repository sonucu bu yuzden atanamiyor ve dosya derlenmiyordu.
interface GroupRow { _id: string; name?: string; ownerId: string; icon?: string | null; createdAt: number; lastMessageAt?: number }

/**
 * FAZ C4 — SOKET ODASI ÜYELİĞİ, VERİTABANI ÜYELİĞİNİ TAKİP ETMEK ZORUNDA.
 *
 * ── KAPATILAN GERÇEK AÇIK ──────────────────────────────────────────────────
 * Soket bağlanırken kullanıcının TÜM gruplarına katılıyordu
 * (socket/handlers/dm.ts:400 `joinGroupRooms`). Bir üye gruptan ÇIKARILDIĞINDA
 * yalnızca veritabanı satırı siliniyor, `gdm:<groupId>` ODASINDAN
 * ÇIKARILMIYORDU. Sonuç: çıkarılan kullanıcı mesaj GÖNDEREMESE de
 * (`gdm:send` üyelik kontrol eder) ve REST geçmişini okuyamasa da,
 *     io.to(`gdm:${groupId}`).emit('gdm:message', ...)
 * yayınlarını CANLI olarak almaya devam ediyordu — soket kopana kadar.
 * İstemciye gönderilen `gdm:deleted` yalnızca arayüzü gizler; bu güvenlik
 * değildir.
 *
 * `socketsLeave`/`socketsJoin` (socket.io v4) odayı sunucu tarafında zorlar.
 */
type IoLike = {
  to(r: string): { emit(e: string, d: unknown): void };
  in?(r: string): { socketsLeave?(room: string): void; socketsJoin?(room: string): void };
};

/** Kullanıcının TÜM soketlerini text + voice grup odalarından çıkarır. */
function forceLeaveGroupRoom(io: IoLike | undefined, userId: string, groupId: string): void {
  if (!io?.in) return;
  const userRoom = io.in(`user:${userId}`);
  userRoom.socketsLeave?.(`gdm:${groupId}`);
  userRoom.socketsLeave?.(`gdm:voice:${groupId}`);
}

/** Yeni üyeyi odaya alır; aksi hâlde yeniden bağlanana dek canlı mesaj görmez. */
function forceJoinGroupRoom(io: IoLike | undefined, userId: string, groupId: string): void {
  try { io?.in?.(`user:${userId}`)?.socketsJoin?.(`gdm:${groupId}`); } catch { /* yayın hatası akışı bozmasın */ }
}

const MAX_MEMBERS = 20;

async function getGroupWithCheck(gid: string, userId: string) {
  const group  = await GroupDms.findById(gid);
  if (!group) return { group: null, member: null };
  const member = await GroupDms.findMember(gid, userId);
  return { group, member };
}

function membershipCursor(membership: Record<string, unknown>): number {
  const parse = (value: unknown, missing: number): number => {
    try { return parsePersistedEpochMillis(value) ?? missing; }
    catch { return Number.MAX_SAFE_INTEGER; }
  };
  // joinedAt is mandatory authority history. Missing/corrupt data must not
  // expose messages from before the membership was established.
  return Math.max(
    parse(membership.joinedAt, Number.MAX_SAFE_INTEGER),
    parse(membership.readAt, 0),
  );
}

async function enrichGroup(group: GroupRow, userId?: string, knownMembership?: Record<string, unknown>) {
  const memberRows = await GroupDms.findMembers(group._id) as Array<{ userId: string }>;
  // PERF: Bulk fetch instead of N+1 loop
  const userIds = memberRows.map(m => m.userId);
  const userList = await Users.findByIds(userIds);
  const userMap = new Map(userList.map(u => [u._id, u]));
  const users: object[] = userIds
    .map(id => userMap.get(id))
    .filter((u): u is NonNullable<typeof u> => !!u)
    .map(u => sanitizeUser(u));
  const msgs = await GroupDms.findMessages(group._id, { limit: 1 });
  let unreadCount = 0;
  if (userId) {
    const membership = knownMembership ?? await GroupDms.findMember(group._id, userId);
    if (membership) {
      const after = membershipCursor(membership);
      unreadCount = await GroupDms.countUnread(group._id, userId, after);
    }
  }
  return { ...group, members: users, memberCount: users.length, lastMessage: msgs[0] || null, unreadCount };
}

const router: Router = express.Router();

/**
 * @openapi
 * /group-dm:
 *   get:
 *     tags: [GroupDM]
 *     summary: Grup DM listesi
 *     responses:
 *       200:
 *         description: Aktif grup DM'ler
 *         content:
 *           application/json:
 *             schema: { type: array, items: { type: object } }
 */
router.get('/', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const memberships = await GroupDms.findGroupsByUser(_u.id) as Array<{ groupId: string }>;
  const groups: object[] = [];
  for (const m of memberships) {
    const group = await GroupDms.findById(m.groupId);
    if (group) groups.push(await enrichGroup(group, _u.id, m as unknown as Record<string, unknown>));
  }
  (groups as GroupRow[]).sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  res.json(groups);
});

/**
 * @openapi
 * /group-dm:
 *   post:
 *     tags: [GroupDM]
 *     summary: Grup DM oluştur
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userIds]
 *             properties:
 *               name: { type: string }
 *               userIds: { type: array, items: { type: string }, minItems: 2 }
 *     responses:
 *       201: { description: Grup DM oluşturuldu }
 */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const body = req.body as Record<string, unknown>;
  const name = body.name;
  const memberIdsRaw = body.memberIds;
  const icon = body.icon;
  if (typeof name !== 'string' || !name.trim()) return void res.status(400).json({ error: 'Grup adı gerekli' });
  if (memberIdsRaw !== undefined && !Array.isArray(memberIdsRaw))
    return void res.status(400).json({ error: 'memberIds dizi olmalı' });
  const memberIds = (memberIdsRaw ?? []) as unknown[];
  if (memberIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 128))
    return void res.status(400).json({ error: 'memberIds yalnızca geçerli kullanıcı kimlikleri içermeli' });
  if (icon !== undefined && icon !== null && typeof icon !== 'string')
    return void res.status(400).json({ error: 'icon string olmalı' });

  const uniqueIds = [...new Set([_u.id, ...memberIds.map(id => (id as string).trim())])].slice(0, MAX_MEMBERS);
  if (uniqueIds.length < 2) return void res.status(400).json({ error: 'En az 2 üye gerekli' });

  // PERF: Bulk fetch instead of N+1 validation loop
  const foundUsers = await Users.findByIds(uniqueIds);
  const foundIds = new Set(foundUsers.map(u => u._id));
  const missingId = uniqueIds.find(uid => !foundIds.has(uid));
  if (missingId) return void res.status(404).json({ error: `Kullanıcı bulunamadı: ${missingId}` });

  const now = Date.now();
  const me  = await Users.findById(_u.id);

  // ── ATOMIK OLUSTURMA ───────────────────────────────────────────────────────
  // Onceden grup / uyelikler / sistem mesaji AYRI AYRI yazilir, sonra
  // zenginlestirme yapilirdi. Zenginlestirme patlayinca 500 donuyor ama UC
  // YAZMA DA KALICI kaliyordu -> yetim grup, tekrar denemede yinelenme.
  // (Canli olcumde tam olarak bu yasandi.) Artik tek transaction: ya hepsi,
  // ya hicbiri.
  let group: GroupRow;
  try {
    group = await GroupDms.createAtomic({
      group: {
        _id: uuidv4(), name: name.trim().slice(0, 64), ownerId: _u.id,
        icon: typeof icon === 'string' ? (icon.slice(0, 4) || null) : null, createdAt: now, lastMessageAt: now,
      },
      memberIds: uniqueIds,
      systemMessage: {
        _id: uuidv4(), userId: 'system', displayName: 'Bridge', avatarColor: '#2d9cdb',
        content: `${me?.displayName || 'Biri'} grubu oluşturdu 🎉`, type: 'system',
        createdAt: now,
      },
    }) as unknown as GroupRow;
  } catch (err) {
    // Transaction ROLLBACK edildi: KALICI HICBIR SEY YOK. Tekrar deneme
    // guvenlidir cunku yetim kayit birakilmaz.
    logger.error({ err, event: 'gdm.create.failed' }, '[gdm] Grup olusturulamadi (rollback)');
    return void res.status(500).json({ error: 'Grup oluşturulamadı' });
  }

  // ── COMMIT SONRASI ─────────────────────────────────────────────────────────
  // Buradan sonrasi SUNUM katmanidir. Zenginlestirme YALNIZCA okumadir;
  // patlarsa grup GERCEKTEN olusmustur ve 500 donmek YANLIS olur (kullanici
  // tekrar dener, ikinci grup olusur). Bu yuzden hata YUTULMAZ ama istek
  // BASARILI sayilir ve elimizdeki dogru veriyle minimal yanit doner.
  let payload: unknown;
  try {
    payload = await enrichGroup(group, _u.id);
  } catch (err) {
    logger.error({ err, event: 'gdm.enrich.failed' }, '[gdm] Zenginlestirme basarisiz — minimal yanit');
    payload = { ...group, members: [], memberCount: uniqueIds.length, lastMessage: null };
  }

  const io = req.app.get('io') as { to(room: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) for (const uid of uniqueIds) io.to(`user:${uid}`).emit('gdm:created', payload);
  res.status(201).json(payload);
});

/**
 * @openapi
 * /group-dm/{gid}:
 *   get:
 *     tags: [GroupDM]
 *     summary: Grup DM detayı
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Grup DM }
 */
router.get('/:gid', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Bu grubun üyesi değilsiniz' });
  res.json(await enrichGroup(group, _u.id));
});

/**
 * @openapi
 * /group-dm/{gid}:
 *   patch:
 *     tags: [GroupDM]
 *     summary: Grup DM güncelle
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *     responses:
 *       200: { description: Güncellendi }
 */
router.patch('/:gid', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });
  if (group.ownerId !== _u.id) return void res.status(403).json({ error: 'Sadece grup sahibi düzenleyebilir' });

  const body = req.body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (body.name != null) {
    if (typeof body.name !== 'string' || !body.name.trim())
      return void res.status(400).json({ error: 'name boş olmayan string olmalı' });
    patch['name'] = body.name.trim().slice(0, 64);
  }
  if (body.icon != null) {
    if (typeof body.icon !== 'string') return void res.status(400).json({ error: 'icon string olmalı' });
    patch['icon'] = body.icon.slice(0, 4) || null;
  }
  if (!Object.keys(patch).length) return void res.status(400).json({ error: 'Güncellenecek alan yok' });

  await GroupDms.update(String(req.params.gid ?? ''), patch);
  const updated = await GroupDms.findById(String(req.params.gid ?? ''));

  const io = req.app.get('io') as { to(r: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) {
    const memberRows = await GroupDms.findMembers(String(req.params.gid ?? ''));
    for (const m of memberRows) io.to(`user:${m.userId}`).emit('gdm:updated', updated);
  }
  res.json(updated);
});

/**
 * @openapi
 * /group-dm/{gid}:
 *   delete:
 *     tags: [GroupDM]
 *     summary: Grup DM'den ayrıl / sil
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Grup DM silindi }
 */
router.delete('/:gid', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });
  if (group.ownerId !== _u.id) return void res.status(403).json({ error: 'Sadece sahip silebilir' });

  const memberRows = await GroupDms.findMembers(String(req.params.gid ?? ''));
  await GroupDms.deleteGroup(String(req.params.gid ?? ''));

  const io = req.app.get('io') as { to(r: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) for (const m of memberRows) io.to(`user:${m.userId}`).emit('gdm:deleted', { groupId: String(req.params.gid ?? '') });
  res.json({ deleted: true });
});

/**
 * @openapi
 * /group-dm/{gid}/members:
 *   post:
 *     tags: [GroupDM]
 *     summary: Gruba üye ekle
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: string }
 *     responses:
 *       200: { description: Üye eklendi }
 */
router.post('/:gid/members', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });
  if (group.ownerId !== _u.id) return void res.status(403).json({ error: 'Sadece sahip üye ekleyebilir' });

  const userIdRaw = (req.body as Record<string, unknown>).userId;
  if (typeof userIdRaw !== 'string' || !userIdRaw.trim() || userIdRaw.length > 128)
    return void res.status(400).json({ error: 'userId gerekli' });
  const userId = userIdRaw.trim();

  if (await GroupDms.findMember(String(req.params.gid ?? ''), userId)) return void res.status(409).json({ error: 'Zaten üye' });
  if (await GroupDms.countMembers(String(req.params.gid ?? '')) >= MAX_MEMBERS)
    return void res.status(429).json({ error: `Maksimum ${MAX_MEMBERS} üye` });

  const newUser = await Users.findById(userId);
  if (!newUser) return void res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  await GroupDms.addMember(String(req.params.gid ?? ''), userId);
  const me = await Users.findById(_u.id);
  await GroupDms.insertMessage({
    groupId: String(req.params.gid ?? ''), userId: 'system', displayName: 'Bridge', avatarColor: '#2d9cdb',
    content: `${me?.displayName || 'Biri'} ${newUser.displayName} kullanıcısını gruba ekledi`, type: 'system',
  });

  const io = req.app.get('io') as IoLike | undefined;
  if (io) {
    // Yeni üye odaya ALINIR; yoksa yeniden bağlanana kadar canlı mesajları
    // görmezdi (üyelik veritabanında var ama soket odasında yok).
    forceJoinGroupRoom(io, userId, String(req.params.gid ?? ''));
    io.to(`user:${userId}`).emit('gdm:created', await enrichGroup(group, userId));
    const allMembers = await GroupDms.findMembers(String(req.params.gid ?? ''));
    for (const m of allMembers) {
      if (m.userId !== userId)
        io.to(`user:${m.userId}`).emit('gdm:member:join', { groupId: String(req.params.gid ?? ''), user: sanitizeUser(newUser) });
    }
  }
  res.json({ ok: true });
});

/**
 * @openapi
 * /group-dm/{gid}/members/{uid}:
 *   delete:
 *     tags: [GroupDM]
 *     summary: Gruptan üye çıkar
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Üye çıkarıldı }
 */
router.delete('/:gid/members/:uid', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });

  const targetId = String(req.params.uid ?? '').trim();
  if (!targetId || targetId.length > 128) {
    return void res.status(400).json({ error: 'Geçersiz kullanıcı kimliği' });
  }
  const isSelf   = targetId === _u.id;
  const isOwner  = group.ownerId === _u.id;

  if (!isSelf && !isOwner) return void res.status(403).json({ error: 'Sadece sahip üye çıkarabilir' });
  if (targetId === group.ownerId && !isSelf) return void res.status(403).json({ error: 'Sahibi çıkaramazsınız' });

  const removed = await GroupDms.removeMember(String(req.params.gid ?? ''), targetId);
  if (removed?.deleted !== 1) {
    return void res.status(404).json({ error: 'Üye bulunamadı' });
  }
  const remaining = await GroupDms.countMembers(String(req.params.gid ?? ''));

  if (remaining === 0) {
    await GroupDms.deleteGroup(String(req.params.gid ?? ''));
  } else {
    if (targetId === group.ownerId) await GroupDms.transferOwnership(String(req.params.gid ?? ''));
    const leavingUser = await Users.findById(targetId);
    await GroupDms.insertMessage({
      groupId: String(req.params.gid ?? ''), userId: 'system', displayName: 'Bridge', avatarColor: '#2d9cdb',
      content: isSelf ? `${leavingUser?.displayName || 'Biri'} gruptan ayrıldı` : `${leavingUser?.displayName || 'Biri'} gruptan çıkarıldı`,
      type: 'system',
    });
  }

  const io = req.app.get('io') as IoLike | undefined;
  if (io) {
    // GÜVENLİK: ÖNCE odadan çıkar, SONRA haber ver. Sıra önemlidir — arada
    // yayınlanan bir mesaj çıkarılan üyeye ulaşmamalıdır.
    forceLeaveGroupRoom(io, targetId, String(req.params.gid ?? ''));
    io.to(`user:${targetId}`).emit('gdm:deleted', { groupId: String(req.params.gid ?? '') });
    if (remaining > 0) {
      const allMembers = await GroupDms.findMembers(String(req.params.gid ?? ''));
      for (const m of allMembers)
        io.to(`user:${m.userId}`).emit('gdm:member:leave', { groupId: String(req.params.gid ?? ''), userId: targetId });
    }
  }
  res.json({ ok: true });
});

/**
 * @openapi
 * /group-dm/{gid}/messages:
 *   get:
 *     tags: [GroupDM]
 *     summary: Grup DM mesajları
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: before
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *     responses:
 *       200:
 *         description: Mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 */
router.get('/:gid/messages', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });
  const limit  = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  const before = parseNonNegativeSafeIntQuery(req.query.before, Date.now() + 1);
  if (limit === null || before === null) {
    return void res.status(400).json({ error: 'limit/before must be safe non-negative integers (limit >= 1)' });
  }
  // Faz 10.6B — kompozit cursor. `beforeId` opsiyoneldir: verilmezse eski
  // (yalnız zaman damgalı) davranış korunur. Aynı milisaniyede yazılmış
  // mesajlar sayfa sınırına denk geldiğinde bu ayırıcı olmadan sessizce
  // kayboluyorlardı (bkz. tests/gdm-pagination.test.ts).
  const beforeIdRaw = String(req.query.beforeId ?? '').trim();
  const beforeId    = beforeIdRaw.length > 0 && beforeIdRaw.length <= 64 ? beforeIdRaw : undefined;

  const groupId = String(req.params.gid ?? '');
  const msgs = await GroupDms.findMessages(groupId, { limit, before, beforeId });
  // Membership can be revoked while the history query is in flight. Never
  // serialize rows obtained under a stale membership snapshot.
  if (!await GroupDms.findMember(groupId, _u.id)) {
    return void res.status(403).json({ error: 'Üye değilsiniz' });
  }
  await GroupDms.markRead(groupId, _u.id);
  res.json(msgs.reverse().map(({ clientNonce: _clientNonce, ...message }) => message));
});

/**
 * @openapi
 * /group-dm/{gid}/messages:
 *   post:
 *     tags: [GroupDM]
 *     summary: Grup DM'e mesaj gönder
 *     parameters:
 *       - in: path
 *         name: gid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { type: string }
 *     responses:
 *       201:
 *         description: Mesaj gönderildi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 */
router.post('/:gid/messages', authMiddleware, limits.messages(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const contentRaw = (req.body as Record<string, unknown>).content;
  if (typeof contentRaw !== 'string' || !contentRaw.trim()) return void res.status(400).json({ error: 'content gerekli' });
  if (contentRaw.length > 2000) return void res.status(400).json({ error: 'Mesaj çok uzun' });
  const content = contentRaw;

  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });

  const user = await Users.findById(_u.id);
  // The membership used above is only a snapshot. Re-check after intervening
  // repository work so a concurrent removal cannot authorize a late write.
  if (!await GroupDms.findMember(String(req.params.gid ?? ''), _u.id)) {
    return void res.status(403).json({ error: 'Üye değilsiniz' });
  }
  const now  = Date.now();
  const msg  = await GroupDms.insertMessage({
    groupId: String(req.params.gid ?? ''), userId: _u.id,
    displayName: user?.displayName || 'User', avatarColor: user?.avatarColor || '#2d9cdb',
    content: content.trim(), type: 'normal',
  });
  await GroupDms.update(String(req.params.gid ?? ''), { lastMessageAt: now });

  const io = req.app.get('io') as { to(r: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) {
    const memberRows = await GroupDms.findMembers(String(req.params.gid ?? ''));
    for (const m of memberRows) {
      io.to(`user:${m.userId}`).emit('gdm:message', msg);
      if (m.userId !== _u.id) io.to(`user:${m.userId}`).emit('inbox:changed', { reason: 'gdm' });
    }
  }
  res.status(201).json(msg);
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
