// server/routes/servers/core.ts — Server CRUD routes
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router = express.Router();

import { Users, Servers, Members, Auth, Channels, Roles, ChannelPermissions } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { sanitizeUser } from '../../lib/userUtils';
import { getMemberPerms, hasPermission, PERMS } from '../roles';
import { limits } from '../../middleware/rateLimit';
import { invalidateMemberships } from '../../lib/presenceCache';
import { invalidatePerms } from '../../lib/permCache';
import { invalidateMemberCount } from '../discover';
import { evictUserFromServerRooms } from '../../lib/liveMembership';
import { envSafeInt } from '../../lib/envNumbers';
import { joinDiscoverableServer, afterMemberJoined } from '../../lib/serverMembership';
import { parseServerMfaLevelWrite } from '../../lib/serverMfaPolicy';
import {
  raidProtectionStatus,
  type RaidMitigationLevel,
} from '../../lib/raidProtection';
import logger from '../../lib/logger';
import { buildPortableCommunityStructure } from '../../lib/portableCommunity';
import { validatePortableCommunityStructure, PortableCommunityValidationError } from '../../lib/portableCommunityValidation';
import { buildPortableCommunityPreview } from '../../lib/portableCommunityPreview';
import { inspectPortableCommunityManifestPair, PortableCommunityPairError } from '../../lib/portableCommunityPair';
import { previewCommunityPermissionRemapping } from '../../lib/portableCommunityPermissionPreflight';
import { inspectExplicitCommunityMapping, PortableCommunityMappingError } from '../../lib/portableCommunityMappingReview';
import { fingerprintDestinationTopology } from '../../lib/portableCommunityTargetFingerprint';
import { buildPortableCommunityPermissionManifest } from '../../lib/portableCommunityPermissions';
import { enforceStepUp } from '../../lib/stepUp';
import db from '../../db/loader';
import { issueAtomicPortableSourceAttestation } from '../../lib/portableSourceSnapshotIssuer';
import { readPortableSourceSigningConfig } from '../../lib/portableSourceExportConfig';

// GET /api/servers
/**
 * @openapi
 * /servers:
 *   get:
 *     tags: [Servers]
 *     summary: Kullanicinin katildigi sunuculari listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Sunucu listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Server' }
 *   post:
 *     tags: [Servers]
 *     summary: Yeni sunucu olustur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, maxLength: 100 }
 *               description: { type: string, maxLength: 500 }
 *               icon:        { type: string }
 *     responses:
 *       201:
 *         description: Sunucu olusturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Server' }
 * /servers/{sid}:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu detayini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sunucu detayi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Server' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Servers]
 *     summary: Sunucu ayarlarini guncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:        { type: string }
 *               description: { type: string }
 *               icon:        { type: string }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Sunucuyu sil (sadece sahip)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /servers/{sid}/leave:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucudan ayril
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Ayrilindi
 * /servers/{sid}/members:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu uyelerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         description: Enables the structured cursor response; maximum 100.
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 100 }
 *       - in: query
 *         name: cursor
 *         description: Opaque nextCursor from a previous structured response.
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Legacy array without query parameters, otherwise a structured cursor page.
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /servers/{sid}/members/{uid}:
 *   patch:
 *     tags: [Servers]
 *     summary: Uye bilgilerini guncelle (nick, roller)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nick:  { type: string, maxLength: 32 }
 *               roles: { type: array, items: { type: string } }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Servers]
 *     summary: Uyeyi sunucudan kick et
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: uid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Kicklendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /servers/{sid}/audit-log:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu denetim logu
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Denetim logu
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const memberships = await Members.findByUser(_u.id);
  const serverIds   = memberships.map(m => m.serverId);
  const servers     = (await Servers.find({ _id: { $in: serverIds } })).sort((a, b) => Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0));
  res.json(servers);
});

// P7 C2: owner-only, read-only community structure export.
// No member roster, invitation, message, webhook, secret or channel override is
// exported. A fresh sensitive-export grant is mandatory (stolen bearer is insufficient).
// Future cross-instance import is NOT implied by this profile-independent endpoint.
router.get('/:sid/portable-export', authMiddleware, limits.write(), async (req, res) => {
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  // Do NOT permit delegated managers to export private topology.
  if (server.ownerId !== actor.id) return res.status(403).json({ error: 'Only the server owner may export its structure' });
  if (!(await enforceStepUp(req, res, actor.id, 'account.export'))) return;

  try {
    const [categories, channels, roles] = await Promise.all([
      Channels.findCategoriesByServer(sid),
      Channels.findByServer(sid),
      Roles.findByServer(sid),
    ]);
    const result = buildPortableCommunityStructure(
      server as unknown as Record<string, unknown>,
      categories as unknown as Array<Record<string, unknown>>,
      channels as unknown as Array<Record<string, unknown>>,
      roles as unknown as Array<Record<string, unknown>>,
    );
    // Bound downloads and refuse incomplete results instead of truncating rows.
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 512 * 1024) {
      return res.status(413).json({ error: 'Community structure export exceeds 512 KiB' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment; filename="bridge-community-structure-v1.json"');
    return res.status(200).json(result);
  } catch (err) {
    logger.error({ err, sid, userId: actor.id, event: 'server.portable_structure_export.failed' },
      'Community structure export failed closed.');
    return res.status(409).json({
      code: 'PORTABLE_COMMUNITY_SOURCE_INCONSISTENT',
      error: 'Community structure cannot be exported safely',
    });
  }
});

// P7 C4: optional operator-provisioned, owner-only paired source export.
// Uses one READ ONLY REPEATABLE READ PostgreSQL snapshot; NEVER imports or
// modifies a community. A key from the request or its Host header is NOT trusted.
router.get('/:sid/portable-export/attested-pair', authMiddleware, limits.write(), async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid);
  if (!server) return res.status(404).json({ error: 'Source community not found' });
  if (server.ownerId !== actor.id) {
    return res.status(403).json({ error: 'Only the source community owner may export a signed snapshot' });
  }
  if (!(await enforceStepUp(req, res, actor.id, 'account.export'))) return;

  // Test DBs, wrong deployment backends, or unconfigured operators MUST
  // fail closed. Never substitute multiple repository queries for a PG client.
  try {
    const { sourceOrigin, signingPrivateKeyPem } = readPortableSourceSigningConfig();
    const pool = (db as unknown as {
      _pool?: Parameters<typeof issueAtomicPortableSourceAttestation>[0]['pool'];
    })._pool;
    if (!pool || typeof pool.connect !== 'function') throw new Error('PG pool unavailable');
    const result = await issueAtomicPortableSourceAttestation({
      pool, sourceServerId: sid, ownerUserId: actor.id,
      sourceOrigin, signingPrivateKeyPem,
    });
    // Only publish an explicit positive list. If future internal signers add
    // credentials, backend state, key material or debugging fields, those
    // fields must NEVER automatically become part of this download.
    if (result.mode !== 'read-only' || result.importSupported !== false ||
        result.writesPerformed !== false || result.mappingApproved !== false ||
        result.approvalReusable !== false ||
        result.sourceReadIsolation !== 'single-client-repeatable-read' ||
        result.remotelyVerifiedAtomicity !== false ||
        result.attestation.sourceOrigin !== sourceOrigin) {
      throw new Error('Unexpected source signing contract');
    }
    const safeResult = {
      mode: 'read-only' as const, importSupported: false as const,
      writesPerformed: false as const, mappingApproved: false as const,
      approvalReusable: false as const,
      sourceReadIsolation: 'single-client-repeatable-read' as const,
      remotelyVerifiedAtomicity: false as const,
      structure: result.structure,
      permissions: result.permissions,
      attestation: result.attestation,
    };
    if (Buffer.byteLength(JSON.stringify(safeResult), 'utf8') > 1152 * 1024) {
      throw new Error('Source snapshot response size exceeds limit');
    }
    res.setHeader('Content-Disposition', 'attachment; filename="bridge-community-attested-pair-v1.json"');
    return res.status(200).json(safeResult);
  } catch {
    // Never log the signer config/PEM, SQL, manifest contents or owner ID.
    logger.warn({ event: 'server.portable_attested_export.unavailable' },
      'Signed source snapshot unavailable.');
    return res.status(503).json({
      code: 'PORTABLE_SOURCE_ATTESTED_EXPORT_UNAVAILABLE',
      error: 'Signed source snapshot could not be exported safely',
    });
  }
});

// P7 C3 preflight ONLY: check source schema and show conservative name
// collisions against a destination community. Never write a destination row.
router.post('/:sid/portable-import/preview', authMiddleware, limits.write(), async (req, res) => {
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  res.setHeader('Cache-Control', 'no-store');
  const server = await Servers.findById(sid);
  if (!server) return res.status(404).json({ error: 'Target community not found' });
  if (server.ownerId !== actor.id) {
    return res.status(403).json({ error: 'Only the destination owner may preview a structure import' });
  }
  if (!(await enforceStepUp(req, res, actor.id, 'account.import'))) return;

  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid preview request' });
  }
  const fields = Object.keys(body);
  if (fields.length !== 2 || !fields.includes('document') || !fields.includes('targetServerId')) {
    return res.status(400).json({ error: 'Expected document and targetServerId' });
  }
  const input = body as { document: unknown; targetServerId: unknown };
  if (input.targetServerId !== sid) {
    return res.status(409).json({ code: 'PORTABLE_COMMUNITY_TARGET_CHANGED', error: 'Destination must match authenticated target' });
  }

  let snapshot: ReturnType<typeof validatePortableCommunityStructure>;
  try {
    snapshot = validatePortableCommunityStructure(input.document);
  } catch (err) {
    if (err instanceof PortableCommunityValidationError) {
      return res.status(422).json({ code: err.code, error: 'Invalid community structure snapshot' });
    }
    throw err;
  }
  try {
    const [categories, roles, channels] = await Promise.all([
      Channels.findCategoriesByServer(sid),
      Roles.findByServer(sid),
      Channels.findByServer(sid),
    ]);
    const preview = buildPortableCommunityPreview(snapshot, {
      serverId: sid, name: String(server.name ?? ''),
      categories: categories as unknown as Array<Record<string, unknown>>,
      roles: roles as unknown as Array<Record<string, unknown>>,
      channels: channels as unknown as Array<Record<string, unknown>>,
    });
    return res.status(200).json(preview);
  } catch (err) {
    logger.error({ err, sid, userId: actor.id, event: 'server.portable_structure_preview.failed' },
      'Read-only community structure preview unavailable.');
    return res.status(503).json({ code: 'PORTABLE_COMMUNITY_PREVIEW_UNAVAILABLE', error: 'Cannot build a complete destination preview' });
  }
});

// P7 C3: paired structure + permission manifest preflight. Read-only,
// owner-bound and fresh account-security proof. NOT an apply endpoint.
router.post('/:sid/portable-import/paired-preview', authMiddleware, limits.write(), async (req, res) => {
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  res.setHeader('Cache-Control', 'no-store');
  const destination = await Servers.findById(sid);
  if (!destination) return res.status(404).json({ error: 'Target community not found' });
  if (destination.ownerId !== actor.id) {
    return res.status(403).json({ error: 'Only the destination owner may preview community migration' });
  }
  if (!(await enforceStepUp(req, res, actor.id, 'account.import'))) return;

  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid paired preview request' });
  }
  const fields = Object.keys(body);
  if (fields.length !== 3 || !fields.includes('structure') ||
      !fields.includes('permissions') || !fields.includes('targetServerId')) {
    return res.status(400).json({ error: 'Expected structure, permissions and targetServerId' });
  }
  const input = body as { structure: unknown; permissions: unknown; targetServerId: unknown };
  if (input.targetServerId !== sid) {
    return res.status(409).json({
      code: 'PORTABLE_COMMUNITY_TARGET_CHANGED',
      error: 'Destination must match authenticated target',
    });
  }

  let pair: ReturnType<typeof inspectPortableCommunityManifestPair>;
  let structure: ReturnType<typeof validatePortableCommunityStructure>;
  try {
    pair = inspectPortableCommunityManifestPair(input.structure, input.permissions);
    structure = validatePortableCommunityStructure(input.structure);
  } catch (err) {
    if (err instanceof PortableCommunityPairError || err instanceof PortableCommunityValidationError) {
      return res.status(422).json({
        code: 'PORTABLE_COMMUNITY_PAIR_INVALID',
        error: 'Invalid or inconsistent community migration documents',
      });
    }
    throw err;
  }
  try {
    const [categories, roles, channels] = await Promise.all([
      Channels.findCategoriesByServer(sid), Roles.findByServer(sid), Channels.findByServer(sid),
    ]);
    const preview = buildPortableCommunityPreview(structure, {
      serverId: sid, name: String(destination.name ?? ''),
      categories: categories as unknown as Array<Record<string, unknown>>,
      roles: roles as unknown as Array<Record<string, unknown>>,
      channels: channels as unknown as Array<Record<string, unknown>>,
    });
    // Read-only diagnostics: name/type agreement is NOT a trusted ID map.
    const permissionMapping = previewCommunityPermissionRemapping(
      input.structure, input.permissions,
      {
        roles: roles as unknown as Array<Record<string, unknown>>,
        channels: channels as unknown as Array<Record<string, unknown>>,
      },
    );
    const targetTopologyDigest = fingerprintDestinationTopology({
      serverId: sid,
      categories: categories as unknown as Array<Record<string, unknown>>,
      roles: roles as unknown as Array<Record<string, unknown>>,
      channels: channels as unknown as Array<Record<string, unknown>>,
    });
    return res.status(200).json({
      ...preview,
      targetTopologyDigest,
      permissionPair: pair,
      permissionMapping,
      unsupported: [
        'Legacy, user-specific and unknown-target permissions are only counted; not imported',
        'Member identities, memberships, messages and attachments',
        'Credentials, webhooks, bots and moderation records',
        'Actual import, rollback and ID remapping',
      ],
      blockers: [
        ...new Set([
          ...preview.blockers.filter(value => value !== 'PERMISSION_OVERRIDES_NOT_EXPORTED'),
          ...pair.blockers,
          ...permissionMapping.blockers,
          'CHANNEL_PERMISSION_APPLICATION_NOT_IMPLEMENTED',
        ]),
      ],
    });
  } catch (err) {
    logger.error({ err, sid, userId: actor.id, event: 'server.portable_pair_preview.failed' },
      'Paired community preview refused because destination data could not be read completely.');
    return res.status(503).json({
      code: 'PORTABLE_COMMUNITY_PREVIEW_UNAVAILABLE',
      error: 'Cannot build a complete destination preview',
    });
  }
});

// P7 C3: fetch only the destination topology digest, without uploading
// source documents. Owner+fresh import step-up required; no DB writes.
router.get('/:sid/portable-import/target-fingerprint', authMiddleware, limits.write(), async (req, res) => {
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  res.setHeader('Cache-Control', 'no-store');
  const target = await Servers.findById(sid);
  if (!target) return res.status(404).json({ error: 'Target community not found' });
  if (target.ownerId !== actor.id) {
    return res.status(403).json({ error: 'Only the destination owner may inspect topology fingerprint' });
  }
  if (!(await enforceStepUp(req, res, actor.id, 'account.import'))) return;
  try {
    const [categories, roles, channels] = await Promise.all([
      Channels.findCategoriesByServer(sid), Roles.findByServer(sid), Channels.findByServer(sid),
    ]);
    const targetTopologyDigest = fingerprintDestinationTopology({
      serverId: sid,
      categories: categories as unknown as Array<Record<string, unknown>>,
      roles: roles as unknown as Array<Record<string, unknown>>,
      channels: channels as unknown as Array<Record<string, unknown>>,
    });
    return res.status(200).json({
      mode: 'read-only',
      writesPerformed: false,
      importSupported: false,
      targetServerId: sid,
      targetTopologyDigest,
      topologyOnly: true,
      transactionalLock: false,
      counts: { categories: categories.length, roles: roles.length, channels: channels.length },
    });
  } catch (err) {
    logger.error({ err, sid, userId: actor.id, event: 'server.portable_target_fingerprint.failed' },
      'Cannot compute a complete destination topology fingerprint.');
    return res.status(503).json({
      code: 'PORTABLE_COMMUNITY_TARGET_FINGERPRINT_UNAVAILABLE',
      error: 'Cannot read a complete destination topology fingerprint',
    });
  }
});

// P7 C3: require explicit, one-to-one source => EXISTING target ID choices.
// Review only. A fresh step-up proof is NOT an import/write authorization.
router.post('/:sid/portable-import/mapping-review', authMiddleware, limits.write(), async (req, res) => {
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  res.setHeader('Cache-Control', 'no-store');
  const destination = await Servers.findById(sid);
  if (!destination) return res.status(404).json({ error: 'Target community not found' });
  if (destination.ownerId !== actor.id) {
    return res.status(403).json({ error: 'Only the destination owner may inspect identity mappings' });
  }
  if (!(await enforceStepUp(req, res, actor.id, 'account.import'))) return;

  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Invalid identity mapping request' });
  }
  const keys = Object.keys(body);
  if (keys.length !== 4 || !keys.includes('structure') || !keys.includes('permissions') ||
      !keys.includes('mapping') || !keys.includes('targetServerId')) {
    return res.status(400).json({ error: 'Expected structure, permissions, mapping and targetServerId' });
  }
  const input = body as {
    structure: unknown; permissions: unknown; mapping: unknown; targetServerId: unknown;
  };
  if (input.targetServerId !== sid) {
    return res.status(409).json({ code: 'PORTABLE_COMMUNITY_TARGET_CHANGED',
      error: 'Destination must match authenticated target' });
  }

  let categories: Array<Record<string, unknown>>;
  let roles: Array<Record<string, unknown>>;
  let channels: Array<Record<string, unknown>>;
  try {
    const data = await Promise.all([
      Channels.findCategoriesByServer(sid), Roles.findByServer(sid), Channels.findByServer(sid),
    ]);
    categories = data[0] as unknown as Array<Record<string, unknown>>;
    roles = data[1] as unknown as Array<Record<string, unknown>>;
    channels = data[2] as unknown as Array<Record<string, unknown>>;
  } catch (err) {
    logger.error({ err, sid, userId: actor.id, event: 'server.portable_mapping_read.failed' },
      'Destination identity mapping data unavailable.');
    return res.status(503).json({ code: 'PORTABLE_COMMUNITY_MAPPING_UNAVAILABLE',
      error: 'Cannot read complete destination mapping data' });
  }
  try {
    const review = inspectExplicitCommunityMapping(input.structure, input.permissions,
      input.mapping, { serverId: sid, categories, roles, channels });
    return res.status(200).json(review);
  } catch (err) {
    if (err instanceof PortableCommunityMappingError) {
      return res.status(422).json({ code: err.code, error: 'Invalid or unsafe identity mapping request' });
    }
    throw err;
  }
});

// P7 C2: separate permission coverage download — never replace the C2 v1
// structure format or claim the omitted per-user/legacy grants are portable.
router.get('/:sid/portable-permissions-export', authMiddleware, limits.write(), async (req, res) => {
  const actor = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  res.setHeader('Cache-Control', 'no-store');
  const server = await Servers.findById(sid);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== actor.id) {
    return res.status(403).json({ error: 'Only the source community owner may export its permissions' });
  }
  if (!(await enforceStepUp(req, res, actor.id, 'account.export'))) return;

  try {
    const [channels, roles] = await Promise.all([Channels.findByServer(sid), Roles.findByServer(sid)]);
    // Bound per-channel reads and concurrent PostgreSQL queries.
    if (channels.length > 500 || roles.length > 2000) {
      return res.status(413).json({ error: 'Community permission manifest exceeds supported bounds' });
    }
    const data: Array<{
      channelId: string;
      canonical: Array<Record<string, unknown>>;
      legacy: Array<Record<string, unknown>>;
    }> = [];
    for (let start = 0; start < channels.length; start += 8) {
      const batch = channels.slice(start, start + 8);
      const read = await Promise.all(batch.map(async channel => {
        const channelId = String(channel._id);
        const [canonical, legacy] = await Promise.all([
          ChannelPermissions.findByChannel(channelId),
          Channels.findOverridesByChannel(channelId),
        ]);
        return {
          channelId,
          canonical: canonical as unknown as Array<Record<string, unknown>>,
          legacy: legacy as unknown as Array<Record<string, unknown>>,
        };
      }));
      data.push(...read);
    }
    const manifest = buildPortableCommunityPermissionManifest(
      server as unknown as Record<string, unknown>,
      channels as unknown as Array<Record<string, unknown>>,
      roles as unknown as Array<Record<string, unknown>>,
      data,
    );
    if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 512 * 1024) {
      return res.status(413).json({ error: 'Permission manifest exceeds 512 KiB' });
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'attachment; filename="bridge-community-permissions-v1.json"');
    return res.status(200).json(manifest);
  } catch (err) {
    logger.error({ err, sid, userId: actor.id, event: 'server.portable_permissions_export.failed' },
      'Permission coverage export refused due to incomplete or invalid source data.');
    return res.status(503).json({
      code: 'PORTABLE_COMMUNITY_PERMISSIONS_UNAVAILABLE',
      error: 'Cannot safely export complete permission coverage',
    });
  }
});

// POST /api/servers
/**
 * @openapi
 * /servers:
 *   post:
 *     tags: [Servers]
 *     summary: Yeni sunucu oluştur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 50, example: "Bridge HQ" }
 *               icon: { type: string, example: "🌐" }
 *     responses:
 *       200:
 *         description: Oluşturulan sunucu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Server' }
 *       400: { description: Geçersiz istek }
 */
router.post('/', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  // Faz 10.11 — GÖVDE TİP DOĞRULAMASI.
  // `name?.trim()` yalnız null/undefined'a karşı korumalıydı; sayı veya nesne
  // gönderildiğinde `.trim` bir fonksiyon olmadığı için TypeError fırlıyor ve
  // istemci açıklanamayan 500 alıyordu (tests/server-create-join.test.ts).
  // Yalnız düz string kabul edilir; diğer her tip 400'dür.
  const body     = req.body as Record<string, unknown> | undefined;
  const rawName  = body?.name;
  const icon     = typeof body?.icon === 'string' ? body.icon : undefined;
  const name     = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name)           return res.status(400).json({ error: 'Server name required' });
  if (name.length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });

  // SECURITY: the repository enforces this limit inside the same per-owner
  // PostgreSQL transaction/lock as creation, so concurrent requests cannot
  // both pass a racy count and exceed the resource bound.
  const MAX_SERVERS_PER_USER = envSafeInt('MAX_SERVERS_PER_USER', 100, { min: 1, max: 100_000 });

  // SECURITY: icon alanı sanitize — XSS ve script injection önleme
  // Yalnızca tek emoji veya boş string kabul edilir; uzun string veya HTML reddedilir.
  let safeIcon = '🌐';
  if (icon && typeof icon === 'string') {
    const trimmed = icon.trim().slice(0, 10); // Unicode emoji max 2 codepoint = 8 byte
    // HTML/script içeriyorsa reddet
    if (/<|>|javascript:|on\w+\s*=/i.test(trimmed)) {
      return res.status(400).json({ error: 'Invalid icon value' });
    }
    safeIcon = trimmed || '🌐';
  }

  const serverId = uuidv4();
  const createdAt = Date.now();
  const created = await Servers.createWithDefaultsAtomic({
    serverId,
    ownerId: _u.id,
    name,
    icon: safeIcon,
    textChannelId: uuidv4(),
    voiceChannelId: uuidv4(),
    createdAt,
    maxOwnedServers: MAX_SERVERS_PER_USER,
  });
  if (created.status === 'limit') {
    return res.status(400).json({ error: `Server creation limit reached (max ${MAX_SERVERS_PER_USER})` });
  }

  await afterMemberJoined(
    { id: _u.id, username: _u.username, displayName: _u.displayName },
    serverId,
  );
  return res.json(created.server);
});

// PATCH /api/servers/:sid
/**
 * @openapi
 * /servers/{serverId}:
 *   patch:
 *     tags: [Servers]
 *     summary: Sunucu bilgilerini güncelle (yalnızca sahip)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, maxLength: 50 }
 *               icon: { type: string }
 *               aiEnabled: { type: boolean, description: "P6: false = this server's content is never sent to an AI provider" }
 *     responses:
 *       200: { description: Güncellenmiş sunucu }
 *       403: { description: Yetki yok }
 *       404: { description: Sunucu bulunamadı }
 *   delete:
 *     tags: [Servers]
 *     summary: Sunucuyu sil (yalnızca sahip)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Silindi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deleted: { type: boolean }
 *       403: { description: Yetki yok }
 *       404: { description: Sunucu bulunamadı }
 */
router.patch('/:sid', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only the server owner can rename it' });

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const { name, icon, mfaLevel, aiEnabled } = body;
  const updates: Record<string, unknown> = {};
  // P6 — per-server AI opt-out. Owner only (this route is owner-only); a strict
  // boolean, never coerced: "false" or 0 from a careless client is refused
  // rather than silently re-enabling or disabling AI.
  if (aiEnabled !== undefined) {
    if (typeof aiEnabled !== 'boolean') return res.status(400).json({ error: 'aiEnabled must be a boolean' });
    updates.aiEnabled = aiEnabled;
  }
  if (name !== undefined && typeof name !== 'string') {
    return res.status(400).json({ error: 'Server name must be a string' });
  }
  if (icon !== undefined && typeof icon !== 'string') {
    return res.status(400).json({ error: 'Server icon must be a string' });
  }
  if (typeof name === 'string' && name.trim()) {
    if (name.trim().length > 50) return res.status(400).json({ error: 'Server name too long (max 50)' });
    updates.name = name.trim();
  }
  if (typeof icon === 'string' && icon.trim()) {
    // SECURITY: icon XSS validation
    if (/<|>|javascript:|on\w+\s*=/i.test(icon.trim())) {
      return res.status(400).json({ error: 'Invalid icon value' });
    }
    updates.icon = icon.trim().slice(0, 10);
  }
  // Sprint 121 FIX 15: mfaLevel — sadece sunucu sahibi ayarlayabilir (0/1/2)
  if (mfaLevel !== undefined) {
    const parsedMfaLevel = parseServerMfaLevelWrite(mfaLevel);
    if (parsedMfaLevel === null) {
      return res.status(400).json({ error: 'mfaLevel must be the integer 0, 1, or 2' });
    }
    updates.mfaLevel = parsedMfaLevel;
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await Servers.update(String(req.params.sid ?? ''), updates);
  const updated = await Servers.findById(String(req.params.sid ?? ''));
  res.json(updated);
});

// GET/PATCH /api/servers/:sid/raid-protection
//
// P7 B1 — moderator-visible and reversible anti-raid controls. The configured
// level and exact thresholds are returned so enforcement is explainable.
// MANAGE_SERVER is the authorization boundary; UI visibility is not.
router.get('/:sid/raid-protection', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid) as Record<string, unknown> | null;
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  }

  return res.json(raidProtectionStatus(server));
});

router.patch('/:sid/raid-protection', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const server = await Servers.findById(sid) as Record<string, unknown> | null;
  if (!server) return res.status(404).json({ error: 'Server not found' });

  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER)) {
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const hasLevel = Object.prototype.hasOwnProperty.call(body, 'level');
  const hasClear = Object.prototype.hasOwnProperty.call(body, 'clearLockdown');

  let level: RaidMitigationLevel | undefined;
  if (hasLevel) {
    if (body.level !== 'off' && body.level !== 'balanced' && body.level !== 'strict') {
      return res.status(400).json({ error: 'level must be off, balanced, or strict' });
    }
    level = body.level;
  }

  let clearLockdown = false;
  if (hasClear) {
    if (typeof body.clearLockdown !== 'boolean') {
      return res.status(400).json({ error: 'clearLockdown must be a boolean' });
    }
    clearLockdown = body.clearLockdown;
  }

  if (!hasLevel && !clearLockdown) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const previous = raidProtectionStatus(server);
  const updates: Record<string, unknown> = {};
  if (level !== undefined) updates.raidMitigationLevel = level;
  if (clearLockdown || level === 'off') updates.raidLockdownUntil = null;

  await Servers.update(sid, updates);
  // Ending raid mode also lifts the posting holds it placed (and only those).
  const releasedHolds = (clearLockdown || level === 'off') && previous.lockdownUntil !== null
    ? await Members.releaseRaidHold(sid, previous.lockdownUntil)
    : 0;
  const updated = await Servers.findById(sid) as Record<string, unknown> | null;
  if (!updated) return res.status(404).json({ error: 'Server not found' });
  const next = raidProtectionStatus(updated);

  try {
    await Auth.insertAuditLog({
      serverId: sid,
      actorId: _u.id,
      actorName: _u.displayName || _u.username || _u.id,
      action: clearLockdown || level === 'off'
        ? 'raid_protection_reversed'
        : 'raid_protection_updated',
      target: sid,
      extra: {
        previous: {
          level: previous.level,
          lockdownUntil: previous.lockdownUntil,
        },
        next: {
          level: next.level,
          lockdownUntil: next.lockdownUntil,
        },
        releasedHolds,
      },
    });
  } catch (auditError) {
    // The policy update is already durable; do not falsely report it failed.
    // Audit degradation is still operationally visible.
    logger.warn({
      event: 'raid.config.audit_failed',
      serverId: sid,
      actorId: _u.id,
      err: auditError instanceof Error ? auditError.message : String(auditError),
    }, 'Raid protection update committed but audit logging failed.');
  }

  return res.json({ ...next, releasedHolds });
});

// POST /api/servers/:sid/leave
/**
 * @openapi
 * /servers/{serverId}/members:
 *   get:
 *     tags: [Servers]
 *     summary: Sunucu üyelerini listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100 } }
 *       - { name: cursor, in: query, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Parametresiz çağrıda eski dizi; limit/cursor ile yapılandırılmış cursor sayfası
 *         content:
 *           application/json:
 *             schema:
 *               oneOf:
 *                 - type: array
 *                   items: { $ref: '#/components/schemas/UserProfile' }
 *                 - type: object
 *                   required: [members, hasMore, nextCursor, limit, count]
 *                   properties:
 *                     members:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/UserProfile' }
 *                     hasMore: { type: boolean }
 *                     nextCursor: { type: string, nullable: true }
 *                     limit: { type: integer }
 *                     count: { type: integer }
 * /servers/{serverId}/leave:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucudan ayrıl
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Ayrıldı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 left: { type: boolean }
 *       400: { description: Sahip ayrılamaz }
 * /servers/{serverId}/join:
 *   post:
 *     tags: [Servers]
 *     summary: Sunucuya katıl (public)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: serverId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Katıldı }
 *       400: { description: Zaten üye }
 *       404: { description: Sunucu bulunamadı }
 */
router.post('/:sid/leave', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId === _u.id)
    return res.status(400).json({ error: 'Owner cannot leave — delete the server instead' });

  const membership = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!membership) return res.status(400).json({ error: 'Not a member' });

  const leavingServerId = String(req.params.sid ?? '');
  await Members.remove(_u.id, leavingServerId);
  invalidatePerms(leavingServerId, _u.id);
  await invalidateMemberships(_u.id);
  await evictUserFromServerRooms(req.app.get('io'), _u.id, leavingServerId);
  invalidateMemberCount(String(req.params.sid ?? '')).catch(() => {});
  res.json({ left: true });
});

// DELETE /api/servers/:sid
router.delete('/:sid', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const server = await Servers.findById(String(req.params.sid ?? ''));
  if (!server)                  return res.status(404).json({ error: 'Server not found' });
  if (server.ownerId !== _u.id) return res.status(403).json({ error: 'Only the server owner can delete it' });
  // P7 B2: irreversible for every member — the owner proves it is still them
  // (`destructive-admin` step-up). Checked after ownership so only the owner is asked.
  if (!(await enforceStepUp(req, res, _u.id, 'server.delete'))) return;

  const sid = String(req.params.sid ?? '');
  // Tek canonical owner: production PostgreSQL'de bütün server graph tek
  // transaction'da silinir. Route-level paralel kaskadlar yarım tenant ve
  // yeni tablolar eklendikçe orphan veri bırakıyordu.
  const result = await Servers.deleteGraphAtomic(sid, _u.id);
  if (result === 'not_found') return res.status(404).json({ error: 'Server not found' });
  if (result === 'owner_mismatch') return res.status(403).json({ error: 'Only the current server owner can delete it' });
  res.json({ deleted: true });
});

// POST /api/servers/:sid/join
router.post('/:sid/join', authMiddleware, limits.servers(), async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const result = await joinDiscoverableServer(
    { id: _u.id, username: _u.username, displayName: _u.displayName },
    sid,
  );

  if (result.status === 'not_found') return res.status(404).json({ error: 'Server not found' });
  if (result.status === 'invite_required') {
    return res.status(403).json({ error: 'INVITE_REQUIRED', message: 'Bu sunucuya yalnızca davet ile katılabilirsiniz.' });
  }
  if (result.status === 'banned') {
    return res.status(403).json({ error: 'BANNED', message: 'Bu sunucudan yasaklandınız.' });
  }
  if (result.status === 'raid_lockdown') {
    const retryAfterMs = Math.max(1, result.retryAfterMs ?? 1_000);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    return res.status(429).json({
      error: 'RAID_LOCKDOWN',
      retryAfterMs,
      lockdownUntil: result.lockdownUntil ?? null,
      level: result.raidLevel,
    });
  }
  if (result.status === 'raid_authority_unavailable') {
    const retryAfterMs = Math.max(1, result.retryAfterMs ?? 1_000);
    res.set('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
    return res.status(503).json({
      error: 'RAID_PROTECTION_UNAVAILABLE',
      retryAfterMs,
    });
  }
  if (result.status === 'already_member') return res.status(400).json({ error: 'Already a member' });
  if (result.status === 'mfa_required') {
    return res.status(403).json({
      error: 'MFA_REQUIRED',
      message: 'Bu sunucuya katılmak için bir güvenlik anahtarı (passkey) kaydetmeniz gerekiyor.',
      mfaLevel: result.mfaLevel,
    });
  }

  return res.json(result.server);
});

// GET /api/servers/:sid/members
router.get('/:sid/members', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const paginationRequested = req.query.limit !== undefined || req.query.cursor !== undefined;
  if (!paginationRequested) {
    // Backward compatibility: clients that omit pagination parameters retain
    // the historical bare-array response until every consumer has migrated.
    const memberships = await Members.findByServer(serverId);
    const users       = await Users.findByIds(memberships.map(m => m.userId));
    const nickMap: Record<string, string> = {};
    memberships.forEach(m => { if (m.nickname) nickMap[m.userId] = m.nickname; });

    return res.json(users.map(u => {
      const safe = sanitizeUser(u) as unknown as Record<string, unknown>;
      if (nickMap[u._id]) safe.nickname = nickMap[u._id];
      return safe;
    }));
  }

  let limit = 100;
  if (req.query.limit !== undefined) {
    if (typeof req.query.limit !== 'string' || !/^\d+$/.test(req.query.limit)) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
    const parsed = Number(req.query.limit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 100' });
    }
    limit = parsed;
  }

  let cursor: { joinedAt: number; userId: string } | undefined;
  if (req.query.cursor !== undefined) {
    const rawCursor = req.query.cursor;
    if (typeof rawCursor !== 'string' || rawCursor.length === 0 || rawCursor.length > 512) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
    try {
      const decoded = JSON.parse(Buffer.from(rawCursor, 'base64').toString('utf8')) as {
        joinedAt?: unknown;
        userId?: unknown;
      } | null;
      if (!decoded || typeof decoded !== 'object' ||
          !Number.isSafeInteger(decoded.joinedAt) || Number(decoded.joinedAt) < 0 ||
          typeof decoded.userId !== 'string' || decoded.userId.length === 0 || decoded.userId.length > 200) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
      cursor = { joinedAt: Number(decoded.joinedAt), userId: decoded.userId };
    } catch {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const rawPage = await Members.findPageByServer(serverId, { limit: limit + 1, cursor });
  const hasMore = rawPage.length > limit;
  const page = hasMore ? rawPage.slice(0, limit) : rawPage;
  const userIds = page.map(row => String(row.userId));
  const users = await Users.findByIds(userIds);
  const usersById = new Map(users.map(user => [user._id, user]));
  const members = page.flatMap(row => {
    const userId = String(row.userId);
    const user = usersById.get(userId);
    if (!user) return [];
    const safe = sanitizeUser(user) as unknown as Record<string, unknown>;
    if (row.nickname) safe.nickname = String(row.nickname);
    return [safe];
  });
  const boundary = page.at(-1);
  const nextCursor = hasMore && boundary
    ? Buffer.from(JSON.stringify({
      joinedAt: Number(boundary.joinedAt),
      userId: String(boundary.userId),
    })).toString('base64')
    : null;

  return res.json({ members, hasMore, nextCursor, limit, count: members.length });
});

/**
 * GET /api/servers/:sid/me/permissions
 *
 * FAZ C2 — İSTEMCİ YETKİ SİNYALİ.
 *
 * İstemcinin, çağıranın ÇÖZÜLMÜŞ sunucu düzeyi izin bitlerini öğrenebileceği
 * hiçbir uç yoktu. Bu yüzden "MANAGE_CHANNELS varsa göster" gibi bir açıcı
 * yazılamıyordu: istemci ya herkese ölü bir kontrol gösterecekti ya da yalnız
 * sahibe gösterip rol tabanlı yöneticileri dışarıda bırakacaktı.
 *
 * Bu uç YALNIZCA ÇAĞIRANIN KENDİ bitlerini döner — başkasının izinleri
 * sızdırılmaz. Kanal izin rotaları da yetkilendirmeyi tam olarak bu düzeyde
 * yapar (`resolvePermissions(user, sid)`, kanal kimliği verilmeden), bu yüzden
 * sinyal ile gerçek kapı AYNI değeri kullanır ve sapamaz.
 *
 * GÜVENLİK: bu bir GÖRÜNÜRLÜK sinyalidir, yetki sınırı DEĞİLDİR. Gerçek sınır
 * her zaman yazma rotalarındaki kontrollerdir. Üye olmayan veya var olmayan
 * sunucu için ayrım yapılmadan 0 döner (varlık sızıntısı yok).
 */
router.get('/:sid/me/permissions', authMiddleware, async (req, res) => {
  const _u  = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  if (!sid) return res.json({ permissions: 0 });

  const permissions = await getMemberPerms(_u.id, sid);
  res.json({ permissions: Number(permissions) || 0 });
});

// PATCH /api/servers/:sid/members/:uid/nickname
router.patch('/:sid/members/:uid/nickname', authMiddleware, limits.servers(), async (req, res) => {
  const _u    = castAuthed(req).user;
  const isSelf = _u.id === String(req.params.uid ?? '');
  if (!isSelf) {
    const perms = await getMemberPerms(_u.id, String(req.params.sid ?? ''));
    if (!hasPermission(perms, PERMS.MANAGE_MEMBERS))
      return res.status(403).json({ error: 'Missing permission: MANAGE_MEMBERS' });
  }

  const { nickname } = req.body as Record<string, string>;
  const safeName = nickname ? String(nickname).trim().slice(0, 32) : null;
  await Members.update(String(req.params.uid ?? ''), String(req.params.sid ?? ''), { nickname: safeName });

  const io = req.app.get('io');
  if (io) {
    io.to(`server:${String(req.params.sid ?? '')}`).emit('member:nicknameUpdate', {
      userId: String(req.params.uid ?? ''), serverId: String(req.params.sid ?? ''), nickname: safeName,
    });
  }
  res.json({ nickname: safeName });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
