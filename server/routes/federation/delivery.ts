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
function parseDeliveryAttempts(value: unknown): number {
  let parsed: number;
  if (typeof value === 'number') parsed = value;
  else if (typeof value === 'string' && /^[0-9]+$/.test(value)) parsed = Number(value);
  else throw new Error('Invalid persisted ActivityPub delivery attempts');
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Invalid persisted ActivityPub delivery attempts');
  return parsed;
}

const AP_CONTEXT  = 'https://www.w3.org/ns/activitystreams';
const instanceUrl = () => process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
const actorUrl    = (u: string): string => `${instanceUrl()}/api/federation/users/${u}`;

// ── Persistent retry queue ─────────────────────────────────────
// ap_delivery_queue koleksiyonu: { _id, payload, attempts, nextAt, createdAt }
// Server restart'ta pending delivery'ler otomatik kurtarılır.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS = [30_000, 120_000, 600_000]; // 30s, 2m, 10m
const RETRY_WORKER_ID = `federation:${process.pid}:${uuidv4()}`;
const RETRY_LEASE_MS = 120_000;
const RETRY_BATCH = 50;

async function _persistRetry(id: string, payload: DeliveryPayload, attempt: number, claimOwner?: string): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) {
    logger.warn({ id, event: 'federation.delivery.max_retries' }, 'Max retries reached; giving up.');
    await Federation.removeDeliveryEntry(id, claimOwner);
    return;
  }
  const delay = RETRY_DELAYS[attempt] || 600_000;
  const entry = {
    payload,
    attempts: attempt,
    nextAt:   Date.now() + delay,
    createdAt: Date.now(),
  };
  // A durable retry write is part of delivery correctness. Silently swallowing
  // this error turns a transient DB failure into an undetectable lost message.
  if (claimOwner) {
    await Federation.releaseDeliveryClaim(id, claimOwner, entry);
  } else {
    await Federation.upsertDeliveryEntry(id, entry);
  }
}

// Retry worker — her 30 saniyede bir çalışır; DB'den pending delivery'leri alır
const _retryWorker = setInterval(async () => {
  try {
    const pending = await Federation.claimPendingDeliveries(Date.now(), RETRY_WORKER_ID, RETRY_LEASE_MS, RETRY_BATCH);
    for (const entry of pending) {
      if (!isDeliveryPayload(entry.payload)) {
        logger.warn({ id: entry._id, event: 'federation.delivery.invalid_queue_payload' }, 'Invalid delivery payload; removing poison entry.');
        await Federation.removeDeliveryEntry(String(entry._id), RETRY_WORKER_ID);
        continue;
      }
      // Do NOT delete before the network attempt. A process crash between
      // delete and POST would permanently lose the delivery. Persisted attempt
      // state is security/durability metadata: malformed values are poison, not
      // "zero retries". Drop such rows instead of creating an endless loop.
      let attempts: number;
      try { attempts = parseDeliveryAttempts(entry.attempts); }
      catch {
        logger.warn({ id: entry._id, event: 'federation.delivery.invalid_attempts' }, 'Invalid delivery attempts; removing poison entry.');
        await Federation.removeDeliveryEntry(String(entry._id), RETRY_WORKER_ID);
        continue;
      }
      if (attempts >= MAX_ATTEMPTS) {
        await Federation.removeDeliveryEntry(String(entry._id), RETRY_WORKER_ID);
        continue;
      }
      await _doDeliver(entry.payload, attempts + 1, String(entry._id), RETRY_WORKER_ID);
    }
  } catch (err) {
    logger.warn({ err, event: 'federation.delivery.retry_worker_failed' }, 'Retry worker failed; durable entries remain queued.');
  }
}, 30_000);

// Node.js process exit'te timer'ı temizle
if (_retryWorker.unref) _retryWorker.unref();

// ── Startup recovery ──────────────────────────────────────────
// Server başladığında kalmış pending delivery'leri hemen kuyruğa al.
// setImmediate ile event loop'un başlamasını bekle.
setImmediate(async () => {
  try {
    const pending = await Federation.claimPendingDeliveries(Date.now(), RETRY_WORKER_ID, RETRY_LEASE_MS, RETRY_BATCH);
    if (pending.length > 0) {
      logger.info(
        { count: pending.length, event: 'federation.delivery.startup_recovery' },
        'Recovering pending AP deliveries from previous run.'
      );
      for (const entry of pending) {
        if (!isDeliveryPayload(entry.payload)) {
          logger.warn({ id: entry._id, event: 'federation.delivery.invalid_startup_payload' }, 'Invalid startup delivery payload; removing poison entry.');
          await Federation.removeDeliveryEntry(String(entry._id), RETRY_WORKER_ID);
          continue;
        }
        let attempts: number;
        try { attempts = parseDeliveryAttempts(entry.attempts); }
        catch {
          logger.warn({ id: entry._id, event: 'federation.delivery.invalid_startup_attempts' }, 'Invalid startup delivery attempts; removing poison entry.');
          await Federation.removeDeliveryEntry(String(entry._id), RETRY_WORKER_ID);
          continue;
        }
        if (attempts >= MAX_ATTEMPTS) {
          await Federation.removeDeliveryEntry(String(entry._id), RETRY_WORKER_ID);
          continue;
        }
        // Startup recovery is a real retry too. The old path reused the stored
        // attempt number, so repeated restarts could keep the same delivery at
        // the same retry generation forever.
        await _doDeliver(entry.payload, attempts + 1, String(entry._id), RETRY_WORKER_ID);
      }
    }
  } catch (err) {
    logger.warn({ err, event: 'federation.delivery.startup_recovery_failed' }, 'Startup delivery recovery failed; durable entries remain for the retry worker.');
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
async function resolveInbox(actorOrInboxUrl: string, depth = 0): Promise<string | null> {
  if (actorOrInboxUrl.endsWith('/inbox') || actorOrInboxUrl.endsWith('/sharedInbox')) {
    return actorOrInboxUrl;
  }
  if (depth > 2) return null;
  try {
    const r = await fetchT(actorOrInboxUrl, {
      headers: { Accept: 'application/activity+json' },
      timeoutMs: 8000,
    });
    if (!r.ok) return null;
    const doc = await r.json() as {
      endpoints?: { sharedInbox?: string };
      inbox?: string;
      attributedTo?: string | string[];
      actor?: string;
    };
    const direct = doc.endpoints?.sharedInbox || doc.inbox;
    if (typeof direct === 'string' && direct) return direct;

    // Like/Undo/Announce callers commonly know the Note URL, not the actor URL.
    // A Note is not an inbox, so follow its owner before giving up. This keeps
    // the durable queue target stable while still resolving the real recipient.
    const owner = typeof doc.attributedTo === 'string'
      ? doc.attributedTo
      : Array.isArray(doc.attributedTo) && typeof doc.attributedTo[0] === 'string'
        ? doc.attributedTo[0]
        : typeof doc.actor === 'string' ? doc.actor : null;
    if (owner && owner !== actorOrInboxUrl) return resolveInbox(owner, depth + 1);
    return null;
  } catch { return null; }
}

// ── Core delivery function ─────────────────────────────────────
async function _doDeliver(payload: DeliveryPayload, attempt: number, retryId: string | null, claimOwner?: string): Promise<void> {
  const { inboxUrl, activity, fromUser } = payload;

  const targetInbox = await resolveInbox(inboxUrl);
  if (!targetInbox) {
    logger.warn({ inboxUrl, event: 'federation.delivery.no_inbox' }, 'Could not resolve inbox URL; scheduling retry.');
    if (retryId) await _persistRetry(retryId, payload, attempt, claimOwner);
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
    if (retryId) await _persistRetry(retryId, payload, attempt, claimOwner);
    return;
  }

  if (!resp.ok) {
    logger.warn({ status: resp.status, targetInbox, attempt, event: 'federation.delivery.non_2xx' },
      'Non-2xx response; scheduling retry.');
    if (retryId) {
      if (resp.status === 410) await Federation.removeDeliveryEntry(retryId, claimOwner); // kalıcı hata
      else await _persistRetry(retryId, payload, attempt, claimOwner);
    }
    return;
  }

  // Success is the only normal point at which a durable queue entry is
  // acknowledged/deleted. Initial deliveries may not have an entry yet; the
  // repository delete is intentionally idempotent.
  if (retryId) await Federation.removeDeliveryEntry(retryId, claimOwner);
}

// ── Public: deliver one activity to one inbox ──────────────────
async function deliverApActivity(inboxUrl: string, activity: Record<string, unknown>, fromUser: ApActor | null): Promise<void> {
  const id = uuidv4();
  const payload: DeliveryPayload = { inboxUrl, activity, fromUser };
  // Persist BEFORE the first network attempt. Otherwise a process crash after
  // entering fetchT() but before its promise settles can lose the delivery
  // without ever creating a retry row. Success removes this durable intent.
  await _persistRetry(id, payload, 0);
  await _doDeliver(payload, 0, id);
}

// ── Public: fan-out an already-persisted activity exactly as authored ─────
async function fanOutActivityToFollowers(
  fromUser: ApActor,
  activity: Record<string, unknown>,
): Promise<{ followers: number; failed: number }> {
  const follows = await Federation.findApFollows({ targetUserId: fromUser._id }) || [];
  const followArr = Array.isArray(follows) ? follows : await follows;
  if (!followArr.length) return { followers: 0, failed: 0 };

  // Shared inbox deduplication. The map value is intentionally unused: one
  // durable delivery intent per inbox is enough for one ActivityPub activity.
  const inboxes = new Set<string>();
  for (const f of followArr) {
    const candidate = String(f.actorInbox || f.actorUrl || '');
    if (candidate) inboxes.add(candidate);
  }

  const results = await Promise.allSettled(
    [...inboxes].map(inbox => deliverApActivity(inbox, activity, fromUser)),
  );
  let failed = 0;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed += 1;
      logger.warn({
        err: result.reason,
        inbox: [...inboxes][index],
        event: 'federation.delivery.enqueue_failed',
      }, 'Federation delivery could not be durably queued.');
    }
  });
  return { followers: inboxes.size, failed };
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
      createdAt:   Date.now(),
    });

    await fanOutActivityToFollowers(fromUser, createActivity);
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
    _id: uuidv4(), fromUserId: fromUser._id, activityId: likeActivity.id, objectUrl, createdAt: Date.now(),
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
    _id: uuidv4(), fromUserId: fromUser._id, activityId: announceActivity.id, objectUrl, createdAt: Date.now(),
  });
  await deliverApActivity(objectUrl, announceActivity, fromUser);
  return announceActivity;
}

export { deliverApActivity,
  fanOutActivityToFollowers,
  deliverToFollowers,
  sendFollowRequest,
  sendUnfollow,
  sendLike,
  sendAnnounce,
  signRequest,
  parseDeliveryAttempts, };
