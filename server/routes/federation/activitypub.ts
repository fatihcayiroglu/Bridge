// @ts-nocheck
// server/routes/federation/activitypub.js
// ActivityPub actor endpoints, inbox, outbox, followers/following, webfinger

'use strict';

const express      = require('express');
const router       = express.Router();
const { Users, Federation } = require('../../db/repositories');
const asyncHandler = require('../../middleware/asyncHandler');
const { verifyHttpSignature } = require('../../lib/httpSignature');
const logger       = require('../../lib/logger');
const { checkFederationACL } = require('../admin');
const {
  handleApFollow, handleApUnfollow, handleApAccept,
  handleApReject, handleApCreate, handleApDelete,
  deliverApActivity,
} = require('./helpers');

const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

// GET /.well-known/webfinger?resource=acct:user@domain
router.get('/webfinger', asyncHandler(async (req, res) => {
  const resource = String(req.query.resource ?? '');
  if (!resource?.startsWith('acct:')) return res.status(400).json({ error: 'Invalid resource' });

  const [localPart] = resource.slice(5).split('@');
  const user = await Users.findByUsername(localPart);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  res.set('Content-Type', 'application/jrd+json');
  res.json({
    subject: resource,
    links: [{
      rel:  'self',
      type: 'application/activity+json',
      href: `${instanceUrl}/api/federation/users/${user.username}`,
    }],
  });
}));

// GET /api/federation/users/:username — ActivityPub Actor
router.get('/users/:username', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
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
}));

// POST /api/federation/users/:username/inbox — ActivityPub Inbox
router.post('/users/:username/inbox', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
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

  await Federation.insertActivity({
    _id: require('uuid').v4(),
    targetUserId: user._id,
    activity,
    processed: false,
    createdAt: Date.now(),
  });

  switch (activity.type) {
    case 'Follow':
      await handleApFollow(user, activity);
      break;
    case 'Undo':
      if (activity.object?.type === 'Follow') await handleApUnfollow(user, activity);
      break;
    case 'Create':
      await handleApCreate(user, activity);
      break;
    case 'Delete':
      await handleApDelete(user, activity);
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

  res.status(202).json({ ok: true });
}));

// GET /api/federation/users/:username/outbox
router.get('/users/:username/outbox', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const outboxUrl   = `${actorUrl}/outbox`;

  res.set('Content-Type', 'application/activity+json');

  if (req.query.page === 'true') {
    const PAGE_SIZE = 20;
    const minId     = parseInt(String(req.query.min_id ?? ''), 10) || 0;

    const q = { actorUserId: user._id, type: 'Create' };
    if (minId) q.publishedAt = { $gt: minId };

    let items = await Federation.apActivitiesFind(q).sort({ publishedAt: -1 }).limit(PAGE_SIZE);
    if (!Array.isArray(items)) items = [];

    const page = {
      '@context':   AP_CONTEXT,
      id:           `${outboxUrl}?page=true${minId ? `&min_id=${minId}` : ''}`,
      type:         'OrderedCollectionPage',
      partOf:       outboxUrl,
      orderedItems: items.map(a => a.activity),
    };

    if (items.length === PAGE_SIZE) {
      const oldest = items[items.length - 1].publishedAt;
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
}));

// GET /api/federation/users/:username/followers
router.get('/users/:username/followers', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
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
}));

// GET /api/federation/users/:username/following
router.get('/users/:username/following', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;

  res.set('Content-Type', 'application/activity+json');
  res.json({
    '@context':   AP_CONTEXT,
    id:           `${actorUrl}/following`,
    type:         'OrderedCollection',
    totalItems:   0,
    orderedItems: [],
  });
}));

// GET /api/federation/users/:username/notes/:noteId
router.get('/users/:username/notes/:noteId', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const noteApId    = `${actorUrl}/notes/${req.params.noteId}`;

  const activities = await Federation.apActivitiesFind({ actorUserId: user._id, type: 'Create' }) || [];
  const arr = Array.isArray(activities) ? activities : await activities;
  const match = arr.find(a => a.activity?.object?.id === noteApId);

  if (!match) return res.status(404).json({ error: 'Note not found' });

  res.set('Content-Type', 'application/activity+json');
  res.json(match.activity.object);
}));

module.exports = router;
export {};
