// @ts-nocheck
// server/routes/federation.js
// Farklı Bridge sunucuları arasında sunucu keşfi ve üyelik
// HTTP Signature implementasyonu → server/lib/httpSignature.js

const express      = require('express');
const router       = express.Router();
const { Users, Servers, Members, Channels, Federation } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const crypto       = require('crypto');
const { verifyHttpSignature, verifyFederationRequest } = require('../lib/httpSignature');
const { limits } = require('../middleware/rateLimit');
const { checkFederationACL } = require('./admin');
const logger = require('../lib/logger');

const PKG_VERSION = require('../../package.json').version;
const USER_AGENT  = `Bridge/${PKG_VERSION}`;

// ── GET /api/federation/info — Bu sunucunun genel bilgisi ──────
// Herhangi bir Bridge sunucusu bu endpoint'i sorgular
router.get('/info', (req, res) => {
  res.json({
    name:        process.env.INSTANCE_NAME    || 'Bridge Instance',
    description: process.env.INSTANCE_DESC   || 'A Bridge chat server',
    url:         process.env.INSTANCE_URL    || `http://localhost:${process.env.PORT || 3001}`,
    version:     PKG_VERSION,
    federation:  true,
    software:    'bridge',
  });
});

// ── GET /api/federation/servers — Paylaşılan sunucu listesi ────
// Keşfe açık sunucuları dış dünyaya sunar
router.get('/servers', asyncHandler(async (req, res) => {
  const servers = await Servers.find({ discoverable: 1 });
  const result  = await Promise.all(servers.map(async s => {
    const members  = await Members.findByServer(s._id);
    const channels = await Channels.findWhere({ serverId: s._id, type: 'text' });
    return {
      id:          s._id,
      name:        s.name,
      description: s.description || '',
      icon:        s.icon,
      tags:        s.tags || [],
      memberCount: members.length,
      channelCount: channels.length,
      inviteUrl:   `${process.env.INSTANCE_URL || 'http://localhost:3001'}/invite-server/${s._id}`,
    };
  }));
  res.json({ instance: process.env.INSTANCE_URL || 'http://localhost:3001', servers: result });
}));

// ── GET /api/federation/stats — Özet istatistik (auth gerektirmez) ──
// Sidebar widget ve profil popup için peer sayısı + federe kimlik bilgisi
router.get('/stats', asyncHandler(async (req, res) => {
  const peers = await Federation.findPeers();
  const verifiedPeers = peers.filter(p => p.verified);
  res.json({
    peerCount:         peers.length,
    verifiedPeerCount: verifiedPeers.length,
    instance:          process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`,
    instanceName:      process.env.INSTANCE_NAME || 'Bridge Instance',
    federation:        true,
  });
}));

// ── GET /api/federation/peers — Kayıtlı diğer Bridge sunucuları ─
router.get('/peers', authMiddleware, asyncHandler(async (req, res) => {
  const peers = await Federation.findPeers();
  res.json(peers.map(p => ({
    id:       p._id,
    url:      p.url,
    name:     p.name,
    addedAt:  p.addedAt,
    lastSeen: p.lastSeen,
    verified: p.verified,
  })));
}));

// ── POST /api/federation/peers — Admin yeni peer ekle ──────────
router.post('/peers', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  // Sadece admin kullanıcılar peer ekleyebilir
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  // Uzak sunucudan bilgi al
  let remoteInfo;
  try {
    const resp = await fetch(`${url.replace(/\/$/, '')}/api/federation/info`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) throw new Error('Remote server returned ' + resp.status);
    remoteInfo = await resp.json();
    if (remoteInfo.software !== 'bridge') throw new Error('Not a Bridge instance');
  } catch (e) {
    return res.status(400).json({ error: `Could not reach remote server: ${e.message}` });
  }

  const existing = await Federation.findPeerByUrl(remoteInfo.url || url);
  if (existing) return res.status(409).json({ error: 'Peer already added' });

  const { v4: uuidv4 } = require('uuid');
  const peer = {
    _id:      uuidv4(),
    url:      remoteInfo.url || url,
    name:     remoteInfo.name || url,
    desc:     remoteInfo.description || '',
    addedAt:  Date.now(),
    lastSeen: Date.now(),
    verified: true,
  };
  await Federation.insertPeer(peer);
  res.json({ ok: true, peer });
}));

// ── DELETE /api/federation/peers/:id — Peer kaldır ────────────
router.delete('/peers/:id', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  await Federation.removePeerById(req.params.id);
  res.json({ ok: true });
}));

// ── GET /api/federation/discover — Tüm peer'lardan sunucu topla ─
router.get('/discover', authMiddleware, asyncHandler(async (req, res) => {
  const { q = '', tag = '' } = req.query;
  const peers = await Federation.findPeers();

  // Tüm peer'lardan paralel olarak sunucuları çek
  const results = await Promise.allSettled(
    peers.map(async peer => {
      try {
        const resp = await fetch(`${peer.url.replace(/\/$/, '')}/api/federation/servers`, {
          signal: AbortSignal.timeout(6000),
          headers: { 'User-Agent': USER_AGENT },
        });
        if (!resp.ok) return [];
        const data = await resp.json();
        // Her sunucuya kaynak instance URL'ini ekle
        return (data.servers || []).map(s => ({
          ...s,
          _instanceUrl:  peer.url,
          _instanceName: peer.name,
          _remote: true,
        }));
      } catch {
        // Peer'a ulaşılamazsa boş döndür
        return [];
      }
    })
  );

  let allServers = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // Filtrele
  if (q) {
    const lq = q.toLowerCase();
    allServers = allServers.filter(s =>
      s.name?.toLowerCase().includes(lq) ||
      s.description?.toLowerCase().includes(lq) ||
      (s.tags || []).some(t => t.toLowerCase().includes(lq))
    );
  }
  if (tag) {
    allServers = allServers.filter(s =>
      (s.tags || []).some(t => t.toLowerCase() === tag.toLowerCase())
    );
  }

  // Üye sayısına göre sırala
  allServers.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));

  res.json({ count: allServers.length, servers: allServers.slice(0, 100) });
}));


// ── POST /api/federation/ping — Başka bir Bridge sunucusundan ping gelir ──
// Peer'ın hala aktif olduğunu bildirir, lastSeen günceller
router.post('/ping', asyncHandler(async (req, res) => {
  if (!verifyFederationRequest(req)) {
    return res.status(401).json({ error: 'Invalid federation signature' });
  }
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  await Federation.updatePeersWhere(
    { url },
    { $set: { lastSeen: Date.now(), verified: true } }
  );
  res.json({ ok: true, ts: Date.now() });
}));

// ── GET /api/federation/health — Tüm peer'ların durumunu döndür ─
router.get('/health', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const peers = await Federation.findPeers();
  const now   = Date.now();
  const STALE_MS = 10 * 60 * 1000; // 10 dakika

  const result = peers.map(p => ({
    id:       p._id,
    url:      p.url,
    name:     p.name,
    lastSeen: p.lastSeen,
    online:   p.lastSeen && (now - p.lastSeen) < STALE_MS,
    ageMins:  p.lastSeen ? Math.floor((now - p.lastSeen) / 60000) : null,
  }));

  res.json({ peers: result, total: result.length, online: result.filter(p => p.online).length });
}));

// ── POST /api/federation/join-remote — Uzak bir sunucuya katılma isteği ─
// Kullanıcı, başka bir Bridge instance'ındaki sunucuya katılmak ister
router.post('/join-remote', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const { instanceUrl, serverId, inviteCode } = req.body;
  if (!instanceUrl || !serverId) return res.status(400).json({ error: 'instanceUrl and serverId required' });

  // O instance'dan sunucu bilgisi çek
  try {
    const resp = await fetch(
      `${instanceUrl.replace(/\/$/, '')}/api/federation/servers`,
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Bridge/28' } }
    );
    if (!resp.ok) throw new Error('Remote unreachable');
    const data = await resp.json();
    const server = (data.servers || []).find(s => s.id === serverId);
    if (!server) return res.status(404).json({ error: 'Server not found on remote instance' });

    // Sonucu döndür — client invite URL'e yönlendirir
    res.json({
      ok:        true,
      server,
      inviteUrl: server.inviteUrl || `${instanceUrl}/invite-server/${serverId}`,
      message:   'Visit inviteUrl to join this server',
    });
  } catch (e) {
    res.status(502).json({ error: `Remote instance error: ${e.message}` });
  }
}));

// ══════════════════════════════════════════════════
// ACTIVITYPUB UYUMLULUĞU
// ══════════════════════════════════════════════════
const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

// GET /.well-known/webfinger?resource=acct:user@domain
// Bu endpoint server/index.js'de ayrıca mount edilmeli
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
      rel: 'self',
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
      type: 'Image',
      mediaType: 'image/jpeg',
      url: user.avatarUrl,
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

  // HTTP Signature doğrulama — imzasız veya geçersiz imzalı istekleri reddet
  const sigResult = await verifyHttpSignature(req);
  if (!sigResult.ok) {
    // Geliştirme ortamında imza yoksa geç; production'da reddet
    if (process.env.NODE_ENV === 'production' || req.headers['signature']) {
      logger.warn({ reason: sigResult.reason, event: 'federation.inbox.signature_rejected' }, 'HTTP signature rejected for inbox request.');
      return res.status(401).json({ error: 'Invalid HTTP Signature', detail: sigResult.reason });
    }
    logger.warn({ reason: sigResult.reason, event: 'federation.inbox.signature_missing_dev' }, 'HTTP signature missing in development mode; request allowed.');
  }

  const activity = req.body;
  if (!activity?.type) return res.status(400).json({ error: 'Invalid activity' });

//   Federation ACL — blacklist/whitelist kontrolü
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

  // Store raw activity for processing
  await Federation.insertActivity({
    _id: require('uuid').v4(),
    targetUserId: user._id,
    activity,
    processed: false,
    createdAt: Date.now(),
  });

  // Process common activity types
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
      // Remote server accepted our Follow request
      if (activity.object?.type === 'Follow' || typeof activity.object === 'string') {
        await handleApAccept(user, activity);
      }
      break;
    case 'Reject':
      // Remote server rejected our Follow request — remove pending follow
      if (activity.object?.type === 'Follow' || typeof activity.object === 'string') {
        await handleApReject(user, activity);
      }
      break;
  }

  res.status(202).json({ ok: true });
}));

// GET /api/federation/users/:username/outbox — ActivityPub Outbox
// ?page=true  → OrderedCollectionPage (paginated, 20/page)
// ?page=true&min_id=<ts>  → next page cursor
router.get('/users/:username/outbox', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const outboxUrl   = `${actorUrl}/outbox`;

  res.set('Content-Type', 'application/activity+json');

  // ?page=true → gerçek sayfa döndür
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

  // Root OrderedCollection (total count + first page link)
  const total = await Federation.countActivities({ actorUserId: user._id, type: 'Create' });

  return res.json({
    '@context':  AP_CONTEXT,
    id:          outboxUrl,
    type:        'OrderedCollection',
    totalItems:  total || 0,
    first:       `${outboxUrl}?page=true`,
    last:        `${outboxUrl}?page=true&min_id=0`,
  });
}));

// ── Outbox Delivery: kullanıcı mesaj attığında follower'lara ilet ──────────────────
async function deliverToFollowers(fromUser, noteContent, noteId) {
  try {
    const { v4: uuidv4 } = require('uuid');
    const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const actorUrl    = `${instanceUrl}/api/federation/users/${fromUser.username}`;
    const publishedAt = Date.now();

    const noteApId  = noteId || `${actorUrl}/notes/${uuidv4()}`;
    const createId  = `${actorUrl}/activities/${uuidv4()}`;

    const note = {
      '@context': AP_CONTEXT,
      id:         noteApId,
      type:       'Note',
      attributedTo: actorUrl,
      content:    noteContent,
      published:  new Date(publishedAt).toISOString(),
      to:         ['https://www.w3.org/ns/activitystreams#Public'],
      cc:         [`${actorUrl}/followers`],
    };

    const createActivity = {
      '@context': AP_CONTEXT,
      id:         createId,
      type:       'Create',
      actor:      actorUrl,
      published:  new Date(publishedAt).toISOString(),
      to:         note.to,
      cc:         note.cc,
      object:     note,
    };

    // ap_activities'e kaydet (outbox için)
    await Federation.insertActivity({
      _id:         uuidv4(),
      actorUserId: fromUser._id,
      type:        'Create',
      activityId:  createId,
      noteId:      noteApId,
      activity:    createActivity,
      publishedAt,
    });

    // follower'ları bul ve her birine ilet
    const follows = await Federation.findApFollows({ targetUserId: fromUser._id }) || [];
    const followArr = Array.isArray(follows) ? follows : await follows;
    if (!followArr.length) return;

    await Promise.allSettled(
      followArr.map(f => deliverApActivity(f.actorUrl, createActivity, fromUser))
    );
  } catch (err) {
    logger.warn({ err, event: 'federation.outbox.deliver_failed' }, 'Failed to deliver outbox activity.');
  }
}


async function handleApFollow(targetUser, activity) {
  try {
    const { v4: uuidv4 } = require('uuid');
    await Federation.insertApFollow({
      _id: uuidv4(),
      actorUrl: activity.actor,
      targetUserId: targetUser._id,
      activityId: activity.id,
      createdAt: Date.now(),
    });

    // Send Accept activity back
    const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
    const accept = {
      '@context': AP_CONTEXT,
      id:     `${instanceUrl}/api/federation/activities/${Date.now()}`,
      type:   'Accept',
      actor:  `${instanceUrl}/api/federation/users/${targetUser.username}`,
      object: activity,
    };
    await deliverApActivity(activity.actor, accept, targetUser);
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.handle_failed' }, 'Failed to process Follow activity.');
  }
}

async function handleApUnfollow(targetUser, activity) {
  const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
  await Federation.removeApFollow({ actorUrl, targetUserId: targetUser._id }, {});
}

// handleApAccept — uzak sunucu Follow'umuzu kabul etti
async function handleApAccept(localUser, activity) {
  try {
    // activity.object is either the original Follow activity or its id string
    const followId = typeof activity.object === 'string'
      ? activity.object
      : activity.object?.id;
    const remoteActorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

    // ap_follows schema: actorUrl (uzak takipçi) + targetUserId (yerel kullanıcı)
    // Biz uzak aktörü takip ettiğimizde kayıt: actorUrl=bizim URL, targetUserId=??? yok.
    // Giden Follow'lar için ayrı bir tablo (ap_outgoing_follows) yoksa, apActivities'te
    // activityId üzerinden eşleştir.
    await Federation.updateApFollow(
      { actorUrl: remoteActorUrl, targetUserId: localUser._id },
      { $set: { accepted: true, acceptedAt: Date.now() } }
    );

    logger.info({ localUser: localUser.username, remoteActor: remoteActorUrl, event: 'federation.follow.accepted' }, 'Remote Follow request accepted.');
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.accept_handle_failed' }, 'Failed to process Accept activity.');
  }
}

// handleApReject — uzak sunucu Follow'umuzu reddetti
async function handleApReject(localUser, activity) {
  try {
    const remoteActorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;

    // ap_follows schema: actorUrl + targetUserId — actorUserId/targetActorUrl yok
    await Federation.removeApFollow(
      { actorUrl: remoteActorUrl, targetUserId: localUser._id },
      {}
    );

    logger.info({ localUser: localUser.username, remoteActor: remoteActorUrl, event: 'federation.follow.rejected' }, 'Remote Follow request rejected.');
  } catch (err) {
    logger.warn({ err, event: 'federation.follow.reject_handle_failed' }, 'Failed to process Reject activity.');
  }
}

async function handleApDelete(targetUser, activity) {
  try {
    // activity.object mesajın AP ID'si (string) veya { id, type } objesi olabilir
    const objectId = typeof activity.object === 'string'
      ? activity.object
      : activity.object?.id;

    if (!objectId) return;

    // Sadece actor'ın kendi mesajlarını silebileceğini doğrula
    const actorUrl = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id;
    await Federation.removeApMessage({ apId: objectId, actorUrl }, {});
    logger.info({ objectId, event: 'federation.note.deleted' }, 'Federated note deleted.');
  } catch (err) {
    logger.warn({ err, event: 'federation.note.delete_handle_failed' }, 'Failed to process Delete activity.');
  }
}

async function handleApCreate(targetUser, activity) {
  try {
    const obj = activity.object;
    if (!obj || obj.type !== 'Note') return; // Sadece Note aktivitelerini işle

    const { v4: uuidv4 } = require('uuid');
    const fedMsg = {
      _id:          uuidv4(),
      apId:         obj.id,                        // Uzak ActivityPub ID (silme için gerekli)
      actorUrl:     typeof activity.actor === 'string' ? activity.actor : activity.actor?.id,
      targetUserId: targetUser._id,
      content:      obj.content || obj.name || '',
      summary:      obj.summary || null,           // Content Warning (Mastodon)
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

// ── signRequest: Per-User HTTP Signature ─────────────────────────────────────
// Her kullanıcının kendi RSA anahtarıyla imzalar.
// keyId = actor URL + "#main-key" (Mastodon standardı)
async function signRequest(method, url, body, privateKeyPem, actorUsername) {
  try {
    const { createSign, createHash } = require('crypto');
    const parsed      = new URL(url);
    const date        = new Date().toUTCString();
    const bodyStr     = typeof body === 'string' ? body : JSON.stringify(body);
    const digest      = 'SHA-256=' + createHash('sha256').update(bodyStr).digest('base64');
    const target      = `${method.toLowerCase()} ${parsed.pathname}${parsed.search}`;
    const sigStr      = `(request-target): ${target}\nhost: ${parsed.host}\ndate: ${date}\ndigest: ${digest}`;

    const sign = createSign('RSA-SHA256');
    sign.update(sigStr);
    const signature = sign.sign(privateKeyPem, 'base64');

    // Per-user keyId — "system" yerine gerçek kullanıcı URL'i
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

async function deliverApActivity(inboxUrl, activity, fromUser) {
  // Extract inbox URL from actor if it's an actor URL
  let targetInbox = inboxUrl;
  if (!inboxUrl.endsWith('/inbox')) {
    try {
      const fetch = globalThis.fetch;
      const r = await fetch(inboxUrl, { headers: { 'Accept': 'application/activity+json' } });
      const actor = await r.json();
      targetInbox = actor.inbox;
    } catch { return; }
  }

  const fetch  = globalThis.fetch;
  const body   = JSON.stringify(activity);

  // HTTP Signatures — kullanıcının AP private key'i varsa imzala
  const privateKey = fromUser?.apPrivateKey;
  const sigHeaders = privateKey ? await signRequest('POST', targetInbox, body, privateKey, fromUser?.username) : null;

  const headers = {
    'Content-Type': 'application/activity+json',
    'Accept':       'application/activity+json',
    'Date':         sigHeaders?.date || new Date().toUTCString(),
  };
  if (sigHeaders) {
    headers['Digest']    = sigHeaders.digest;
    headers['Signature'] = sigHeaders.signature;
  }

  try {
    const resp = await fetch(targetInbox, { method: 'POST', headers, body });
    if (!resp.ok) {
      logger.warn({ status: resp.status, targetInbox, event: 'federation.delivery.non_2xx' }, 'Federated delivery received non-2xx response.');
    }
  } catch (err) {
    logger.warn({ err, targetInbox, event: 'federation.delivery.failed' }, 'Federated delivery failed.');
  }
}

// GET /api/federation/users/:username/followers — ActivityPub Followers Collection
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

// GET /api/federation/users/:username/following — ActivityPub Following Collection
router.get('/users/:username/following', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;

  // Bridge kullanıcıları şu an dışarıdan takip etmiyor; boş koleksiyon döndür
  res.set('Content-Type', 'application/activity+json');
  res.json({
    '@context':   AP_CONTEXT,
    id:           `${actorUrl}/following`,
    type:         'OrderedCollection',
    totalItems:   0,
    orderedItems: [],
  });
}));

// GET /api/federation/users/:username/notes/:noteId — Tekil Note endpoint
router.get('/users/:username/notes/:noteId', asyncHandler(async (req, res) => {
  const user = await Users.findByUsername(req.params.username);
  if (!user) return res.status(404).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl    = `${instanceUrl}/api/federation/users/${user.username}`;
  const noteApId    = `${actorUrl}/notes/${req.params.noteId}`;

  // ap_activities içinde bu note ID'yi ara
  const activities = await Federation.apActivitiesFind({ actorUserId: user._id, type: 'Create' }) || [];
  const arr = Array.isArray(activities) ? activities : await activities;
  const match = arr.find(a => a.activity?.object?.id === noteApId);

  if (!match) return res.status(404).json({ error: 'Note not found' });

  res.set('Content-Type', 'application/activity+json');
  res.json(match.activity.object);
}));

module.exports = router;
module.exports.deliverToFollowers = deliverToFollowers;

// ── GET /api/federation/fetch-remote — CORS proxy ──────────────
// Client'ın doğrudan uzak sunucuya erişememesi durumunda proxy görevi görür
router.get('/fetch-remote', authMiddleware, asyncHandler(async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url gerekli' });

  // Sadece güvenli URL'lere izin ver
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return res.status(400).json({ error: 'Only http/https URLs are supported' });
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': `Bridge/${require('../../package.json').version}` },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!r.ok) return res.status(502).json({ error: `Remote server returned ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Could not reach remote server: ${err.message}` });
  }
}));
export {};
