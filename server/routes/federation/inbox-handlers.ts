// server/routes/federation/inbox-handlers.ts
// Gelen ActivityPub aktivitelerini işleyen handler'lar
// Her handler izole, test edilebilir.

import { v4 as uuidv4 } from 'uuid';
import { Federation, Notifications, Dms, Users } from '../../db/repositories';
import logger from '../../lib/logger';
import { deliverApActivity } from './delivery';

interface ApActor { _id: string; username: string; [key: string]: unknown; }
interface ApObject extends Record<string, unknown> {
  id?: string;
  type?: string;
  object?: string | ApObject;
  content?: string;
  name?: string;
  summary?: string | null;
  sensitive?: boolean;
  inReplyTo?: string | null;
  published?: string | number;
  attachment?: Array<Record<string, string>>;
  tag?: Array<Record<string, string>>;
  to?: string | string[];
  cc?: string | string[];
}
interface ApActivity { id: string; type: string; actor: string | { id: string }; object?: string | ApObject; }
function isApObject(value: unknown): value is ApObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

const AP_CONTEXT  = 'https://www.w3.org/ns/activitystreams';
const instanceUrl = () => process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;

// ── Yardımcılar ─────────────────────────────────────────────────
function actorId(actor: string | { id: string } | undefined): string {
  return typeof actor === 'string' ? actor : actor?.id || '';
}
function objectId(obj: string | { id?: string } | undefined): string {
  return typeof obj === 'string' ? obj : obj?.id || '';
}

// ── Follow ─────────────────────────────────────────────────────
async function handleApFollow(targetUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const aUrl = actorId(activity.actor);
    const existing = await Federation.findApFollowOne({ actorUrl: aUrl, targetUserId: targetUser._id });
    if (!existing) {
      await Federation.insertApFollow({
        _id:          uuidv4(),
        actorUrl:     aUrl,
        actorInbox:   null, // populate on first delivery
        targetUserId: targetUser._id,
        activityId:   activity.id,
        accepted:     true,
        createdAt:    Date.now(),
      });
    }

    // Accept gönder
    const url    = `${instanceUrl()}/api/federation/users/${targetUser.username}`;
    const accept = {
      '@context': AP_CONTEXT,
      id:         `${url}/activities/${uuidv4()}`,
      type:       'Accept',
      actor:      url,
      object:     activity,
    };
    await deliverApActivity(aUrl, accept, targetUser);

    // Yerel bildirim
    await Notifications.insertInbox({
      _id:      uuidv4(),
      userId:   targetUser._id,
      type:     'ap_follow',
      actorUrl: aUrl,
      read:     false,
      createdAt: Date.now(),
    });

    logger.info({ targetUser: targetUser.username, actor: aUrl, event: 'federation.follow.received' });
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.handle_failed' });
  }
}

// ── Unfollow (Undo Follow) ─────────────────────────────────────
async function handleApUnfollow(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  try {
    const aUrl = actorId(activity.actor);
    // activity.object may be Follow, Like, or Announce
    const inner = activity.object;
    if (!isApObject(inner)) return;

    if (inner.type === 'Follow') {
      await Federation.removeApFollow({ actorUrl: aUrl, targetUserId: targetUser?._id }, {});
      logger.info({ actor: aUrl, event: 'federation.follow.undo' });
    } else if (inner.type === 'Like') {
      const oUrl = objectId(inner.object);
      await Federation.removeApLike({ actorUrl: aUrl, objectUrl: oUrl }, {});
    } else if (inner.type === 'Announce') {
      const oUrl = objectId(inner.object);
      await Federation.removeApAnnounce({ actorUrl: aUrl, objectUrl: oUrl }, {});
    }
  } catch (err) {
    logger.warn({ err, event: 'federation.unfollow.handle_failed' });
  }
}

// ── Accept (uzak sunucu Follow'u kabul etti) ───────────────────
async function handleApAccept(localUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const remoteActor = actorId(activity.actor);
    await Federation.updateApOutgoingFollow(
      { fromUserId: localUser._id, targetActorUrl: remoteActor },
      { $set: { accepted: true, acceptedAt: Date.now() } }
    );
    logger.info({ localUser: localUser.username, remoteActor, event: 'federation.follow.accepted' });
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.accept_handle_failed' });
  }
}

// ── Reject (uzak sunucu Follow'u reddetti) ────────────────────
async function handleApReject(localUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const remoteActor = actorId(activity.actor);
    await Federation.removeApOutgoingFollow(
      { fromUserId: localUser._id, targetActorUrl: remoteActor }, {}
    );
    logger.info({ localUser: localUser.username, remoteActor, event: 'federation.follow.rejected' });
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.reject_handle_failed' });
  }
}

// ── AP DM tespiti: to[] içinde followers URL yoksa ve cc[] boşsa DM'dir
// Örnek: { to: ["https://remote/users/alice"], cc: [] } → DM
function _isApDm(obj: Record<string, unknown>): boolean {
  const toArr: string[] = Array.isArray(obj.to)
    ? obj.to
    : typeof obj.to === 'string' ? [obj.to] : [];
  const ccArr: string[] = Array.isArray(obj.cc)
    ? obj.cc
    : typeof obj.cc === 'string' ? [obj.cc] : [];

  const PUBLIC_STREAM = 'https://www.w3.org/ns/activitystreams#Public';
  const isPublic = (u: string) => u === PUBLIC_STREAM || u === 'as:Public' || u === 'Public';

  // "to" içinde herkese açık stream yoksa ve followers koleksiyonu yoksa DM
  const hasPublic    = toArr.some(isPublic) || ccArr.some(isPublic);
  const hasFollowers = toArr.some(u => u.endsWith('/followers')) || ccArr.some(u => u.endsWith('/followers'));

  return !hasPublic && !hasFollowers && toArr.length > 0;
}

// ── Create (Note, Article, Question…) ─────────────────────────
async function handleApCreate(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  try {
    const obj = activity.object;
    if (!isApObject(obj) || typeof obj.type !== 'string' || !['Note', 'Article', 'Question'].includes(obj.type)) return;

    const aUrl = actorId(activity.actor);

    // ── ActivityPub DM tespiti ─────────────────────────────────
    if (_isApDm(obj) && targetUser) {
      // Gönderici AP actor URL'sine karşılık gelen yerel kullanıcıyı bul
      const senderLocal = await Users.findByApUrl(aUrl).catch(() => null);

      if (senderLocal) {
        // Sprint 75: Güvenlik — senderLocal'ın AP URL'i activity'deki actor ile eşleşmeli.
        // Bu kontrol HTTP Signature'ın zaten inbox seviyesinde doğrulandığını,
        // ancak DB kaydındaki apUrl'in activity actor'ıyla tutarlı olmasını garantiler.
        // Uyumsuzluk: saldırgan farklı bir kullanıcı adıyla kayıtlı ama farklı AP URL
        // göndermiş olabilir (edge case); bu durumu blokla.
        const senderApUrl = (senderLocal as unknown as Record<string, unknown>).apUrl as string | undefined;
        if (senderApUrl && senderApUrl !== aUrl) {
          logger.warn({
            actorUrl: aUrl,
            senderApUrl,
            event: 'federation.dm.actor_mismatch',
          }, 'AP DM actor URL mismatch — rejecting to prevent impersonation.');
          return;
        }

        // İki yerel kullanıcı arasında DM conversation'ı bul ya da oluştur
        const { dmId } = await Dms.findOrCreateConversation(senderLocal._id, targetUser._id);
        await Dms.insertMessage({
          _id:       uuidv4(),
          dmId,
          senderId:  senderLocal._id,
          content:   obj.content || obj.name || '',
          apId:      obj.id,
          createdAt: obj.published ? new Date(obj.published).getTime() : Date.now(),
        });
        await Notifications.insertInbox({
          _id:       uuidv4(),
          userId:    targetUser._id,
          type:      'dm',
          actorUrl:  aUrl,
          dmId,
          read:      false,
          createdAt: Date.now(),
        });
        logger.info({ noteId: obj.id, dmId, event: 'federation.dm.received' });
        return; // federated timeline'a ekleme
      }

      // Yerel kullanıcı yoksa (remote→remote DM relay) — federation mesajı olarak kaydet
      logger.warn({ aUrl, event: 'federation.dm.sender_not_local' });
    }
    // ── Genel federated note ───────────────────────────────────

    const fedMsg = {
      _id:          uuidv4(),
      apId:         obj.id,
      actorUrl:     aUrl,
      targetUserId: targetUser?._id || null,
      content:      obj.content || obj.name || '',
      summary:      obj.summary || null,
      sensitive:    obj.sensitive || false,
      inReplyTo:    obj.inReplyTo || null,
      attachments:  (obj.attachment || []).map((a: Record<string,string>) => ({ type: a.mediaType, url: a.url })),
      tags:         (obj.tag || []),
      published:    obj.published ? new Date(obj.published).getTime() : Date.now(),
      createdAt:    Date.now(),
    };
    await Federation.insertApMessage(fedMsg);

    // Mention bildirimi
    if (targetUser && (obj.tag || []).some((t: Record<string,string>) => t.type === 'Mention')) {
      await Notifications.insertInbox({
        _id:      uuidv4(),
        userId:   targetUser._id,
        type:     'ap_mention',
        actorUrl: aUrl,
        noteId:   obj.id,
        read:     false,
        createdAt: Date.now(),
      });
    }

    logger.info({ noteId: obj.id, event: 'federation.note.created' });
  } catch (err) {
    logger.warn({ err, event: 'federation.note.create_handle_failed' });
  }
}

// ── Update ─────────────────────────────────────────────────────
async function handleApUpdate(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  try {
    const obj  = activity.object;
    if (!isApObject(obj) || typeof obj.id !== 'string') return;
    const aUrl = actorId(activity.actor);
    await Federation.updateApMessage(
      { apId: obj.id, actorUrl: aUrl },
      { $set: { content: obj.content || '', updatedAt: Date.now() } }
    );
    logger.info({ noteId: obj.id, event: 'federation.note.updated' });
  } catch (err) {
    logger.warn({ err, event: 'federation.note.update_handle_failed' });
  }
}

// ── Delete ─────────────────────────────────────────────────────
async function handleApDelete(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  try {
    const oId  = objectId(activity.object);
    if (!oId) return;
    const aUrl = actorId(activity.actor);
    await Federation.removeApMessage({ apId: oId, actorUrl: aUrl }, {});
    logger.info({ objectId: oId, event: 'federation.note.deleted' });
  } catch (err) {
    logger.warn({ err, event: 'federation.note.delete_handle_failed' });
  }
}

// ── Like ───────────────────────────────────────────────────────
async function handleApLike(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  try {
    const aUrl = actorId(activity.actor);
    const oUrl = objectId(activity.object);
    if (!oUrl) return;

    await Federation.insertApLike({
      _id:      uuidv4(),
      actorUrl: aUrl,
      objectUrl: oUrl,
      targetUserId: targetUser?._id || null,
      createdAt: Date.now(),
    });

    // Bildirim — bu instance'daki bir nota beğenildiyse
    if (targetUser) {
      await Notifications.insertInbox({
        _id:      uuidv4(),
        userId:   targetUser._id,
        type:     'ap_like',
        actorUrl: aUrl,
        noteUrl:  oUrl,
        read:     false,
        createdAt: Date.now(),
      });
    }
    logger.info({ actor: aUrl, object: oUrl, event: 'federation.like.received' });
  } catch (err) {
    logger.warn({ err, event: 'federation.like.handle_failed' });
  }
}

// ── Announce (Boost/Reblog) ────────────────────────────────────
async function handleApAnnounce(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  try {
    const aUrl = actorId(activity.actor);
    const oUrl = objectId(activity.object);
    if (!oUrl) return;

    await Federation.insertApAnnounce({
      _id:          uuidv4(),
      actorUrl:     aUrl,
      objectUrl:    oUrl,
      targetUserId: targetUser?._id || null,
      createdAt:    Date.now(),
    });

    if (targetUser) {
      await Notifications.insertInbox({
        _id:      uuidv4(),
        userId:   targetUser._id,
        type:     'ap_announce',
        actorUrl: aUrl,
        noteUrl:  oUrl,
        read:     false,
        createdAt: Date.now(),
      });
    }
    logger.info({ actor: aUrl, object: oUrl, event: 'federation.announce.received' });
  } catch (err) {
    logger.warn({ err, event: 'federation.announce.handle_failed' });
  }
}

export { handleApFollow,
  handleApUnfollow,
  handleApAccept,
  handleApReject,
  handleApCreate,
  handleApUpdate,
  handleApDelete,
  handleApLike,
  handleApAnnounce, };

const inboxHandlers = {
  handleApFollow,
  handleApUnfollow,
  handleApAccept,
  handleApReject,
  handleApCreate,
  handleApUpdate,
  handleApDelete,
  handleApLike,
  handleApAnnounce,
};

export default inboxHandlers;
module.exports = inboxHandlers;
module.exports.default = inboxHandlers;
