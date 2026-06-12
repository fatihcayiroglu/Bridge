// server/routes/federation/helpers.ts
// ActivityPub etkinlik işleyicileri + HTTP Signature + deliverToFollowers
// Bu modül aktif route içermez; diğer federation modülleri tarafından import edilir.

import { v4 as uuidv4 } from 'uuid';
import { createSign, createHash } from 'crypto';
import { Users } from '../../db/repositories';
import { Federation } from '../../db/repositories';
import { fetchT } from '../../lib/fetch';

// ── ActivityPub Payload Tipleri ─────────────────────────────────
interface ApActor { _id: string; username: string; apPublicKey?: string | null; apPrivateKey?: string | null; }
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
import logger from '../../lib/logger';

const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

// ── handleApFollow ─────────────────────────────────────────────
async function handleApFollow(targetUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    await Federation.insertApFollow({
      _id:          uuidv4(),
      actorUrl:     activity.actor,
      targetUserId: targetUser._id,
      activityId:   activity.id,
      createdAt:    Date.now(),
    });

    const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const accept = {
      '@context': AP_CONTEXT,
      id:     `${instanceUrl}/api/federation/activities/${Date.now()}`,
      type:   'Accept',
      actor:  `${instanceUrl}/api/federation/users/${targetUser.username}`,
      object: activity,
    };
    const actorInbox = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    if (actorInbox) await deliverApActivity(actorInbox, accept, targetUser);
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.handle_failed' }, 'Failed to process Follow activity.');
  }
}

// ── handleApUnfollow ───────────────────────────────────────────
async function handleApUnfollow(targetUser: ApActor, activity: ApActivity): Promise<void> {
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  await Federation.removeApFollow({ actorUrl, targetUserId: targetUser._id }, {});
}

// ── handleApAccept ─────────────────────────────────────────────
async function handleApAccept(localUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const remoteActorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    await Federation.updateApFollow(
      { actorUrl: remoteActorUrl, targetUserId: localUser._id },
      { $set: { accepted: true, acceptedAt: Date.now() } }
    );
    logger.info({ localUser: localUser.username, remoteActor: remoteActorUrl, event: 'federation.follow.accepted' }, 'Remote Follow request accepted.');
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.accept_handle_failed' }, 'Failed to process Accept activity.');
  }
}

// ── handleApReject ─────────────────────────────────────────────
async function handleApReject(localUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const remoteActorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    await Federation.removeApFollow(
      { actorUrl: remoteActorUrl, targetUserId: localUser._id },
      {}
    );
    logger.info({ localUser: localUser.username, remoteActor: remoteActorUrl, event: 'federation.follow.rejected' }, 'Remote Follow request rejected.');
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.reject_handle_failed' }, 'Failed to process Reject activity.');
  }
}

// ── handleApDelete ─────────────────────────────────────────────
async function handleApDelete(targetUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const objectId = typeof activity.object === 'string'
      ? activity.object
      : activity.object?.id;
    if (!objectId) return;

    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    await Federation.removeApMessage({ apId: objectId, actorUrl }, {});
    logger.info({ objectId, event: 'federation.note.deleted' }, 'Federated note deleted.');
  } catch (err) {
    logger.warn({ err, event: 'federation.note.delete_handle_failed' }, 'Failed to process Delete activity.');
  }
}

// ── handleApCreate ─────────────────────────────────────────────
async function handleApCreate(targetUser: ApActor, activity: ApActivity): Promise<void> {
  try {
    const obj = activity.object;
    if (!isApObject(obj) || obj.type !== 'Note') return;

    const fedMsg = {
      _id:          uuidv4(),
      apId:         obj.id,
      actorUrl:     typeof activity.actor === 'string' ? activity.actor : activity.actor?.id,
      targetUserId: targetUser._id,
      content:      obj.content || obj.name || '',
      summary:      obj.summary || null,
      sensitive:    obj.sensitive || false,
      inReplyTo:    obj.inReplyTo || null,
      published:    obj.published ? new Date(obj.published).getTime() : Date.now(),
      createdAt:    Date.now(),
    };

    await Federation.insertApMessage(fedMsg);
    logger.info({ noteId: obj.id, event: 'federation.note.created' }, 'Federated note stored.');
  } catch (err) {
    logger.warn({ err, event: 'federation.note.create_handle_failed' }, 'Failed to process Create activity.');
  }
}

// ── signRequest — Per-User HTTP Signature ─────────────────────
async function signRequest(method: string, url: string, body: unknown, privateKeyPem: string, actorUsername: string): Promise<{ date: string; digest: string; signature: string } | null> {
  try {
    const parsed      = new URL(url);
    const date        = new Date().toUTCString();
    const bodyStr     = typeof body === 'string' ? body : JSON.stringify(body);
    const digest      = 'SHA-256=' + createHash('sha256').update(bodyStr).digest('base64');
    const target      = `${method.toLowerCase()} ${parsed.pathname}${parsed.search}`;
    const sigStr      = `(request-target): ${target}\nhost: ${parsed.host}\ndate: ${date}\ndigest: ${digest}`;

    const sign = createSign('RSA-SHA256');
    sign.update(sigStr);
    const signature = sign.sign(privateKeyPem, 'base64');

    const instanceUrl = process.env.INSTANCE_URL || 'http://localhost:3001';
    const actor       = actorUsername || 'system';
    const keyId       = `${instanceUrl}/api/federation/users/${actor}#main-key`;

    const sigHeader = [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      'headers="(request-target) host date digest"',
      `signature="${signature}"`,
    ].join(',');

    return { date, digest, signature: sigHeader };
  } catch (e) {
    logger.warn({ err: e, event: 'federation.http_signature.sign_failed' }, 'Failed to sign HTTP request.');
    return null;
  }
}

// ── deliverApActivity ──────────────────────────────────────────
async function deliverApActivity(inboxUrl: string, activity: Record<string, unknown>, fromUser: ApActor | null): Promise<void> {
  let targetInbox = inboxUrl;
  if (!inboxUrl.endsWith('/inbox')) {
    try {
      const r = await fetchT(inboxUrl, { headers: { 'Accept': 'application/activity+json' }, timeoutMs: 8000 });
      const actor = await r.json();
      targetInbox = actor.inbox;
    } catch { return; }
  }

  const body   = JSON.stringify(activity);
  // SECURITY: özel anahtar user_ap_keys tablosundan ayrı sorguyla alınır
  const privateKey = fromUser ? await Users.getApPrivateKey(fromUser._id) : null;
  const sigHeaders = privateKey && fromUser ? await signRequest('POST', targetInbox, body, privateKey, fromUser.username) : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/activity+json',
    'Accept':       'application/activity+json',
    'Date':         sigHeaders?.date || new Date().toUTCString(),
  };
  if (sigHeaders) {
    headers['Digest']    = sigHeaders.digest;
    headers['Signature'] = sigHeaders.signature;
  }

  try {
    const resp = await fetchT(targetInbox, { method: 'POST', headers, body, timeoutMs: 10_000 });
    if (!resp.ok) {
      logger.warn({ status: resp.status, targetInbox, event: 'federation.delivery.non_2xx' }, 'Federated delivery received non-2xx response.');
    }
  } catch (err) {
    logger.warn({ err, targetInbox, event: 'federation.delivery.failed' }, 'Federated delivery failed.');
  }
}

// ── deliverToFollowers — mesaj gönderiminde follower'lara ilet ─
async function deliverToFollowers(fromUser: ApActor, noteContent: string, noteId?: string | null): Promise<void> {
  try {
    const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const actorUrl    = `${instanceUrl}/api/federation/users/${fromUser.username}`;
    const publishedAt = Date.now();

    const noteApId  = noteId || `${actorUrl}/notes/${uuidv4()}`;
    const createId  = `${actorUrl}/activities/${uuidv4()}`;

    const note = {
      '@context': AP_CONTEXT,
      id:           noteApId,
      type:         'Note',
      attributedTo: actorUrl,
      content:      noteContent,
      published:    new Date(publishedAt).toISOString(),
      to:           ['https://www.w3.org/ns/activitystreams#Public'],
      cc:           [`${actorUrl}/followers`],
    };

    const createActivity = {
      '@context': AP_CONTEXT,
      id:        createId,
      type:      'Create',
      actor:     actorUrl,
      published: new Date(publishedAt).toISOString(),
      to:        note.to,
      cc:        note.cc,
      object:    note,
    };

    await Federation.insertActivity({
      _id:         uuidv4(),
      actorUserId: fromUser._id,
      type:        'Create',
      activityId:  createId,
      noteId:      noteApId,
      activity:    createActivity,
      publishedAt,
    });

    const follows = await Federation.findApFollows({ targetUserId: fromUser._id }) || [];
    const followArr = Array.isArray(follows) ? follows : await follows;
    if (!followArr.length) return;

    await Promise.allSettled(
      followArr.map(f => typeof f.actorUrl === 'string' ? deliverApActivity(f.actorUrl, createActivity, fromUser) : Promise.resolve())
    );
  } catch (err) {
    logger.warn({ err, event: 'federation.outbox.deliver_failed' }, 'Failed to deliver outbox activity.');
  }
}

export { handleApFollow,
  handleApUnfollow,
  handleApAccept,
  handleApReject,
  handleApCreate,
  handleApDelete,
  signRequest,
  deliverApActivity,
  deliverToFollowers, };
