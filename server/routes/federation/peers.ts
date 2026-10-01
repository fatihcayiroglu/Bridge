// server/routes/federation/peers.ts
// Bridge sunucu keşfi, peer yönetimi ve federation sağlık kontrolü

import express from 'express';
import logger from '../../lib/logger';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router       = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { Users, Servers, Members, Channels, Federation } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { fetchT } from '../../lib/fetch';
// Sprint 109: verifyFederationRequest (httpSignature) tamamen kaldırıldı; tüm rotalar federationAuth middleware'ini kullanıyor.
import { federationAuth, federationAuthRsaRequired } from '../../middleware/federationAuth';
import { getOrCreateFederationKeys, getFederationPublicKeyDoc } from '../../lib/federationKeys';
import { normalizePeerBaseUrl } from '../../lib/httpSignatureV3';
import pkg from '../../../package.json';
const PKG_VERSION: string = (pkg as { version: string }).version;
const USER_AGENT  = `Bridge/${PKG_VERSION}`;


function signedPeerMatches(req: import('express').Request, candidate: unknown): boolean {
  const signed = normalizePeerBaseUrl(req.federationPeerUrl);
  const target = normalizePeerBaseUrl(candidate);
  return Boolean(signed && target && signed === target);
}

/**
 * @openapi
 * /federation/info:
 *   get:
 *     tags: [Federation]
 *     summary: Bu sunucunun genel bilgisi
 *     security: []
 *     responses:
 *       200:
 *         description: Instance metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 name:        { type: string }
 *                 description: { type: string }
 *                 url:         { type: string }
 *                 version:     { type: string }
 *                 federation:  { type: boolean }
 *                 software:    { type: string }
 * /federation/peers:
 *   get:
 *     tags: [Federation]
 *     summary: Kayıtlı peer listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Peer listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 peers: { type: array, items: { type: object, properties: { id: { type: string }, url: { type: string } } } }
 *   post:
 *     tags: [Federation]
 *     summary: Yeni peer ekle (sadece admin)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url: { type: string, format: uri, example: 'https://other.bridge.instance' }
 *     responses:
 *       200: { description: Peer eklendi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /federation/peers/{id}:
 *   delete:
 *     tags: [Federation]
 *     summary: Peer sil (sadece admin)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Peer silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /federation/servers:
 *   get:
 *     tags: [Federation]
 *     summary: Federe sunucu listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Sunucu listesi }
 * /federation/stats:
 *   get:
 *     tags: [Federation]
 *     summary: Federasyon istatistikleri
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Kullanıcı/sunucu/mesaj sayıları }
 * /federation/discover:
 *   get:
 *     tags: [Federation]
 *     summary: Federe içerik keşfi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *     responses:
 *       200: { description: Keşif sonuçları }
 * /federation/fetch-remote:
 *   get:
 *     tags: [Federation]
 *     summary: Uzak ActivityPub nesnesini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema: { type: string, format: uri }
 *     responses:
 *       200: { description: ActivityPub nesnesi }
 * /federation/ping:
 *   post:
 *     tags: [Federation]
 *     summary: Peer'e ping gonder (saglik kontrolu)
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [url]
 *             properties:
 *               url: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Pong
 * /federation/health:
 *   get:
 *     tags: [Federation]
 *     summary: Federation alt sistemi saglik durumu
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Saglik durumu
 * /federation/join-remote:
 *   post:
 *     tags: [Federation]
 *     summary: Uzak sunucuya katil
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [serverUrl, inviteCode]
 *             properties:
 *               serverUrl:  { type: string, format: uri }
 *               inviteCode: { type: string }
 *     responses:
 *       200:
 *         description: Katilindi
 */
// ── GET /api/federation/info — Bu sunucunun genel bilgisi ──────
router.get('/info', async (req: import("express").Request, res: import("express").Response) => {
  const keys = await getOrCreateFederationKeys();
  res.json({
    name:        process.env.INSTANCE_NAME    || 'Bridge Instance',
    description: process.env.INSTANCE_DESC   || 'A Bridge chat server',
    url:         process.env.INSTANCE_URL    || `http://localhost:${process.env.PORT || 3001}`,
    version:     PKG_VERSION,
    federation:  true,
    software:    'bridge',
    publicKey:   getFederationPublicKeyDoc(keys),
  });
});

// ── GET /api/federation/key — Instance RSA public key (ADR-0006) ─
router.get('/key', async (req: import("express").Request, res: import("express").Response) => {
  const keys = await getOrCreateFederationKeys();
  res.json({ publicKey: getFederationPublicKeyDoc(keys) });
});

// ── GET /api/federation/servers — Keşfe açık sunucular ────────
router.get('/servers', async (req: import("express").Request, res: import("express").Response) => {
  const servers = await Servers.find({ discoverable: 1 });
  const result  = await Promise.all(servers.map(async s => {
    const members  = await Members.findByServer(s._id);
    const channels = await Channels.findWhere({ serverId: s._id, type: 'text' });
    return {
      id:           s._id,
      name:         s.name,
      description:  s.description || '',
      icon:         s.icon,
      tags:         s.tags || [],
      memberCount:  members.length,
      channelCount: channels.length,
      inviteUrl:    `${process.env.INSTANCE_URL || 'http://localhost:3001'}/invite-server/${s._id}`,
    };
  }));
  res.json({ instance: process.env.INSTANCE_URL || 'http://localhost:3001', servers: result });
});

// ── GET /api/federation/stats ──────────────────────────────────
router.get('/stats', async (req: import("express").Request, res: import("express").Response) => {
  const peers = await Federation.findPeers();
  const verifiedPeers = peers.filter(p => p.verified);
  const userCount = await Users.count({});
  const serverCount = await Servers.count({});
  res.json({
    peerCount:         peers.length,
    verifiedPeerCount: verifiedPeers.length,
    userCount,
    serverCount,
    instance:          process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`,
    instanceName:      process.env.INSTANCE_NAME || 'Bridge Instance',
    federation:        true,
  });
});

// ── GET /api/federation/peers ──────────────────────────────────
router.get('/peers', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const peers = await Federation.findPeers();
  res.json(peers.map(p => ({
    id:       p._id,
    url:      p.url,
    name:     p.name,
    addedAt:  p.addedAt,
    lastSeen: p.lastSeen,
    verified: p.verified,
  })));
});

// ── POST /api/federation/peers — Admin yeni peer ekle ─────────
router.post('/peers', authMiddleware, limits.federation(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { url } = req.body as Record<string, string>;
  if (!url) return res.status(400).json({ error: 'url required' });

  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  type RemoteFederationInfo = {
    software?: string;
    url?: string;
    name?: string;
    description?: string;
    publicKey?: { publicKeyPem?: string };
  };

  // P5 FED-04: the URL the admin typed is the identity. Production peers are
  // HTTPS-only (the key below is fetched over this channel).
  const requested = normalizePeerBaseUrl(url);
  if (!requested) return res.status(400).json({ error: 'Invalid peer url' });
  if (process.env.NODE_ENV === 'production' && !requested.startsWith('https://')) {
    return res.status(400).json({ error: 'Peer url must be https' });
  }

  let remoteInfo: RemoteFederationInfo;
  try {
    const resp = await fetchT(`${requested}/api/federation/info`, {
      timeoutMs: 8000,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!resp.ok) throw new Error('Remote server returned ' + resp.status);
    remoteInfo = await resp.json() as RemoteFederationInfo;
    if (remoteInfo.software !== 'bridge') throw new Error('Not a Bridge instance');
  } catch (_e) { const e = _e as Error;
    return res.status(400).json({ error: `Could not reach remote server: ${e.message}` });
  }

  // P5 FED-04: the remote's self-declared url used to be stored as the peer's
  // identity. Registering https://evil.example whose /info said
  // "url": "https://trusted.example" stored evil's key under trusted's name —
  // and evil could then sign instance-peer requests AS trusted. The declared
  // url must be the one that was contacted.
  const declared = normalizePeerBaseUrl(remoteInfo.url ?? requested);
  if (declared !== requested) {
    return res.status(400).json({
      error: 'Remote instance declares a different url than the one contacted',
      requested, declared: remoteInfo.url ?? null,
    });
  }
  const publicKeyPem = remoteInfo.publicKey?.publicKeyPem;
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    return res.status(400).json({ error: 'Remote instance did not publish an RSA public key' });
  }

  const existing = await Federation.findPeerByUrl(requested);
  if (existing) return res.status(409).json({ error: 'Peer already added' });

  const peer = {
    _id:      uuidv4(),
    url:      requested,
    name:     remoteInfo.name || requested,
    desc:     remoteInfo.description || '',
    addedAt:  Date.now(),
    lastSeen: Date.now(),
    verified: true,
    publicKey: publicKeyPem,
  };
  await Federation.insertPeer(peer);
  res.json({ ok: true, peer });
});

// ── DELETE /api/federation/peers/:id ──────────────────────────
router.delete('/peers/:id', authMiddleware, limits.federation(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });
  await Federation.removePeerById(String(req.params.id ?? ''));
  res.json({ ok: true });
});

// ── GET /api/federation/discover ──────────────────────────────
router.get('/discover', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
  const peers = await Federation.findPeers();

  const results = await Promise.allSettled(
    peers.map(async peer => {
      if (typeof peer.url !== 'string' || peer.url.length === 0) return [];
      const peerUrl = peer.url;
      try {
        const resp = await fetchT(`${peerUrl.replace(/\/$/, '')}/api/federation/servers`, {
          timeoutMs: 6000,
          headers: { 'User-Agent': USER_AGENT },
        });
        if (!resp.ok) return [];
        const data = await resp.json() as { servers?: Array<Record<string, unknown> & { name?: string; description?: string; tags?: string[]; memberCount?: number; id?: string; inviteUrl?: string }> };
        return (data.servers || []).map((s) => ({
          ...s,
          _instanceUrl:  peerUrl,
          _instanceName: peer.name,
          _remote: true,
        }));
      } catch {
        return [];
      }
    })
  );

  let allServers = results
    .flatMap(r => r.status === 'fulfilled' ? r.value : []);

  if (q) {
    const lq = q.toLowerCase();
    allServers = allServers.filter(s =>
      s.name?.toLowerCase().includes(lq) ||
      s.description?.toLowerCase().includes(lq) ||
      (s.tags || []).some((t: string) => t.toLowerCase().includes(lq))
    );
  }
  if (tag) {
    allServers = allServers.filter(s =>
      (s.tags || []).some((t: string) => t.toLowerCase() === tag.toLowerCase())
    );
  }

  allServers.sort((a, b) => (b.memberCount || 0) - (a.memberCount || 0));
  res.json({ count: allServers.length, servers: allServers.slice(0, 100) });
});

// ── POST /api/federation/key-update — Peer yeni public key duyurusu (ADR-0006 Faz 2) ──
router.post('/key-update', limits.federation(), federationAuthRsaRequired, async (req: import("express").Request, res: import("express").Response) => {

  const { instanceUrl, url, publicKey } = req.body as {
    instanceUrl?: string;
    url?:          string;
    publicKey?:    { id?: string; owner?: string; publicKeyPem?: string };
  };

  const bodyPeerUrl = url || instanceUrl || '';
  const normalized = normalizePeerBaseUrl(bodyPeerUrl);
  if (!normalized || !publicKey?.publicKeyPem) {
    return res.status(400).json({ error: 'url (or instanceUrl) and publicKey.publicKeyPem required' });
  }
  if (!signedPeerMatches(req, normalized)) {
    return res.status(403).json({ error: 'Signed peer identity does not match key-update target' });
  }
  if (!publicKey.publicKeyPem.includes('BEGIN PUBLIC KEY')) {
    return res.status(400).json({ error: 'Invalid publicKeyPem' });
  }

  const authenticatedPeerId = req.federationPeerId;
  if (authenticatedPeerId === undefined || authenticatedPeerId === null) {
    return res.status(401).json({ error: 'Authenticated federation peer identity missing' });
  }

  // P5 FED-10 — measured in the two-instance lab: this also wrote a
  // "keyUpdated" column that federation_peers does not have, so every key
  // announcement answered 500 and no peer could ever learn a rotated key.
  // The rotation is recorded in the log instead (no schema change needed).
  await Federation.updatePeer(String(authenticatedPeerId), {
    $set: {
      publicKey:  publicKey.publicKeyPem,
      lastSeen:   Date.now(),
      verified:   true,
    },
  });
  logger.info({ event: 'federation.peer.key_updated', peerId: String(authenticatedPeerId), peer: normalized },
    '[Federation] Peer announced a rotated key; stored.');

  res.json({ ok: true, peerId: String(authenticatedPeerId), instanceUrl: normalized });
});

// ── POST /api/federation/ping ──────────────────────────────────
router.post('/ping', limits.federation(), federationAuth, async (req: import("express").Request, res: import("express").Response) => {
  const { url } = req.body as Record<string, string>;
  const signedPeerUrl = normalizePeerBaseUrl(req.federationPeerUrl);
  if (!url || !signedPeerUrl) return res.status(400).json({ error: 'url required' });
  if (!signedPeerMatches(req, url)) {
    return res.status(403).json({ error: 'Signed peer identity does not match ping target' });
  }

  // Never trust the body as the mutation authority. The middleware has already
  // cryptographically authenticated federationPeerUrl against the registered
  // peer key; use that canonical identity for the write.
  const authenticatedPeerId = req.federationPeerId;
  if (authenticatedPeerId === undefined || authenticatedPeerId === null) {
    return res.status(401).json({ error: 'Authenticated federation peer identity missing' });
  }
  await Federation.updatePeer(
    String(authenticatedPeerId),
    { $set: { lastSeen: Date.now(), verified: true } }
  );
  res.json({ ok: true, ts: Date.now() });
});

// ── GET /api/federation/health ─────────────────────────────────
router.get('/health', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const peers = await Federation.findPeers();
  const now   = Date.now();
  const STALE_MS = 10 * 60 * 1000;

  const result = peers.map(p => ({
    id:       p._id,
    url:      p.url,
    name:     p.name,
    lastSeen: p.lastSeen,
    online:   p.lastSeen && (now - p.lastSeen) < STALE_MS,
    ageMins:  p.lastSeen ? Math.floor((now - p.lastSeen) / 60000) : null,
  }));

  res.json({ peers: result, total: result.length, online: result.filter(p => p.online).length });
});

// ── POST /api/federation/join-remote ──────────────────────────
router.post('/join-remote', authMiddleware, limits.federation(), async (req: import("express").Request, res: import("express").Response) => {
  const { instanceUrl, serverId } = req.body as Record<string, string>;
  if (!instanceUrl || !serverId) return res.status(400).json({ error: 'instanceUrl and serverId required' });

  try {
    const resp = await fetchT(
      `${instanceUrl.replace(/\/$/, '')}/api/federation/servers`,
      { timeoutMs: 8000, headers: { 'User-Agent': USER_AGENT } }
    );
    if (!resp.ok) throw new Error('Remote unreachable');
    const data = await resp.json() as { servers?: Array<Record<string, unknown> & { id?: string; inviteUrl?: string }> };
    const server = (data.servers || []).find((s) => s.id === serverId);
    if (!server) return res.status(404).json({ error: 'Server not found on remote instance' });

    res.json({
      ok:        true,
      server,
      inviteUrl: server.inviteUrl || `${instanceUrl}/invite-server/${serverId}`,
      message:   'Visit inviteUrl to join this server',
    });
  } catch (_e) { const e = _e as Error;
    res.status(502).json({ error: `Remote instance error: ${e.message}` });
  }
});

// ── GET /api/federation/fetch-remote — CORS proxy ─────────────
router.get('/fetch-remote', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const url = typeof req.query.url === 'string' ? req.query.url : '';
  if (!url) return res.status(400).json({ error: 'url gerekli' });

  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!url.startsWith('https://') && !url.startsWith('http://')) {
    return res.status(400).json({ error: 'Only http/https URLs are supported' });
  }

  try {
    const r = await fetchT(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': USER_AGENT },
      timeoutMs: 8000,
    });
    if (!r.ok) return res.status(502).json({ error: `Remote server returned ${r.status}` });
    const data = await r.json();
    res.json(data);
  } catch (_err) { const err = _err as Error;
    res.status(502).json({ error: `Could not reach remote server: ${err.message}` });
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
