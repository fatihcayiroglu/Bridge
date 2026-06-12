// server/routes/groupDm.ts
import express, { Request, Response, Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authMiddleware} from '../middleware/auth';

import { GroupDms, Users } from '../db/repositories';
import { sanitizeUser } from './auth';
import { limits } from '../middleware/rateLimit';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
interface GroupRow { _id: string; name: string; ownerId: string; icon?: string | null; createdAt: number; lastMessageAt?: number }
interface MsgRow   { _id: string; groupId: string; userId: string; content?: string; type?: string; createdAt?: number }
interface UserRow  { _id: string; username: string; displayName?: string; avatarColor?: string }

const MAX_MEMBERS = 20;

async function getGroupWithCheck(gid: string, userId: string) {
  const group  = await GroupDms.findById(gid);
  if (!group) return { group: null, member: null };
  const member = await GroupDms.findMember(gid, userId);
  return { group, member };
}

async function enrichGroup(group: GroupRow) {
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
  return { ...group, members: users, memberCount: users.length, lastMessage: msgs[0] || null };
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
    if (group) groups.push(await enrichGroup(group));
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
  const { name, memberIds, icon } = req.body as { name?: string; memberIds?: string[]; icon?: string };
  if (!name?.trim()) return void res.status(400).json({ error: 'Grup adı gerekli' });

  const uniqueIds = [...new Set([_u.id, ...(memberIds || [])])].slice(0, MAX_MEMBERS);
  if (uniqueIds.length < 2) return void res.status(400).json({ error: 'En az 2 üye gerekli' });

  // PERF: Bulk fetch instead of N+1 validation loop
  const foundUsers = await Users.findByIds(uniqueIds);
  const foundIds = new Set(foundUsers.map(u => u._id));
  const missingId = uniqueIds.find(uid => !foundIds.has(uid));
  if (missingId) return void res.status(404).json({ error: `Kullanıcı bulunamadı: ${missingId}` });

  const now   = Date.now();
  const group = await GroupDms.create({
    _id: uuidv4(), name: name.trim().slice(0, 64), ownerId: _u.id,
    icon: icon?.slice(0, 4) || null, createdAt: now, lastMessageAt: now,
  });

  // PERF: Bulk insert instead of loop (N+1 fix)
  await GroupDms.addMembersMany(group._id, uniqueIds);

  const me = await Users.findById(_u.id);
  await GroupDms.insertMessage({
    groupId: group._id, userId: 'system', displayName: 'Bridge', avatarColor: '#2d9cdb',
    content: `${me?.displayName || 'Biri'} grubu oluşturdu 🎉`, type: 'system',
  });

  const enriched = await enrichGroup(group);
  const io = req.app.get('io') as { to(room: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) for (const uid of uniqueIds) io.to(`user:${uid}`).emit('gdm:created', enriched);
  res.status(201).json(enriched);
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
  res.json(await enrichGroup(group));
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

  const body  = req.body as { name?: string; icon?: string };
  const patch: Record<string, unknown> = {};
  if (body.name != null) patch['name'] = body.name.trim().slice(0, 64);
  if (body.icon != null) patch['icon'] = body.icon.slice(0, 4) || null;
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

  const { userId } = req.body as { userId?: string };
  if (!userId) return void res.status(400).json({ error: 'userId gerekli' });

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

  const io = req.app.get('io') as { to(r: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) {
    io.to(`user:${userId}`).emit('gdm:created', await enrichGroup(group));
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

  const targetId = String(String(req.params.uid ?? '') ?? "");
  const isSelf   = targetId === _u.id;
  const isOwner  = group.ownerId === _u.id;

  if (!isSelf && !isOwner) return void res.status(403).json({ error: 'Sadece sahip üye çıkarabilir' });
  if (targetId === group.ownerId && !isSelf) return void res.status(403).json({ error: 'Sahibi çıkaramazsınız' });

  await GroupDms.removeMember(String(req.params.gid ?? ''), targetId);
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

  const io = req.app.get('io') as { to(r: string): { emit(e: string, d: unknown): void } } | undefined;
  if (io) {
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
  const limit  = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before = parseInt(String(req.query.before ?? '')) || Date.now() + 1;
  const msgs   = await GroupDms.findMessages(String(req.params.gid ?? ''), { limit, before });
  res.json(msgs.reverse());
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
  const { content } = req.body as { content?: string };
  if (!content?.trim()) return void res.status(400).json({ error: 'content gerekli' });
  if (content.length > 2000) return void res.status(400).json({ error: 'Mesaj çok uzun' });

  const { group, member } = await getGroupWithCheck(String(req.params.gid ?? ''), _u.id);
  if (!group)  return void res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return void res.status(403).json({ error: 'Üye değilsiniz' });

  const user = await Users.findById(_u.id);
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
    for (const m of memberRows) io.to(`user:${m.userId}`).emit('gdm:message', msg);
  }
  res.status(201).json(msg);
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
