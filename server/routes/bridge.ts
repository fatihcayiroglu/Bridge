/**
 * @openapi
 * /bridges:
 *   get: { tags: [Bridge], summary: List channel bridges, responses: { '200': { description: Bridge list } } }
 *   post: { tags: [Bridge], summary: Create channel bridge, responses: { '201': { description: Bridge created } } }
 * /bridges/{id}:
 *   delete:
 *     tags: [Bridge]
 *     summary: Delete channel bridge
 *     parameters: [{ in: path, name: id, required: true, schema: { type: string } }]
 *     responses: { '200': { description: Bridge deleted } }
 */
// server/routes/bridge.js — Channel Bridge (message forwarding)
import type { Request, Response } from 'express';

const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Bridges, Channels } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { resolvePermissions, hasPermission, PERMS } = require('../lib/permissions');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// POST /api/bridges — create a bridge between two channels
router.post('/', authMiddleware, limits.write(), asyncHandler(async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { sourceChannelId, targetChannelId, sourceServerId, targetServerId, label } = req.body;
  if (sourceChannelId === undefined || sourceChannelId === null ||
      targetChannelId === undefined || targetChannelId === null ||
      sourceServerId === undefined || sourceServerId === null ||
      targetServerId === undefined || targetServerId === null) {
    return res.status(400).json({ error: 'sourceChannelId, targetChannelId, sourceServerId, targetServerId required' });
  }
  const srcChannelId = String(sourceChannelId).trim();
  const dstChannelId = String(targetChannelId).trim();
  const srcServerId = String(sourceServerId).trim();
  const dstServerId = String(targetServerId).trim();
  if (!srcChannelId || !dstChannelId || !srcServerId || !dstServerId) {
    return res.status(400).json({ error: 'sourceChannelId, targetChannelId, sourceServerId, targetServerId required' });
  }
  if (srcChannelId === dstChannelId) return res.status(400).json({ error: 'Cannot bridge a channel to itself' });

  // Channel/server identity is authoritative from DB; client-supplied server IDs
  // are only claims until both endpoints are resolved.
  const [sourceChannel, targetChannel] = await Promise.all([
    Channels.findByIdAndServer(srcChannelId, srcServerId),
    Channels.findByIdAndServer(dstChannelId, dstServerId),
  ]);
  if (!sourceChannel || !targetChannel) return res.status(400).json({ error: 'Channel/server mismatch' });

  const [sp, tp] = await Promise.all([
    resolvePermissions(_u.id, srcServerId, srcChannelId).catch(() => 0),
    resolvePermissions(_u.id, dstServerId, dstChannelId).catch(() => 0),
  ]);
  if (!hasPermission(sp, PERMS.VIEW_CHANNELS) || !hasPermission(sp, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'No permission in source channel' });
  if (!hasPermission(tp, PERMS.VIEW_CHANNELS) || !hasPermission(tp, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'No permission in target channel' });

  const created = await Bridges.createOrReactivateAtomic({
    id: uuidv4(),
    sourceChannelId: srcChannelId,
    targetChannelId: dstChannelId,
    sourceServerId: srcServerId,
    targetServerId: dstServerId,
    label: typeof label === 'string' ? label.slice(0, 64) : '',
    createdBy: _u.id,
    createdAt: Date.now(),
  });
  if (created.status === 'exists') return res.status(409).json({ error: 'Bridge already exists' });
  return res.json(created.bridge);
}));

// GET /api/bridges?channelId=xxx — get bridges for a channel
router.get('/', authMiddleware, asyncHandler(async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const channel = await Channels.findById(String(channelId));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const perms = await resolvePermissions(_u.id, String(channel.serverId), String(channelId)).catch(() => 0);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const bridges = await Bridges.find({
    $or: [{ sourceChannelId: channelId }, { targetChannelId: channelId }],
    active: true,
  });
  res.json(bridges);
}));

// DELETE /api/bridges/:id — remove bridge
router.delete('/:id', authMiddleware, limits.write(), asyncHandler(async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const bridge = await Bridges.findOne({ _id: req.params.id });
  if (!bridge) return res.status(404).json({ error: 'Not found' });
  const [sourceChannel, targetChannel] = await Promise.all([
    Channels.findByIdAndServer(String(bridge.sourceChannelId), String(bridge.sourceServerId)),
    Channels.findByIdAndServer(String(bridge.targetChannelId), String(bridge.targetServerId)),
  ]);
  if (!sourceChannel || !targetChannel) return res.status(409).json({ error: 'Bridge endpoint integrity check failed' });
  const [sourcePerms, targetPerms] = await Promise.all([
    resolvePermissions(_u.id, String(bridge.sourceServerId), String(bridge.sourceChannelId)).catch(() => 0),
    resolvePermissions(_u.id, String(bridge.targetServerId), String(bridge.targetChannelId)).catch(() => 0),
  ]);
  const canManageSource = hasPermission(sourcePerms, PERMS.VIEW_CHANNELS) && hasPermission(sourcePerms, PERMS.MANAGE_CHANNELS);
  const canManageTarget = hasPermission(targetPerms, PERMS.VIEW_CHANNELS) && hasPermission(targetPerms, PERMS.MANAGE_CHANNELS);
  if (!canManageSource && !canManageTarget) return res.status(403).json({ error: 'No permission' });
  await Bridges.update({ _id: req.params.id }, { $set: { active: false } });
  res.json({ removed: true });
}));

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
