// server/routes/federation/activitypub.ts
// ActivityPub actor endpoints, inbox, outbox, followers/following, webfinger

import express from 'express';
const router       = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Users, Federation } from '../../db/repositories';
import { authMiddleware, castAuthed } from '../../middleware/auth';
import { verifyHttpSignature } from '../../lib/httpSignature';
import logger from '../../lib/logger';
import { checkFederationACL } from '../admin';
import { handleApFollow, handleApUnfollow, handleApAccept,
  handleApReject, handleApCreate, handleApDelete, handleApUpdate,
  handleApLike, handleApAnnounce, fanOutActivityToFollowers } from './helpers';
// Sprint 120: D6 — ActivityPub inbox flood koruması entegre edildi
import { federationGlobalRateLimit, federationInboxRateLimit } from '../../middleware/federationRateLimit';
// Sprint 121 FIX 6: webfinger / actor endpoint'leri public, rate limit zorunlu
import { limits } from '../../middleware/rateLimit';
import { parseNonNegativeSafeIntQuery } from '../../lib/queryNumbers';

const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const activityPubJsonParser = express.json({
  type: ['application/activity+json', 'application/ld+json', 'application/json'],
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function normalizeActorIdentity(value: unknown): string | null {
  const raw = typeof value === 'string'
    ? value
    : isRecord(value) && typeof value.id === 'string' ? value.id : '';
  if (!raw) return null;
  try {
    const url = new URL(raw);
    url.hash = '';
    // Actor URLs are identifiers; tolerate only an insignificant trailing slash.
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * @openapi
 * /federation/webfinger:
 *   get:
 *     tags: [Federation]
 *     summary: WebFinger kullanıcı keşfi
 *     parameters:
 *       - in: query
 *         name: resource
 *         required: true
 *         schema: { type: string, example: 'acct:user@domain.com' }
 *     responses:
 *       200: { description: JRD+JSON WebFinger yanıtı }
 *       400: { description: Geçersiz resource parametresi }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/webfinger', limits.api(), async (req: import("express").Request, res: import("express").Response) => {
  const resource = String(req.query.resource ?? '');
  if (!resource.startsWith('acct:')) return res.status(400).json({ error: 'Invalid resource' });

  const acct = resource.slice(5);
  const at = acct.lastIndexOf('@');
  if (at <= 0 || at === acct.length - 1) return res.status(400).json({ error: 'Invalid resource' });
  const localPart = acct.slice(0, at);
  const requestedDomain = acct.slice(at + 1).toLowerCase();
  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  let localDomain: string;
  try { localDomain = new URL(instanceUrl).hostname.toLowerCase(); }
  catch { return res.status(500).json({ error: 'Federation instance URL is invalid' }); }
  if (requestedDomain !== localDomain) return res.status(400).json({ error: 'Resource is not local to this instance' });

  const user = await Users.findByUsername(localPart);
  if (!user) return res.status(404).json({ error: 'Not found' });

  res.set('Content-Type', 'application/jrd+json');
  res.json({
    subject: resource,
    links: [{
      rel:  'self',
      type: 'application/activity+json',
      href: `${instanceUrl}/api/federation/users/${user.username}`,
    }],
  });
});

/**
 * @openapi
 * /federation/users/{username}:
 *   get:
 *     tags: [Federation]
 *     summary: ActivityPub Actor profili
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: activity+json Actor nesnesi }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/users/:username', limits.api(), async (req: import("express").Request, res: import("express").Response) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl = `${instanceUrl}/api/federation/users/${user.username}`;

  res.set('Content-Type', 'application/activity+json');
  res.json({
    '@context': [AP_CONTEXT, 'https://w3id.org/security/v1'],
    id:                actorUrl,
    type:              'Person',
    preferredUsername: user.username,
    name:              user.displayName || user.username,
    summary:           user.bio || '',
    url:               `${instanceUrl}/profile/${user.username}`,
    inbox:             `${actorUrl}/inbox`,
    outbox:            `${actorUrl}/outbox`,
    followers:         `${actorUrl}/followers`,
    following:         `${actorUrl}/following`,
    icon: user.avatarUrl ? {
      type:      'Image',
      mediaType: 'image/jpeg',
      url:       user.avatarUrl,
    } : undefined,
    publicKey: {
      id:           `${actorUrl}#main-key`,
      owner:        actorUrl,
      publicKeyPem: user.apPublicKey || '(not yet generated)',
    },
  });
});

/**
 * @openapi
 * /federation/users/{username}/inbox:
 *   post:
 *     tags: [Federation]
 *     summary: ActivityPub inbox — gelen aktiviteler
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, description: ActivityPub Activity nesnesi }
 *     responses:
 *       202: { description: Aktivite kabul edildi }
 *       401: { description: Geçersiz HTTP Signature }
 *       403: { description: Federasyon ACL engeli }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.post('/users/:username/inbox', activityPubJsonParser, federationGlobalRateLimit, federationInboxRateLimit, async (req: import("express").Request, res: import("express").Response) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  const sigResult = await verifyHttpSignature(req);
  if (!sigResult.ok) {
    if (process.env.NODE_ENV === 'production' || req.headers['signature']) {
      logger.warn({ reason: sigResult.reason, event: 'federation.inbox.signature_rejected' }, 'HTTP signature rejected for inbox request.');
      return res.status(401).json({ error: 'Invalid HTTP Signature', detail: sigResult.reason });
    }
    logger.warn({ reason: sigResult.reason, event: 'federation.inbox.signature_missing_dev' }, 'HTTP signature missing in development mode; request allowed.');
  }

  const activity = req.body;
  if (!activity?.type) return res.status(400).json({ error: 'Invalid activity' });

  // A valid RSA signature proves a key, not automatically the actor named in
  // the JSON body. Bind those identities before any ACL lookup or persistence;
  // otherwise any federated actor with a valid key could spoof another actor.
  const signedRequest = process.env.NODE_ENV === 'production' || !!req.headers['signature'];
  const claimedActor = normalizeActorIdentity(activity.actor ?? activity.attributedTo);
  if (signedRequest) {
    const signer = normalizeActorIdentity(sigResult.signerActor);
    if (!signer || !claimedActor || signer !== claimedActor) {
      logger.warn({ signer, claimedActor, keyId: sigResult.keyId, event: 'federation.inbox.actor_mismatch' },
        'HTTP signature signer does not match ActivityPub activity actor.');
      return res.status(401).json({ error: 'HTTP Signature actor mismatch' });
    }
    if (activity.id !== undefined &&
        (typeof activity.id !== 'string' || !activity.id.trim() || activity.id.length > 2048)) {
      return res.status(400).json({ error: 'ActivityPub activity id must be a bounded non-empty string' });
    }
  }

  // Federation ACL
  const actorDomain = (() => {
    try {
      const actor = activity.actor || activity.attributedTo || '';
      const url = typeof actor === 'string' ? actor : actor.id || '';
      return new URL(url).hostname;
    } catch { return null; }
  })();
  if (actorDomain) {
    const acl = await checkFederationACL(actorDomain);
    if (!acl.allowed) {
      logger.warn({ actorDomain, reason: acl.reason, event: 'federation.inbox.domain_blocked' }, 'Blocked federated inbox request due to ACL.');
      return res.status(403).json({ error: 'Federation domain blocked', reason: acl.reason });
    }
  }

  const now = Date.now();
  let inboxJournalId = uuidv4();
  let inboxClaimOwner: string | null = null;

  if (signedRequest && claimedActor && typeof activity.id === 'string') {
    inboxClaimOwner = uuidv4();
    const claim = await Federation.claimInboundActivity({
      id: inboxJournalId,
      targetUserId: user._id,
      actorUrl: claimedActor,
      activityId: activity.id,
      type: String(activity.type),
      activity,
      claimOwner: inboxClaimOwner,
      claimUntil: now + 5 * 60 * 1000,
      createdAt: now,
    });
    inboxJournalId = claim.id;
    if (claim.status === 'processed') {
      return res.status(202).json({ ok: true, duplicate: true });
    }
    if (claim.status === 'busy') {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'ActivityPub activity is already being processed' });
    }
  } else {
    // Development/test compatibility for intentionally unsigned fixtures. Real
    // signed federation traffic always uses the atomic claim path above.
    await Federation.insertActivity({
      _id: inboxJournalId,
      targetUserId: user._id,
      actorUrl: claimedActor,
      type: String(activity.type),
      activityId: typeof activity.id === 'string' ? activity.id : null,
      activity,
      processed: false,
      createdAt: now,
    });
  }

  try {
  switch (activity.type) {
    case 'Follow':
      await handleApFollow(user, activity);
      break;
    case 'Undo':
      if (activity.object && typeof activity.object === 'object' &&
          ['Follow', 'Like', 'Announce'].includes(String(activity.object.type))) {
        await handleApUnfollow(user, activity);
      }
      break;
    case 'Create':
      await handleApCreate(user, activity);
      break;
    case 'Update':
      await handleApUpdate(user, activity);
      break;
    case 'Delete':
      await handleApDelete(user, activity);
      break;
    case 'Like':
      await handleApLike(user, activity);
      break;
    case 'Announce':
      await handleApAnnounce(user, activity);
      break;
    case 'Accept':
      if (activity.object?.type === 'Follow' || typeof activity.object === 'string') {
        await handleApAccept(user, activity);
      }
      break;
    case 'Reject':
      if (activity.object?.type === 'Follow' || typeof activity.object === 'string') {
        await handleApReject(user, activity);
      }
      break;
  }

  if (inboxClaimOwner) {
    await Federation.completeInboundActivity(inboxJournalId, inboxClaimOwner);
  } else {
    await Federation.updateActivity({ _id: inboxJournalId }, { $set: { processed: true, processedAt: Date.now() } });
  }
  res.status(202).json({ ok: true });
  } catch (err) {
    if (inboxClaimOwner) {
      try {
        await Federation.failInboundActivity(
          inboxJournalId,
          inboxClaimOwner,
          err instanceof Error ? err.message : String(err),
        );
      } catch (releaseErr) {
        logger.error({ err: releaseErr, activityId: activity.id, event: 'federation.inbox.claim_release_failed' },
          'Failed to release ActivityPub inbox claim after handler failure.');
      }
    }
    throw err;
  }
});

/**
 * @openapi
 * /federation/users/{username}/outbox:
 *   get:
 *     tags: [Federation]
 *     summary: ActivityPub outbox — gönderilen aktiviteler
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer }
 *     responses:
 *       200: { description: OrderedCollection sayfası }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/users/:username/outbox', async (req: import("express").Request, res: import("express").Response) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const outboxUrl   = `${actorUrl}/outbox`;

  res.set('Content-Type', 'application/activity+json');

  if (req.query.page as string === 'true') {
    const PAGE_SIZE = 20;
    const minId = parseNonNegativeSafeIntQuery(req.query.min_id, 0);
    if (minId === null) return res.status(400).json({ error: 'min_id must be a safe non-negative integer' });

    const q: Record<string, unknown> = { actorUserId: user._id, type: 'Create' };
    // Historical API calls the cursor `min_id`, but it is emitted as the NEXT
    // cursor. Therefore it must select OLDER rows, otherwise page 2 repeats
    // page 1 forever. Keep the public parameter name for compatibility.
    if (minId) q.publishedAt = { $lt: minId };

    let items = await Federation.apActivitiesFind(q).sort({ publishedAt: -1 }).limit(PAGE_SIZE);
    if (!Array.isArray(items)) items = [];

    const page: Record<string, unknown> = {
      '@context':   AP_CONTEXT,
      id:           `${outboxUrl}?page=true${minId ? `&min_id=${minId}` : ''}`,
      type:         'OrderedCollectionPage',
      partOf:       outboxUrl,
      orderedItems: items.map(a => a.activity),
    };

    if (items.length === PAGE_SIZE) {
      const oldest = items[items.length - 1]?.publishedAt ?? 0;
      page.next = `${outboxUrl}?page=true&min_id=${oldest}`;
    }

    return res.json(page);
  }

  const total = await Federation.countActivities({ actorUserId: user._id, type: 'Create' });
  return res.json({
    '@context': AP_CONTEXT,
    id:         outboxUrl,
    type:       'OrderedCollection',
    totalItems: total || 0,
    first:      `${outboxUrl}?page=true`,
    last:       `${outboxUrl}?page=true&min_id=0`,
  });
});

/**
 * @openapi
 * /federation/users/{username}/followers:
 *   get:
 *     tags: [Federation]
 *     summary: Takipçi listesi (ActivityPub)
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OrderedCollection takipçi listesi }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/users/:username/followers', async (req: import("express").Request, res: import("express").Response) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;

  const follows = await Federation.findApFollows({ targetUserId: user._id }) || [];
  const items   = Array.isArray(follows) ? follows : await follows;

  res.set('Content-Type', 'application/activity+json');
  res.json({
    '@context':   AP_CONTEXT,
    id:           `${actorUrl}/followers`,
    type:         'OrderedCollection',
    totalItems:   items.length,
    orderedItems: items.map(f => f.actorUrl),
  });
});

/**
 * @openapi
 * /federation/users/{username}/following:
 *   get:
 *     tags: [Federation]
 *     summary: Takip edilen listesi (ActivityPub)
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OrderedCollection takip listesi }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/users/:username/following', async (req: import("express").Request, res: import("express").Response) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;

  // Kullanıcının dışarıya (remote) follow ettiği aktörler
  const outgoing = await Federation.findApOutgoingFollows({ fromUserId: user._id, accepted: true }) || [];
  const items    = Array.isArray(outgoing) ? outgoing : await outgoing;

  res.set('Content-Type', 'application/activity+json');
  res.json({
    '@context':   AP_CONTEXT,
    id:           `${actorUrl}/following`,
    type:         'OrderedCollection',
    totalItems:   items.length,
    orderedItems: items.map((f: Record<string, unknown>) => f.targetActorUrl),
  });
});

/**
 * @openapi
 * /federation/users/{username}/notes/{noteId}:
 *   get:
 *     tags: [Federation]
 *     summary: Tekil ActivityPub Note (mesaj) nesnesi
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: noteId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Note nesnesi }
 *       404: { description: Bulunamadı }
 */
router.get('/users/:username/notes/:noteId', async (req: import("express").Request, res: import("express").Response) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const noteApId    = `${actorUrl}/notes/${String(req.params.noteId ?? '')}`;

  const activities = await Federation.apActivitiesFind({ actorUserId: user._id, type: 'Create' }) || [];
  const arr = Array.isArray(activities) ? activities : await activities;
  const match = arr.find(a => {
    const activity = getRecord(a.activity);
    const object = getRecord(activity?.object);
    return object?.id === noteApId;
  });

  const activity = getRecord(match?.activity);
  const object = getRecord(activity?.object);
  if (!object) return res.status(404).json({ error: 'Note not found' });

  res.set('Content-Type', 'application/activity+json');
  res.json(object);
});


/**
 * @openapi
 * /federation/users/{username}/outbox:
 *   post:
 *     tags: [Federation]
 *     summary: ActivityPub outbox — Note yayınla (C2S)
 *     description: |
 *       Kimliği doğrulanmış kullanıcı adına yeni bir Note (Create aktivitesi) yayınlar
 *       ve tüm takipçilere iletir. ActivityPub Client-to-Server (C2S) protokolü.
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: username
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
 *               content:
 *                 type: string
 *                 maxLength: 5000
 *                 description: Note içeriği (HTML veya düz metin)
 *                 example: "Merhaba, federated dünya!"
 *               sensitive:
 *                 type: boolean
 *                 default: false
 *                 description: İçerik uyarısı gerekiyor mu?
 *               summary:
 *                 type: string
 *                 description: İçerik uyarısı açıklaması (sensitive=true ise)
 *               inReplyTo:
 *                 type: string
 *                 format: uri
 *                 description: Yanıtlanan Note'un AP ID'si
 *               visibility:
 *                 type: string
 *                 enum: [public, unlisted, followers]
 *                 default: public
 *     responses:
 *       201: { description: Note oluşturuldu ve takipçilere iletildi }
 *       400: { description: Geçersiz istek (içerik eksik veya çok uzun) }
 *       401: { description: Kimlik doğrulama gerekli }
 *       403: { description: Başka kullanıcı adına yayın yasak }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.post('/users/:username/outbox', activityPubJsonParser, authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  try {
  const callerId = castAuthed(req).user.id;

  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });

  // Sadece kendi adına yayın yapılabilir
  if (String(callerId) !== String(user._id)) {
    return res.status(403).json({ error: 'Cannot publish on behalf of another user' });
  }

  const body = isRecord(req.body) ? req.body : {};
  const content = body.content;
  const sensitive = body.sensitive ?? false;
  const summary = body.summary ?? null;
  const inReplyTo = body.inReplyTo ?? null;
  const visibility = body.visibility ?? 'public';

  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required and must be a string' });
  }
  if (content.length > 5000) {
    return res.status(400).json({ error: 'content exceeds maximum length of 5000 characters' });
  }
  if (typeof sensitive !== 'boolean') return res.status(400).json({ error: 'sensitive must be a boolean' });
  if (summary !== null && typeof summary !== 'string') return res.status(400).json({ error: 'summary must be a string or null' });
  if (inReplyTo !== null && typeof inReplyTo !== 'string') return res.status(400).json({ error: 'inReplyTo must be a string or null' });
  if (!['public', 'unlisted', 'followers'].includes(String(visibility))) {
    return res.status(400).json({ error: 'visibility must be public, unlisted, or followers' });
  }

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const noteId      = `${actorUrl}/notes/${uuidv4()}`;
  const createId    = `${actorUrl}/activities/${uuidv4()}`;
  const publishedAt = new Date().toISOString();

  // Görünürlüğe göre to/cc belirle
  const PUBLIC_STREAM = 'https://www.w3.org/ns/activitystreams#Public';
  let to: string[], cc: string[];
  if (visibility === 'public') {
    to = [PUBLIC_STREAM];
    cc = [`${actorUrl}/followers`];
  } else if (visibility === 'unlisted') {
    to = [`${actorUrl}/followers`];
    cc = [PUBLIC_STREAM];
  } else {
    // followers only
    to = [`${actorUrl}/followers`];
    cc = [];
  }

  const note = {
    '@context': AP_CONTEXT,
    id:           noteId,
    type:         'Note',
    attributedTo: actorUrl,
    content:      content.trim(),
    published:    publishedAt,
    to,
    cc,
    ...(sensitive  && { sensitive }),
    ...(summary    && { summary }),
    ...(inReplyTo  && { inReplyTo }),
  };

  const createActivity = {
    '@context': AP_CONTEXT,
    id:        createId,
    type:      'Create',
    actor:     actorUrl,
    published: publishedAt,
    to,
    cc,
    object:    note,
  };

  // Aktiviteyi DB'ye kaydet
  await Federation.insertActivity({
    _id:         uuidv4(),
    actorUserId: user._id,
    type:        'Create',
    activityId:  createId,
    noteId:      noteId,
    activity:    createActivity,
    publishedAt: Date.now(),
    createdAt:   Date.now(),
  });

  // Deliver the EXACT activity persisted above. The previous implementation
  // called deliverToFollowers(), which generated and persisted a SECOND Create
  // with a new id and always-public audience, corrupting C2S visibility and
  // doubling outbox counts. Delivery failures are reported as degraded while
  // the already-durable local publish remains successful.
  let delivery = { followers: 0, failed: 0 };
  try {
    delivery = await fanOutActivityToFollowers(user, createActivity);
  } catch (err) {
    logger.warn({ err, noteId, event: 'federation.outbox.fanout_lookup_failed' },
      'C2S activity persisted but follower fanout could not be enumerated.');
    delivery = { followers: 0, failed: 1 };
  }

  const infoLogger = logger as typeof logger & { info?: (objOrMsg?: unknown, msg?: string) => void };
  if (typeof infoLogger.info === 'function') {
    infoLogger.info({ noteId, actorUrl, visibility, event: 'federation.outbox.c2s_publish' }, 'C2S Note published to outbox.');
  }

  res.status(201).json({
    ok:       true,
    id:       createId,
    noteId,
    published: publishedAt,
    url:       noteId,
    delivery,
  });
  } catch (err) {
    const errorLogger = logger as typeof logger & { error?: (objOrMsg?: unknown, msg?: string) => void };
    if (typeof errorLogger.error === 'function') {
      errorLogger.error({ err, event: 'federation.outbox.c2s_error' }, 'C2S outbox publish failed.');
    }
    return res.status(500).json({ error: 'C2S outbox publish failed', detail: err instanceof Error ? err.message : 'Unknown error' });
  }
});


export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
