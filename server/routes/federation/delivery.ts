// server/routes/federation/delivery.ts
// ActivityPub HTTP delivery — imzalı POST + persistent retry queue
// Retry queue artık ap_delivery_queue koleksiyonuna yazılır; server restart'ta pending delivery'ler kaybolmaz.

import logger from '../../lib/logger';
import { fetchT } from '../../lib/fetch';
import { Federation, Users } from '../../db/repositories';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

interface ApActor { _id: string; username: string; apPublicKey?: string | null; apPrivateKey?: string | null; }
interface DeliveryPayload { inboxUrl: string; activity: Record<string, unknown>; fromUser: ApActor | null; }

function isDeliveryPayload(value: unknown): value is DeliveryPayload {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as { inboxUrl?: unknown }).inboxUrl === 'string'
    && !!(value as { activity?: unknown }).activity
    && typeof (value as { activity?: unknown }).activity === 'object';
}
function toAttempts(value: unknown): number { return typeof value === 'number' ? value : Number(value ?? 0) || 0; }

const AP_CONTEXT  = 'https://www.w3.org/ns/activitystreams';
const instanceUrl = () => process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
const actorUrl    = (u: string): string => `${instanceUrl()}/api/federation/users/${u}`;

// ── Persistent retry queue ─────────────────────────────────────
// ap_delivery_queue koleksiyonu: { _id, payload, attempts, nextAt, createdAt }
// Server restart'ta pending delivery'ler otomatik kurtarılır.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [30_000, 120_000, 600_000]; // 30s, 2m, 10m

async function _persistRetry(id: string, payload: DeliveryPayload, attempt: number): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) {
    logger.warn({ id, event: 'federation.delivery.max_retries' }, 'Max retries reached; giving up.');
    await Federation.removeDeliveryEntry(id).catch(() => {});
    return;
  }
  const delay = RETRY_DELAYS[attempt] || 600_000;
  const entry = {
    payload,
    attempts: attempt,
    nextAt:   Date.now() + delay,
    createdAt: Date.now(),
  };
  await Federation.upsertDeliveryEntry(id, entry).catch(() => {});
}

// Retry worker — her 30 saniyede bir çalışır; DB'den pending delivery'leri alır
const _retryWorker = setInterval(async () => {
  try {
    const pending = await Federation.findPendingDeliveries(Date.now());
    for (const entry of pending) {
      await Federation.removeDeliveryEntry(String(entry._id)).catch(() => {});
      if (isDeliveryPayload(entry.payload)) _doDeliver(entry.payload, toAttempts(entry.attempts) + 1, String(entry._id)).catch(() => {});
    }
  } catch {
    // DB erişim hatası — sessizce geç
  }
}, 30_000);

// Node.js process exit'te timer'ı temizle
if (_retryWorker.unref) _retryWorker.unref();

// ── Startup recovery ──────────────────────────────────────────
// Server başladığında kalmış pending delivery'leri hemen kuyruğa al.
// setImmediate ile event loop'un başlamasını bekle.
setImmediate(async () => {
  try {
    const pending = await Federation.findPendingDeliveries(Date.now());
    if (pending.length > 0) {
      logger.info(
        { count: pending.length, event: 'federation.delivery.startup_recovery' },
        'Recovering pending AP deliveries from previous run.'
      );
      for (const entry of pending) {
        await Federation.removeDeliveryEntry(String(entry._id)).catch(() => {});
        if (isDeliveryPayload(entry.payload)) _doDeliver(entry.payload, toAttempts(entry.attempts), String(entry._id)).catch(() => {});
      }
    }
  } catch {
    // DB henüz hazır değilse sessizce geç
  }
});

// ── HTTP Signature ─────────────────────────────────────────────
async function signRequest(method: string, url: string, body: unknown, privateKeyPem: string, actorUsername: string): Promise<{ date: string; digest: string; signature: string } | null> {
  try {
    const parsed  = new URL(url);
    const date    = new Date().toUTCString();
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const digest  = 'SHA-256=' + crypto.createHash('sha256').update(bodyStr).digest('base64');
    const target  = `${method.toLowerCase()} ${parsed.pathname}${parsed.search}`;
    const sigStr  = `(request-target): ${target}\nhost: ${parsed.host}\ndate: ${date}\ndigest: ${digest}`;

    const sign    = crypto.createSign('RSA-SHA256');
    sign.update(sigStr);
    const signature = sign.sign(privateKeyPem, 'base64');

    const keyId = `${actorUrl(actorUsername || 'system')}#main-key`;
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

// ── Resolve inbox URL from actor URL ─────────────────────────────
async function resolveInbox(actorOrInboxUrl: string): Promise<string | null> {
  if (actorOrInboxUrl.endsWith('/inbox') || actorOrInboxUrl.endsWith('/sharedInbox')) {
    return actorOrInboxUrl;
  }
  try {
    const r = await fetchT(actorOrInboxUrl, {
      headers: { Accept: 'application/activity+json' },
      timeoutMs: 8000,
    });
    const actor = await r.json() as { endpoints?: { sharedInbox?: string }; inbox?: string };
    return actor.endpoints?.sharedInbox || actor.inbox || null;
  } catch { return null; }
}

// ── Core delivery function ─────────────────────────────────────
async function _doDeliver(payload: DeliveryPayload, attempt: number, retryId: string | null): Promise<void> {
  const { inboxUrl, activity, fromUser } = payload;

  const targetInbox = await resolveInbox(inboxUrl);
  if (!targetInbox) {
    logger.warn({ inboxUrl, event: 'federation.delivery.no_inbox' }, 'Could not resolve inbox URL.');
    return;
  }

  const body       = JSON.stringify(activity);
  // SECURITY: özel anahtar user_ap_keys tablosundan ayrı sorguyla alınır
  const privateKey = fromUser ? await Users.getApPrivateKey(fromUser._id) : null;
  const sigHeaders = privateKey && fromUser
    ? await signRequest('POST', targetInbox, body, privateKey, fromUser.username)
    : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/activity+json',
    Accept:         'application/activity+json',
    Date:           sigHeaders?.date || new Date().toUTCString(),
  };
  if (sigHeaders) {
    headers['Digest']    = sigHeaders.digest;
    headers['Signature'] = sigHeaders.signature;
  }

  let resp;
  try {
    resp = await fetchT(targetInbox, {
      method: 'POST',
      headers,
      body,
      timeoutMs: 10_000,
    });
  } catch (err) {
    logger.warn({ err, targetInbox, attempt, event: 'federation.delivery.failed' }, 'Delivery failed; scheduling retry.');
    if (retryId) await _persistRetry(retryId, payload, attempt);
    return;
  }

  if (!resp.ok) {
    logger.warn({ status: resp.status, targetInbox, attempt, event: 'federation.delivery.non_2xx' },
      'Non-2xx response; scheduling retry.');
    if (retryId && resp.status !== 410) await _persistRetry(retryId, payload, attempt); // 410 Gone = kalıcı hata
  }
}

// ── Public: deliver one activity to one inbox ──────────────────
async function deliverApActivity(inboxUrl: string, activity: Record<string, unknown>, fromUser: ApActor | null): Promise<void> {
  const id = uuidv4();
  await _doDeliver({ inboxUrl, activity, fromUser }, 0, id);
}

// ── Public: fan-out Create activity to all followers ──────────
async function deliverToFollowers(fromUser: ApActor, noteContent: string, noteId?: string | null): Promise<void> {
  try {
    const url        = actorUrl(fromUser.username);
    const publishedAt = Date.now();
    const noteApId   = noteId || `${url}/notes/${uuidv4()}`;
    const createId   = `${url}/activities/${uuidv4()}`;

    const note = {
      '@context':    AP_CONTEXT,
      id:            noteApId,
      type:          'Note',
      attributedTo:  url,
      content:       noteContent,
      published:     new Date(publishedAt).toISOString(),
      to:            ['https://www.w3.org/ns/activitystreams#Public'],
      cc:            [`${url}/followers`],
    };

    const createActivity = {
      '@context': AP_CONTEXT,
      id:         createId,
      type:       'Create',
      actor:      url,
      published:  new Date(publishedAt).toISOString(),
      to:         note.to,
      cc:         note.cc,
      object:     note,
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

    const follows  = await Federation.findApFollows({ targetUserId: fromUser._id }) || [];
    const followArr = Array.isArray(follows) ? follows : await follows;
    if (!followArr.length) return;

    // Inbox URL'lerini grupla (shared inbox deduplication)
    const inboxSet = new Map();
    for (const f of followArr) {
      inboxSet.set(f.actorInbox || f.actorUrl, f.actorUrl);
    }

    await Promise.allSettled(
      [...inboxSet.keys()].map(inbox =>
        deliverApActivity(inbox, createActivity, fromUser)
      )
    );
  } catch (err) {
    logger.warn({ err, event: 'federation.outbox.deliver_failed' }, 'Failed to deliver outbox activity.');
  }
}

// ── Public: send outgoing Follow request ──────────────────────
async function sendFollowRequest(fromUser: ApActor, targetActorUrl: string) {
  const url = actorUrl(fromUser.username);
  const followId = `${url}/activities/${uuidv4()}`;

  const followActivity = {
    '@context': AP_CONTEXT,
    id:         followId,
    type:       'Follow',
    actor:      url,
    object:     targetActorUrl,
  };

  // Kaydet (pending)
  await Federation.insertApOutgoingFollow({
    _id:            uuidv4(),
    fromUserId:     fromUser._id,
    targetActorUrl,
    activityId:     followId,
    accepted:       false,
    createdAt:      Date.now(),
  });

  await deliverApActivity(targetActorUrl, followActivity, fromUser);
  return followActivity;
}

// ── Public: send Unfollow (Undo Follow) ───────────────────────
async function sendUnfollow(fromUser: ApActor, targetActorUrl: string): Promise<void> {
  const url = actorUrl(fromUser.username);

  const record = await Federation.findApOutgoingFollowOne({
    fromUserId: fromUser._id, targetActorUrl,
  });

  const undoActivity = {
    '@context': AP_CONTEXT,
    id:         `${url}/activities/${uuidv4()}`,
    type:       'Undo',
    actor:      url,
    object:     record
      ? { type: 'Follow', id: record.activityId, actor: url, object: targetActorUrl }
      : { type: 'Follow', actor: url, object: targetActorUrl },
  };

  await Federation.removeApOutgoingFollow({ fromUserId: fromUser._id, targetActorUrl }, {});
  await deliverApActivity(targetActorUrl, undoActivity, fromUser);
}

// ── Public: send Like ─────────────────────────────────────────
async function sendLike(fromUser: ApActor, objectUrl: string) {
  const url = actorUrl(fromUser.username);
  const likeActivity = {
    '@context': AP_CONTEXT,
    id:         `${url}/activities/${uuidv4()}`,
    type:       'Like',
    actor:      url,
    object:     objectUrl,
  };
  await Federation.insertApLike({
    _id: uuidv4(), fromUserId: fromUser._id, objectUrl, createdAt: Date.now(),
  });
  await deliverApActivity(objectUrl, likeActivity, fromUser);
  return likeActivity;
}

// ── Public: send Announce (Boost) ────────────────────────────
async function sendAnnounce(fromUser: ApActor, objectUrl: string) {
  const url = actorUrl(fromUser.username);
  const announceActivity = {
    '@context': AP_CONTEXT,
    id:         `${url}/activities/${uuidv4()}`,
    type:       'Announce',
    actor:      url,
    object:     objectUrl,
    published:  new Date().toISOString(),
    to:         ['https://www.w3.org/ns/activitystreams#Public'],
    cc:         [`${url}/followers`],
  };
  await Federation.insertApAnnounce({
    _id: uuidv4(), fromUserId: fromUser._id, objectUrl, createdAt: Date.now(),
  });
  await deliverApActivity(objectUrl, announceActivity, fromUser);
  return announceActivity;
}

export { deliverApActivity,
  deliverToFollowers,
  sendFollowRequest,
  sendUnfollow,
  sendLike,
  sendAnnounce,
  signRequest, };
