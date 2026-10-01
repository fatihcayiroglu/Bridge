// server/routes/federation/delivery.ts
// ActivityPub HTTP delivery — imzalı POST + persistent retry queue
// Retry queue artık ap_delivery_queue koleksiyonuna yazılır; server restart'ta pending delivery'ler kaybolmaz.

import logger from '../../lib/logger';
import { fetchT } from '../../lib/fetch';
import { Federation, Users } from '../../db/repositories';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { checkFederationACL } from '../admin/federation-acl';

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
//
// P5 FED-06: the schedule used to be 30 s, 2 min, 10 min — after ~12.5 minutes
// a delivery was dropped for good. Measured in the two-instance lab: a peer
// that was down for 15 minutes (an upgrade, a reboot) silently never received
// what was posted meanwhile. The default now spans ~3.5 days with backoff;
// operators can set FEDERATION_DELIVERY_RETRY_DELAYS_MS (comma-separated ms).
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000,          // 30s … 2h
  14_400_000, 28_800_000, 43_200_000, 86_400_000, 86_400_000, 86_400_000, // 4h … 24h
];
const RETRY_DELAY_MIN_MS = 1_000;
const RETRY_DELAY_MAX_MS = 7 * 86_400_000;

/** Parses FEDERATION_DELIVERY_RETRY_DELAYS_MS; an invalid value is refused loudly, never half-applied. */
export function parseRetrySchedule(raw: string | undefined): number[] {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_RETRY_DELAYS_MS];
  const parts = raw.split(',').map((p) => p.trim());
  const delays = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  const valid = delays.length > 0 && delays.length <= 50
    && delays.every((d) => Number.isSafeInteger(d) && d >= RETRY_DELAY_MIN_MS && d <= RETRY_DELAY_MAX_MS);
  if (!valid) {
    logger.error({ event: 'federation.delivery.invalid_retry_schedule', value: raw.slice(0, 200) },
      'FEDERATION_DELIVERY_RETRY_DELAYS_MS is invalid (1..50 integers, each 1000..604800000 ms); using the default schedule.');
    return [...DEFAULT_RETRY_DELAYS_MS];
  }
  return delays;
}

const RETRY_DELAYS = parseRetrySchedule(process.env.FEDERATION_DELIVERY_RETRY_DELAYS_MS);
const INLINE_DELIVERY_WAIT_MS = 1_500;
const MAX_ATTEMPTS = RETRY_DELAYS.length;
const RETRY_WORKER_ID = `federation:${process.pid}:${uuidv4()}`;
const RETRY_LEASE_MS = 120_000;
const RETRY_BATCH = 50;

async function _persistRetry(id: string, payload: DeliveryPayload, attempt: number, claimOwner?: string): Promise<void> {
  if (attempt >= MAX_ATTEMPTS) {
    // Dead letter: the one place a federated activity is knowingly lost —
    // logged at error level with enough to find it, never its content.
    logger.error({
      id, event: 'federation.delivery.max_retries', attempts: attempt,
      inboxHost: _hostOf(payload.inboxUrl), activityType: payload.activity?.type, activityId: payload.activity?.id,
    }, 'Federation delivery dead-lettered: retry schedule exhausted; giving up.');
    await Federation.removeDeliveryEntry(id, claimOwner);
    return;
  }
  const delay = RETRY_DELAYS[attempt] ?? RETRY_DELAYS[RETRY_DELAYS.length - 1]!;
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

let _retryWorker: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the durable delivery retry worker and the startup recovery pass.
 *
 * P5 SH-01b: both used to start as a side effect of IMPORTING this module —
 * before `initSchema` had applied the migration chain. On a fresh install the
 * recovery pass queried `ap_delivery_queue` before it existed (a warn line on
 * every first boot); on an upgrade it failed and left queued deliveries to the
 * next 30 s tick. `runtime.ts` now calls this after the schema is ready.
 * Idempotent: a second call does nothing.
 */
export function startFederationDeliveryWorker(): void {
  if (_retryWorker) return;
  // Retry worker — her 30 saniyede bir çalışır; DB'den pending delivery'leri alır
  _retryWorker = setInterval(async () => {
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
}

/** Graceful shutdown / tests. */
export function stopFederationDeliveryWorker(): void {
  if (_retryWorker) clearInterval(_retryWorker);
  _retryWorker = null;
}

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
function _hostOf(url: unknown): string {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * P5 FED-05: the domain ACL used to apply to INBOUND traffic only — a domain an
 * admin had blocked still received every post, follow and like this instance
 * sent (and its actor documents were still fetched). 'blocked' drops the
 * delivery; 'unknown' (ACL store unavailable) keeps it queued: never deliver on
 * an unanswered ACL question.
 */
async function _outboundAcl(url: string): Promise<'allowed' | 'blocked' | 'unknown'> {
  const host = _hostOf(url);
  if (!host) return 'allowed';
  try {
    return (await checkFederationACL(host)).allowed ? 'allowed' : 'blocked';
  } catch (err) {
    logger.warn({ err, host, event: 'federation.delivery.acl_unavailable' }, 'Federation ACL unavailable; delivery stays queued.');
    return 'unknown';
  }
}

async function _aclStops(url: string, payload: DeliveryPayload, attempt: number, retryId: string | null, claimOwner?: string): Promise<boolean> {
  const verdict = await _outboundAcl(url);
  if (verdict === 'allowed') return false;
  if (verdict === 'blocked') {
    logger.info({ host: _hostOf(url), activityType: payload.activity?.type, event: 'federation.delivery.blocked_by_acl' },
      'Delivery to a blocked federation domain dropped.');
    if (retryId) await Federation.removeDeliveryEntry(retryId, claimOwner);
  } else if (retryId) {
    await _persistRetry(retryId, payload, attempt, claimOwner);
  }
  return true;
}

async function _doDeliver(payload: DeliveryPayload, attempt: number, retryId: string | null, claimOwner?: string): Promise<void> {
  const { inboxUrl, activity, fromUser } = payload;

  // Before resolving: resolving fetches the remote actor document.
  if (await _aclStops(inboxUrl, payload, attempt, retryId, claimOwner)) return;

  const targetInbox = await resolveInbox(inboxUrl);
  if (!targetInbox) {
    logger.warn({ inboxUrl, event: 'federation.delivery.no_inbox' }, 'Could not resolve inbox URL; scheduling retry.');
    if (retryId) await _persistRetry(retryId, payload, attempt, claimOwner);
    return;
  }
  // The resolved inbox may live on another (blocked) domain than the actor.
  if (_hostOf(targetInbox) !== _hostOf(inboxUrl)
    && await _aclStops(targetInbox, payload, attempt, retryId, claimOwner)) return;

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

// ── Public: can this actor be followed at all? ──────────────────
/**
 * P5 FED-08 — measured in the two-instance lab: a follow of an actor on a
 * private address (or a blocked domain, or a URL that is not an actor at all)
 * answered 200, stored an outgoing follow and queued a delivery that could
 * never succeed — retried for days under the FED-06 schedule. The SSRF guard
 * did hold (no connection was made); the follow just lied about success.
 * The actor document is now fetched first, through the same SSRF-guarded
 * client and the outbound domain ACL, and must name an inbox.
 */
export type FollowTargetVerdict =
  | { ok: true }
  | { ok: false; status: 403 | 422 | 503; error: string };

export async function resolveFollowTarget(actorUrl: string): Promise<FollowTargetVerdict> {
  const blocked: FollowTargetVerdict = { ok: false, status: 403, error: 'This instance does not federate with that domain' };
  const unresolvable: FollowTargetVerdict = { ok: false, status: 422, error: 'Remote actor could not be resolved' };
  const unknown: FollowTargetVerdict = { ok: false, status: 503, error: 'Federation policy could not be evaluated; try again' };

  const acl = await _outboundAcl(actorUrl);
  if (acl === 'blocked') return blocked;
  if (acl === 'unknown') return unknown;
  try {
    const r = await fetchT(actorUrl, { headers: { Accept: 'application/activity+json' }, timeoutMs: 8000 });
    if (!r.ok) return unresolvable;
    const doc = await r.json() as { inbox?: unknown; id?: unknown };
    const inbox = typeof doc?.inbox === 'string' ? doc.inbox : '';
    if (!/^https?:\/\//i.test(inbox)) return unresolvable;
    const inboxAcl = await _outboundAcl(inbox);
    if (inboxAcl === 'blocked') return blocked;
    if (inboxAcl === 'unknown') return unknown;
    return { ok: true };
  } catch {
    // SSRF refusal, DNS failure, timeout, invalid JSON: never echo the reason
    // (it would describe this instance's network to the requester).
    return unresolvable;
  }
}

// ── Public: deliver one activity to one inbox ──────────────────
async function deliverApActivity(inboxUrl: string, activity: Record<string, unknown>, fromUser: ApActor | null): Promise<void> {
  const id = uuidv4();
  const payload: DeliveryPayload = { inboxUrl, activity, fromUser };
  // Persist BEFORE the first network attempt. Otherwise a process crash after
  // entering fetchT() but before its promise settles can lose the delivery
  // without ever creating a retry row. Success removes this durable intent.
  await _persistRetry(id, payload, 0);
  // P5 FED-09 — measured in the two-instance lab: with one follower's server
  // hanging, publishing took ~8 s (and an inbound Follow held the remote's
  // request open while its Accept was delivered back), because the request
  // awaited the first network attempt. The durable row above is the
  // guarantee; the request now waits at most INLINE_DELIVERY_WAIT_MS for the
  // first attempt, which carries on in the background (its outcome lands in
  // the queue row exactly as before). Fast peers are unaffected.
  const attempt = _doDeliver(payload, 0, id);
  attempt.catch((err) => logger.warn({ err, id, event: 'federation.delivery.background_attempt_failed' },
    'Background delivery attempt failed; the durable queue row remains for the retry worker.'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([attempt, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, INLINE_DELIVERY_WAIT_MS);
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
