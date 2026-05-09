// @ts-nocheck
// server/routes/groupDm.js
'use strict';

const express      = require('express');
const { v4: uuidv4 } = require('uuid');
const router       = express.Router();
const { GroupDms, Users } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { sanitizeUser }   = require('./auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits }   = require('../middleware/rateLimit');

const MAX_MEMBERS = 20;

async function getGroupWithCheck(gid, userId) {
  const group  = await GroupDms.findById(gid);
  if (!group) return { group: null, member: null };
  const member = await GroupDms.findMember(gid, userId);
  return { group, member };
}

async function enrichGroup(group) {
  const memberRows = await GroupDms.findMembers(group._id);
  const users = [];
  for (const m of memberRows) {
    const u = await Users.findById(m.userId);
    if (u) users.push(sanitizeUser(u));
  }
  const msgs = await GroupDms.findMessages(group._id, { limit: 1 });
  return { ...group, members: users, memberCount: users.length, lastMessage: msgs[0] || null };
}

// GET /api/gdm
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await GroupDms.findGroupsByUser(_u.id);
  const groups = [];
  for (const m of memberships) {
    const group = await GroupDms.findById(m.groupId);
    if (group) groups.push(await enrichGroup(group));
  }
  groups.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  res.json(groups);
}));

// POST /api/gdm
router.post('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { name, memberIds } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Grup adı gerekli' });

  const uniqueIds = [...new Set([_u.id, ...(memberIds || [])])].slice(0, MAX_MEMBERS);
  if (uniqueIds.length < 2) return res.status(400).json({ error: 'En az 2 üye gerekli' });

  for (const uid of uniqueIds) {
    const u = await Users.findById(uid);
    if (!u) return res.status(404).json({ error: `Kullanıcı bulunamadı: ${uid}` });
  }

  const now   = Date.now();
  const group = await GroupDms.create({
    name:          name.trim().slice(0, 64),
    ownerId:       _u.id,
    icon:          req.body.icon?.slice(0, 4) || null,
    createdAt:     now,
    lastMessageAt: now,
  });

  for (const uid of uniqueIds) await GroupDms.addMember(group._id, uid);

  const me = await Users.findById(_u.id);
  await GroupDms.insertMessage({
    groupId: group._id, userId: 'system', displayName: 'Bridge', avatarColor: '#5865f2',
    content: `${me?.displayName || 'Biri'} grubu oluşturdu 🎉`, type: 'system',
  });

  const io = req.app.get('io');
  if (io) {
    for (const uid of uniqueIds)
      io.to(`user:${uid}`).emit('gdm:created', await enrichGroup(group));
  }
  res.status(201).json(await enrichGroup(group));
}));

// GET /api/gdm/:gid
router.get('/:gid', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Bu grubun üyesi değilsiniz' });
  res.json(await enrichGroup(group));
}));

// PATCH /api/gdm/:gid
router.patch('/:gid', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });
  if (group.ownerId !== _u.id) return res.status(403).json({ error: 'Sadece grup sahibi düzenleyebilir' });

  const patch = {};
  if (req.body.name != null) patch.name = req.body.name.trim().slice(0, 64);
  if (req.body.icon != null) patch.icon = req.body.icon.slice(0, 4) || null;
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Güncellenecek alan yok' });

  await GroupDms.update(req.params.gid, patch);
  const updated = await GroupDms.findById(req.params.gid);

  const io = req.app.get('io');
  if (io) {
    const memberRows = await GroupDms.findMembers(req.params.gid);
    for (const m of memberRows) io.to(`user:${m.userId}`).emit('gdm:updated', updated);
  }
  res.json(updated);
}));

// DELETE /api/gdm/:gid
router.delete('/:gid', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });
  if (group.ownerId !== _u.id) return res.status(403).json({ error: 'Sadece sahip silebilir' });

  const memberRows = await GroupDms.findMembers(req.params.gid);
  await GroupDms.deleteGroup(req.params.gid);

  const io = req.app.get('io');
  if (io) {
    for (const m of memberRows) io.to(`user:${m.userId}`).emit('gdm:deleted', { groupId: req.params.gid });
  }
  res.json({ deleted: true });
}));

// POST /api/gdm/:gid/members
router.post('/:gid/members', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });
  if (group.ownerId !== _u.id) return res.status(403).json({ error: 'Sadece sahip üye ekleyebilir' });

  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId gerekli' });

  const existing = await GroupDms.findMember(req.params.gid, userId);
  if (existing) return res.status(409).json({ error: 'Zaten üye' });

  const count = await GroupDms.countMembers(req.params.gid);
  if (count >= MAX_MEMBERS) return res.status(429).json({ error: `Maksimum ${MAX_MEMBERS} üye` });

  const newUser = await Users.findById(userId);
  if (!newUser) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  await GroupDms.addMember(req.params.gid, userId);

  const me = await Users.findById(_u.id);
  await GroupDms.insertMessage({
    groupId: req.params.gid, userId: 'system', displayName: 'Bridge', avatarColor: '#5865f2',
    content: `${me?.displayName || 'Biri'} ${newUser.displayName} kullanıcısını gruba ekledi`,
    type: 'system',
  });

  const io = req.app.get('io');
  if (io) {
    io.to(`user:${userId}`).emit('gdm:created', await enrichGroup(group));
    const allMembers = await GroupDms.findMembers(req.params.gid);
    for (const m of allMembers) {
      if (m.userId !== userId)
        io.to(`user:${m.userId}`).emit('gdm:member:join', { groupId: req.params.gid, user: sanitizeUser(newUser) });
    }
  }
  res.json({ ok: true });
}));

// DELETE /api/gdm/:gid/members/:uid
router.delete('/:gid/members/:uid', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });

  const targetId = req.params.uid;
  const isSelf   = targetId === _u.id;
  const isOwner  = group.ownerId === _u.id;

  if (!isSelf && !isOwner) return res.status(403).json({ error: 'Sadece sahip üye çıkarabilir' });
  if (targetId === group.ownerId && !isSelf) return res.status(403).json({ error: 'Sahibi çıkaramazsınız' });

  await GroupDms.removeMember(req.params.gid, targetId);
  const remaining = await GroupDms.countMembers(req.params.gid);

  if (remaining === 0) {
    await GroupDms.deleteGroup(req.params.gid);
  } else {
    if (targetId === group.ownerId) await GroupDms.transferOwnership(req.params.gid);
    const leavingUser = await Users.findById(targetId);
    await GroupDms.insertMessage({
      groupId: req.params.gid, userId: 'system', displayName: 'Bridge', avatarColor: '#5865f2',
      content: isSelf ? `${leavingUser?.displayName || 'Biri'} gruptan ayrıldı` : `${leavingUser?.displayName || 'Biri'} gruptan çıkarıldı`,
      type: 'system',
    });
  }

  const io = req.app.get('io');
  if (io) {
    io.to(`user:${targetId}`).emit('gdm:deleted', { groupId: req.params.gid });
    if (remaining > 0) {
      const allMembers = await GroupDms.findMembers(req.params.gid);
      for (const m of allMembers)
        io.to(`user:${m.userId}`).emit('gdm:member:leave', { groupId: req.params.gid, userId: targetId });
    }
  }
  res.json({ ok: true });
}));

// GET /api/gdm/:gid/messages
router.get('/:gid/messages', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });
  const limit  = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before = parseInt(String(req.query.before ?? '')) || Date.now() + 1;
  const msgs   = await GroupDms.findMessages(req.params.gid, { limit, before });
  res.json(msgs.reverse());
}));

// POST /api/gdm/:gid/messages (REST fallback)
router.post('/:gid/messages', authMiddleware, limits.messages(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content gerekli' });
  if (content.length > 2000) return res.status(400).json({ error: 'Mesaj çok uzun' });

  const { group, member } = await getGroupWithCheck(req.params.gid, _u.id);
  if (!group)  return res.status(404).json({ error: 'Grup bulunamadı' });
  if (!member) return res.status(403).json({ error: 'Üye değilsiniz' });

  const user = await Users.findById(_u.id);
  const now  = Date.now();

  const msg = await GroupDms.insertMessage({
    groupId:     req.params.gid,
    userId:      _u.id,
    displayName: user?.displayName || 'User',
    avatarColor: user?.avatarColor || '#5865f2',
    content:     content.trim(),
    type:        'normal',
  });
  await GroupDms.update(req.params.gid, { lastMessageAt: now });

  const io = req.app.get('io');
  if (io) {
    const memberRows = await GroupDms.findMembers(req.params.gid);
    for (const m of memberRows) io.to(`user:${m.userId}`).emit('gdm:message', msg);
  }
  res.status(201).json(msg);
}));

module.exports = router;
export {};
