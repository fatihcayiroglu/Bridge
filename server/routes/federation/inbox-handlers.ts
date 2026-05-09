'use strict';
// server/routes/federation/inbox-handlers.js
// Gelen ActivityPub aktivitelerini işleyen handler'lar
// Her handler izole, test edilebilir.

const { v4: uuidv4 } = require('uuid');
const { Federation, Notifications } = require('../../db/repositories');
const logger = require('../../lib/logger');
const { deliverApActivity } = require('./delivery');

const AP_CONTEXT  = 'https://www.w3.org/ns/activitystreams';
const instanceUrl = () => process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;

// ── Yardımcılar ─────────────────────────────────────────────────
function actorId(actor) {
  return typeof actor === 'string' ? actor : actor?.id || '';
}
function objectId(obj) {
  return typeof obj === 'string' ? obj : obj?.id || '';
}

// ── Follow ─────────────────────────────────────────────────────
async function handleApFollow(targetUser, activity) {
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
async function handleApUnfollow(targetUser, activity) {
  try {
    const aUrl = actorId(activity.actor);
    // activity.object may be Follow, Like, or Announce
    const inner = activity.object;
    if (!inner) return;

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
async function handleApAccept(localUser, activity) {
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
async function handleApReject(localUser, activity) {
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

// ── Create (Note, Article, Question…) ─────────────────────────
async function handleApCreate(targetUser, activity) {
  try {
    const obj = activity.object;
    if (!obj || !['Note', 'Article', 'Question'].includes(obj.type)) return;

    const aUrl = actorId(activity.actor);
    const fedMsg = {
      _id:          uuidv4(),
      apId:         obj.id,
      actorUrl:     aUrl,
      targetUserId: targetUser?._id || null,
      content:      obj.content || obj.name || '',
      summary:      obj.summary || null,
      sensitive:    obj.sensitive || false,
      inReplyTo:    obj.inReplyTo || null,
      attachments:  (obj.attachment || []).map(a => ({ type: a.mediaType, url: a.url })),
      tags:         (obj.tag || []),
      published:    obj.published ? new Date(obj.published).getTime() : Date.now(),
      createdAt:    Date.now(),
    };
    await Federation.insertApMessage(fedMsg);

    // Mention bildirimi
    if (targetUser && (obj.tag || []).some(t => t.type === 'Mention')) {
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
async function handleApUpdate(targetUser, activity) {
  try {
    const obj  = activity.object;
    if (!obj?.id) return;
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
async function handleApDelete(targetUser, activity) {
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
async function handleApLike(targetUser, activity) {
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
async function handleApAnnounce(targetUser, activity) {
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

module.exports = {
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
export {};
