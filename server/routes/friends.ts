// server/routes/friends.ts — Session 18: @openapi annotation eklendi
// Mevcut mantık değişmedi; sadece JSDoc blokları eklendi.

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
import { Social, Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { sanitizeUser } from '../lib/userUtils';
import { limits } from '../middleware/rateLimit';

type BlockEdge = { blockerId?: unknown; blockedId?: unknown };

/** Blocking is canonical safety state; repository failures must never mean "not blocked". */
async function findEitherDirectionBlock(userA: string, userB: string) {
  return await Social.findBlock(userA, userB) ?? await Social.findBlock(userB, userA);
}

async function blockedPeerIds(userId: string): Promise<Set<string>> {
  const rows = await Social.findBlocksInvolvingUser(userId) as BlockEdge[];
  const blocked = new Set<string>();
  for (const row of rows) {
    const blockerId = String(row.blockerId ?? '');
    const blockedId = String(row.blockedId ?? '');
    if (blockerId === userId && blockedId) blocked.add(blockedId);
    else if (blockedId === userId && blockerId) blocked.add(blockerId);
  }
  return blocked;
}


// ════════════════════════════════════════════════════════════════════════════
// ENGELLEME — API'SI HIC YOKTU
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUK: `SocialRepository` engelleme icin dort yontem
// tasiyordu (`findBlock`, `findBlocksByUser`, `insertBlock`, `removeBlock`)
// ve `findBlock` GERCEKTEN uygulaniyordu:
//   · socket/handlers/dm.ts → `dm:send` iki yonlu engel denetimi
//   · socket/handlers/dm.ts → `dm:call:start` engel denetimi
//
// Ancak `insertBlock`/`removeBlock` HICBIR rotadan cagrilmiyordu. Yani
// engelleme UYGULANIYOR ama OLUSTURULAMIYORDU: `blocks` tablosu yapisi
// geregi hep bos kalir ve guvenlik ozelligi kullanilamaz durumdaydi.
//
// ── KARARLAR ──────────────────────────────────────────────────────────────
// · Kendini engelleme YASAK.
// · Engellemek ARKADASLIGI da kaldirir. Aksi halde "arkadas ama engelli"
//   gibi tutarsiz bir durum olusur ve arkadas listesi yaniltici olur.
// · Islem ETKISIZ-TEKRARLANABILIR: ayni kisiyi iki kez engellemek hata
//   degildir (istemci yeniden denemesi kullaniciyi hataya dusurmemeli).
// · Liste YALNIZCA cagiranin kendi engellerini dondurur.
// · Engelin varligi karsi tarafa SIZDIRILMAZ — engellenen kisi icin
//   ayri bir bildirim yoktur.

/**
 * @openapi
 * /friends/blocks:
 *   get:
 *     tags: [Friends]
 *     summary: Engellenen kullanicilari listele
 *     responses:
 *       200: { description: Engel listesi }
 */
router.get('/blocks', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const rows = await Social.findBlocksByUser(_u.id) as { blockedId: string; createdAt?: number }[];
  const ids  = rows.map(r => r.blockedId).filter(Boolean);
  const users = ids.length ? await Users.findByIds(ids) : [];
  const byId = new Map((users as { _id: string }[]).map(u => [u._id, u]));
  res.json({
    blocks: rows.map(r => ({
      userId: r.blockedId,
      createdAt: r.createdAt ?? null,
      // `sanitizeUser` gizli alanlari (e-posta, parola, jeton) disarida birakir.
      user: byId.get(r.blockedId) ? sanitizeUser(byId.get(r.blockedId)!) : null,
    })),
  });
});

/**
 * @openapi
 * /friends/blocks:
 *   post:
 *     tags: [Friends]
 *     summary: Kullaniciyi engelle
 *     responses:
 *       200: { description: Engellendi }
 *       400: { description: Gecersiz istek }
 *       404: { description: Kullanici bulunamadi }
 */
router.post('/blocks', authMiddleware, limits.friends(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { userId } = (req.body ?? {}) as Record<string, unknown>;
  const targetId = typeof userId === 'string' ? userId.trim() : '';
  if (!targetId) return res.status(400).json({ error: 'userId gerekli' });
  if (targetId === _u.id) return res.status(400).json({ error: 'Kendinizi engelleyemezsiniz' });

  const target = await Users.findById(targetId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  // ETKISIZ-TEKRARLANABILIR: zaten engelliyse basarili doner.
  const existing = await Social.findBlock(_u.id, targetId);
  if (!existing) await Social.insertBlock(_u.id, targetId);

  // Engelleme arkadasligi da kaldirir — "arkadas ama engelli" tutarsizdir.
  // `removeFriendship` ARKADASLIK KIMLIGI alir, iki kullanici degil; once
  // iliski bulunur. Iliski yoksa yapilacak bir sey de yoktur.
  try {
    const friendship = await Social.findFriendship(_u.id, targetId) as { _id?: string } | null;
    if (friendship?._id) await Social.removeFriendship(friendship._id);
  } catch { /* arkadaslik yoksa ya da silinemezse engel yine gecerlidir */ }

  res.json({ ok: true, blocked: true, userId: targetId });
});

/**
 * @openapi
 * /friends/blocks/{userId}:
 *   delete:
 *     tags: [Friends]
 *     summary: Engeli kaldir
 *     responses:
 *       200: { description: Engel kaldirildi }
 */
router.delete('/blocks/:userId', authMiddleware, limits.friends(), async (req, res) => {
  const _u = castAuthed(req).user;
  const targetId = String(req.params.userId ?? '').trim();
  if (!targetId) return res.status(400).json({ error: 'userId gerekli' });

  // Yalnizca KENDI engelini kaldirabilir: anahtar daima `_u.id`dir, istemciden
  // gelen bir "blockerId" KABUL EDILMEZ.
  await Social.removeBlock(_u.id, targetId);
  res.json({ ok: true, blocked: false, userId: targetId });
});

/**
 * @openapi
 * /friends:
 *   get:
 *     summary: Kabul edilmiş arkadaşları listele
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Arkadaş listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PublicUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  try {
    const [rows, blocked] = await Promise.all([
      Social.findFriendships(_u.id),
      blockedPeerIds(_u.id),
    ]);
    const accepted  = rows.filter(r => r.status === 'accepted');
    const friendIds = accepted
      .map(r => r.userId === _u.id ? r.friendId : r.userId)
      .filter(id => !blocked.has(String(id)));
    const users = await Users.findByIds(friendIds);
    return res.json(users.map(sanitizeUser));
  } catch {
    // A stale friendship cleanup must not expose a blocked peer when the
    // canonical block store cannot be evaluated.
    return res.status(503).json({ error: 'Friend safety state unavailable' });
  }
});

/**
 * @openapi
 * /friends/pending:
 *   get:
 *     summary: Bekleyen arkadaşlık isteklerini listele
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bekleyen istek listesi (gönderen bilgisiyle)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   sender:
 *                     $ref: '#/components/schemas/PublicUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/pending', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  try {
    const [rows, blocked] = await Promise.all([
      Social.findFriendships(_u.id),
      blockedPeerIds(_u.id),
    ]);
    const pending = rows.filter(r =>
      r.friendId === _u.id && r.status === 'pending' && !blocked.has(String(r.userId))
    );
    const senderIds = pending.map(r => r.userId);
    const users     = await Users.findByIds(senderIds);
    const userMap: Record<string, ReturnType<typeof sanitizeUser>> = {};
    users.forEach(u => { userMap[u._id] = sanitizeUser(u); });
    return res.json(pending.map(r => ({ ...r, sender: userMap[r.userId] })));
  } catch {
    return res.status(503).json({ error: 'Friend safety state unavailable' });
  }
});

/**
 * @openapi
 * /friends/request:
 *   post:
 *     summary: Arkadaşlık isteği gönder
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username]
 *             properties:
 *               username:
 *                 type: string
 *                 example: alice
 *     responses:
 *       200:
 *         description: İstek gönderildi
 *       400:
 *         description: Geçersiz kullanıcı adı veya zaten arkadaş
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 */
router.post('/request', authMiddleware, limits.friends(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { username } = req.body as Record<string, string>;
  if (!username) return res.status(400).json({ error: 'username gerekli' });
  const target = await Users.findByUsername(username);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Kendinize istek gönderemezsiniz' });

  // ── ENGEL DENETIMI (IKI YONLU) ──────────────────────────────────────────
  // KAPATILAN GERCEK BOSLUK: engel yalnizca DM ve aramada uygulaniyordu.
  // Arkadaslik istegi hic denetlenmiyordu, dolayisiyla engellenen bir kisi
  // hedefe istek gondermeye devam edebiliyordu — engellemenin amacini
  // dogrudan bosa cikaran bir taciz yolu.
  //
  // Iki yon de denetlenir: A, B'yi engellediyse istek gondermek de anlamsizdir.
  //
  // YANIT engelin VARLIGINI ELE VERMEZ: "zaten arkadas / istek beklemede" ile
  // ayni 409 dondurulur. Aksi halde bu uc, birinin sizi engelleyip
  // engellemedigini ogrenmek icin bir kesif araci olurdu.
  let blocked;
  try {
    blocked = await findEitherDirectionBlock(_u.id, target._id);
  } catch {
    return res.status(503).json({ error: 'Friend safety state unavailable' });
  }

  const existing = await Social.findFriendship(_u.id, target._id);
  if (blocked || (existing && (existing.status === 'pending' || existing.status === 'accepted'))) {
    return res.status(409).json({ error: 'Already friends or request pending' });
  }

  await Social.createFriendship(_u.id, target._id);
  res.json({ ok: true, status: 'pending', friendId: target._id });
});

/**
 * @openapi
 * /friends/{requestId}/accept:
 *   post:
 *     summary: Arkadaşlık isteğini kabul et
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: İstek kabul edildi
 *       403:
 *         description: Bu isteği kabul etme yetkiniz yok
 *       404:
 *         description: İstek bulunamadı
 */
router.post('/:requestId/accept', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const requestId = String(req.params.requestId ?? '');
  const friendship = await Social.findFriendshipById(requestId);

  if (!friendship || friendship.status !== 'pending' || friendship.friendId !== _u.id) {
    return res.status(404).json({ error: 'Friend request not found' });
  }

  try {
    if (await findEitherDirectionBlock(String(friendship.userId), String(friendship.friendId))) {
      // Do not revive a relationship after either party has blocked the other,
      // even if best-effort friendship cleanup previously failed.
      return res.status(409).json({ error: 'Friend request unavailable' });
    }
  } catch {
    return res.status(503).json({ error: 'Friend safety state unavailable' });
  }

  await Social.acceptFriendship(requestId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /friends/{requestId}/decline:
 *   post:
 *     summary: Arkadaşlık isteğini reddet
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: İstek reddedildi
 *       403:
 *         description: Bu isteği reddetme yetkiniz yok
 */
router.post('/:requestId/decline', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const requestId = String(req.params.requestId ?? '');
  const friendship = await Social.findFriendshipById(requestId);

  if (!friendship || friendship.status !== 'pending' || friendship.friendId !== _u.id) {
    return res.status(404).json({ error: 'Friend request not found' });
  }

  await Social.declineFriendship(requestId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /friends/{friendId}:
 *   delete:
 *     summary: Arkadaşı sil
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: friendId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Arkadaş silindi
 *       404:
 *         description: Arkadaşlık bulunamadı
 */
router.delete('/:friendId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const peerOrFriendshipId = String(req.params.friendId ?? '').trim();
  if (!peerOrFriendshipId) return res.status(400).json({ error: 'friendId gerekli' });

  // The public friends list returns users, not friendship-row ids, and the
  // shipping client therefore sends the peer user id here. Prefer that
  // canonical contract. Retain a scoped legacy friendship-id fallback for
  // older clients/bookmarks without ever allowing deletion of another
  // user's relationship.
  let friendship = await Social.findFriendship(_u.id, peerOrFriendshipId);
  if (!friendship) friendship = await Social.findFriendshipById(peerOrFriendshipId);

  if (!friendship) {
    return res.status(404).json({ error: 'Friendship not found' });
  }

  if (friendship.userId !== _u.id && friendship.friendId !== _u.id) {
    return res.status(403).json({ error: 'Not allowed' });
  }

  await Social.removeFriendship(String(friendship._id));
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
