// server/routes/polls.ts
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
import { Polls, Channels, Members, Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { PERMS, hasPermission, resolvePermissions } from '../lib/permissions';
import { parseNonNegativeSafeIntValue } from '../lib/queryNumbers';
import { parsePersistedEpochMillis } from '../lib/persistedEpoch';
import { isMemberTimedOut, parseMemberTimeoutUntil } from '../lib/memberTimeout';
import { checkEditedContent, checkMessageContent, contentRefusalHttp } from '../lib/messageContentPolicy';
import logger from '../lib/logger';
import type { HandlerServer } from '../socket/handler-contracts';

// POST /api/channels/:cid/polls
/**
 * @openapi
 * /channels/{cid}/polls:
 *   post:
 *     tags: [Polls]
 *     summary: Anket oluştur
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question, options]
 *             properties:
 *               question: { type: string }
 *               options: { type: array, items: { type: string }, minItems: 2 }
 *               duration: { type: integer, description: 'Süre (dakika)' }
 *     responses:
 *       201:
 *         description: Anket oluşturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Poll' }

 *
 * /channels/{channelId}/polls/{pollId}/end:
 *   post:
 *     tags: [Polls]
 *     summary: Anketi erken sonlandir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: pollId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Anket sonlandirildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
async function channelPerms(userId: string, serverId: string, channelId: string): Promise<number> {
  return resolvePermissions(userId, serverId, channelId).catch(() => 0);
}

async function canSeePoll(userId: string, poll: { serverId: string; channelId: string }): Promise<boolean> {
  const member = await Members.findOne(userId, poll.serverId).catch(() => null);
  if (!member) return false;
  const perms = await channelPerms(userId, poll.serverId, poll.channelId);
  return hasPermission(perms, PERMS.VIEW_CHANNELS);
}

type PollForClient = {
  _id: string;
  channelId: string;
  serverId: string;
  createdBy: string;
  question: string;
  options: Array<{ id: string; text: string; votes: string[] }>;
  multiSelect?: boolean;
  allowVoteChange?: boolean;
  expiresAt?: number | string | null;
  closed?: boolean;
};

/** Poll persistence needs voter ids for atomic mutation, but the product UI
 * only needs aggregate counts and whether the current viewer voted. Never
 * expose another member's vote identity through REST or channel broadcasts. */
function pollForViewer(poll: PollForClient, viewerId: string) {
  let expiresAt: number | null = null;
  if (poll.expiresAt !== null && poll.expiresAt !== undefined) {
    try { expiresAt = parsePersistedEpochMillis(poll.expiresAt); }
    catch { expiresAt = null; }
  }
  return {
    ...poll,
    expiresAt,
    options: poll.options.map(({ votes = [], ...option }) => ({
      ...option,
      voteCount: votes.length,
      votedByMe: votes.includes(viewerId),
    })),
  };
}

function emitPollInvalidation(req: express.Request, channelId: string, event: string, pollId: string): void {
  const io = req.app.get('io') as { to(room: string): { emit(event: string, payload: unknown): void } } | undefined;
  io?.to(`channel:${channelId}`).emit(event, { channelId, pollId });
}

/** What a poll shows its channel: the question and option texts, as stored. */
function pollText(question: string, options: Array<{ text: string }>): string {
  return [question, ...options.map(o => o.text)].join('\n');
}

async function displayNameOf(userId: string, member: { nickname?: unknown }): Promise<string> {
  const user = await Users.findById(userId).catch(() => null);
  return String(member.nickname || user?.displayName || user?.username || userId);
}

function ioOf(req: express.Request): HandlerServer | null {
  return (req.app.get('io') as HandlerServer | undefined) ?? null;
}

function mutationError(res: express.Response, status: string): express.Response {
  switch (status) {
    case 'not_found': return res.status(404).json({ error: 'Poll not found' });
    case 'closed': return res.status(400).json({ error: 'Poll is closed' });
    case 'expired': return res.status(400).json({ error: 'Poll expired' });
    case 'single_choice': return res.status(400).json({ error: 'Single choice only' });
    case 'invalid_option': return res.status(400).json({ error: 'Invalid optionId' });
    case 'vote_change_forbidden': return res.status(403).json({ error: 'Vote change not allowed for this poll' });
    case 'has_votes': return res.status(409).json({ error: 'Cannot change options after votes have been cast' });
    default: return res.status(500).json({ error: 'Poll mutation failed' });
  }
}

router.post('/:cid/polls', authMiddleware, limits.polls(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { question, options, multiSelect = false, duration, allowVoteChange = true } = req.body as {
    question?: string; options?: unknown; multiSelect?: boolean; duration?: unknown; allowVoteChange?: boolean;
  };
  if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'Question required' });
  if (!Array.isArray(options) || options.length < 2 || options.length > 10)
    return res.status(400).json({ error: 'Need 2-10 options' });

  const channelId = String(req.params.cid ?? '');
  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await Members.findOne(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  // A poll posts text to the channel, so a timed-out member cannot create one.
  if (isMemberTimedOut(member.timeoutUntil))
    return res.status(403).json({ error: 'You are timed out', until: parseMemberTimeoutUntil(member.timeoutUntil) });
  const perms = await channelPerms(_u.id, channel.serverId, channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.SEND_MESSAGES)) {
    return res.status(403).json({ error: 'Missing channel permission' });
  }

  if (typeof multiSelect !== 'boolean' || typeof allowVoteChange !== 'boolean') {
    return res.status(400).json({ error: 'multiSelect and allowVoteChange must be booleans' });
  }
  if (!options.every(o => typeof o === 'string' && o.trim().length > 0)) {
    return res.status(400).json({ error: 'Poll options must be non-empty strings' });
  }
  const durationMinutes = parseNonNegativeSafeIntValue(duration, 0);
  if (durationMinutes === null) return res.status(400).json({ error: 'duration must be a non-negative safe integer' });
  const now = Date.now();
  const expiresAt = durationMinutes ? now + durationMinutes * 60 * 1000 : null;
  if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
    return res.status(400).json({ error: 'duration produces an unsafe expiration timestamp' });
  }
  const storedQuestion = question.trim().slice(0, 300);
  const storedOptions = options.map((o, i) => ({ id: String(i), text: o.trim().slice(0, 100), votes: [] }));
  // A poll is read by every channel viewer: its text passes the same content
  // checks as a message (one owner, see lib/messageContentPolicy.ts). A
  // rule-store failure propagates to the error handler (fail closed).
  const refusal = await checkMessageContent({
    userId: _u.id,
    serverId: channel.serverId,
    channelId,
    content: pollText(storedQuestion, storedOptions),
    senderPerms: perms,
    memberRoles: (member as { roles?: unknown }).roles,
    displayName: await displayNameOf(_u.id, member as { nickname?: unknown }),
  }, ioOf(req));
  if (refusal) {
    const { status, body } = contentRefusalHttp(refusal);
    return res.status(status).json(body);
  }
  const poll = await Polls.insert({
    channelId,
    serverId: channel.serverId,
    createdBy: _u.id,
    question: storedQuestion,
    options: storedOptions,
    multiSelect,
    allowVoteChange,
    expiresAt,
    closed: false,
  });
  emitPollInvalidation(req, channelId, 'poll:created', poll._id);
  res.json(pollForViewer(poll, _u.id));
});

// GET /api/channels/:cid/polls
/**
 * @openapi
 * /channels/{cid}/polls:
 *   get:
 *     tags: [Polls]
 *     summary: Kanaldaki anketler
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Anket listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Poll' }
 */
router.get('/:cid/polls', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.cid ?? '');
  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await Members.findOne(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const perms = await channelPerms(_u.id, channel.serverId, channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) return res.status(403).json({ error: 'Channel is not visible' });
  const polls = await Polls.findByChannel(channelId);
  res.json(polls.map((poll) => pollForViewer(poll, _u.id)));
});

// POST /api/polls/:pid/vote
/**
 * @openapi
 * /polls/{pid}/vote:
 *   post:
 *     tags: [Polls]
 *     summary: Ankete oy ver
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [optionIndex]
 *             properties:
 *               optionIndex: { type: integer }
 *     responses:
 *       200: { description: Oy kaydedildi }
 */
router.post('/:pid/vote', authMiddleware, limits.polls(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { optionIds } = req.body as { optionIds?: unknown };
  if (!Array.isArray(optionIds) || !optionIds.length || optionIds.length > 10
      || optionIds.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(optionIds).size !== optionIds.length) {
    return res.status(400).json({ error: 'optionIds must contain 1-10 unique non-empty strings' });
  }

  const pollId = String(req.params.pid ?? '');
  const poll = await Polls.findById(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!await canSeePoll(_u.id, poll)) return res.status(403).json({ error: 'Forbidden' });

  const requested = optionIds as string[];
  const atomic = await Polls.mutateVoteAtomic(pollId, _u.id, requested, 'toggle');
  if (atomic) {
    if (atomic.status !== 'ok') return mutationError(res, atomic.status);
    emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
    return res.json(pollForViewer(atomic.poll, _u.id));
  }

  // In-memory test adapter compatibility. Production PostgreSQL uses the
  // row-locked atomic path above.
  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });
  if (poll.expiresAt !== null && poll.expiresAt !== undefined) {
    let expiresAt: number | null;
    try { expiresAt = parsePersistedEpochMillis(poll.expiresAt); } catch { expiresAt = null; }
    if (expiresAt === null || expiresAt <= Date.now()) return res.status(400).json({ error: 'Poll expired' });
  }
  if (!poll.multiSelect && requested.length > 1) return res.status(400).json({ error: 'Single choice only' });
  if (requested.some((oid) => !poll.options.some((o) => o.id === oid))) return res.status(400).json({ error: 'Invalid optionId' });
  const existing = poll.options.filter((o) => o.votes.includes(_u.id)).map((o) => o.id).sort();
  if (poll.allowVoteChange === false && existing.length) {
    const desired = [...requested].sort();
    if (desired.length !== existing.length || desired.some((v, i) => v !== existing[i])) {
      return res.status(403).json({ error: 'Vote change not allowed for this poll' });
    }
    return res.json(pollForViewer(poll, _u.id));
  }
  if (poll.multiSelect) {
    for (const oid of requested) {
      const opt = poll.options.find((o) => o.id === oid)!;
      opt.votes = opt.votes.includes(_u.id) ? opt.votes.filter((v) => v !== _u.id) : [...opt.votes, _u.id];
    }
  } else {
    const selected = poll.options.find((o) => o.id === requested[0])!;
    const alreadySelected = selected.votes.includes(_u.id);
    for (const opt of poll.options) opt.votes = opt.votes.filter((v) => v !== _u.id);
    if (!alreadySelected) selected.votes.push(_u.id);
  }
  await Polls.update(poll._id, { options: poll.options });
  const updated = await Polls.findById(poll._id);
  // The poll may be deleted concurrently between the write and the refresh read.
  // Honour the nullable repository contract instead of fabricating a stale payload.
  if (!updated) return res.status(404).json({ error: 'Poll not found' });
  emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
  res.json(pollForViewer(updated, _u.id));
});

// POST /api/polls/:pid/close
/**
 * @openapi
 * /polls/{pid}/close:
 *   post:
 *     tags: [Polls]
 *     summary: Anketi kapat
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Anket kapatıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/:pid/close', authMiddleware, limits.polls(), async (req, res) => {
  const _u = castAuthed(req).user;
  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!await canSeePoll(_u.id, poll)) return res.status(403).json({ error: 'Forbidden' });
  const perms = await channelPerms(_u.id, poll.serverId, poll.channelId);
  if (poll.createdBy !== _u.id && !hasPermission(perms, PERMS.MANAGE_MESSAGES)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await Polls.update(poll._id, { closed: true });
  emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
  res.json({ ok: true });
});



// GET /api/polls/:pid — Tek anket
router.get('/:pid', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!await canSeePoll(_u.id, poll)) return res.status(403).json({ error: 'Forbidden' });
  res.json(pollForViewer(poll, _u.id));
});

// PATCH /api/polls/:pid — Anket düzenle (sadece oluşturan, oy yokken)
/**
 * @openapi
 * /polls/{pid}:
 *   patch:
 *     tags: [Polls]
 *     summary: Anketi düzenle (soru, seçenekler, süre — oy yokken)
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               question: { type: string }
 *               options:  { type: array, items: { type: string }, minItems: 2 }
 *               duration: { type: integer }
 *               allowVoteChange: { type: boolean }
 *     responses:
 *       200: { description: Anket güncellendi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: Oy verilmiş anket düzenlenemez }
 */
router.patch('/:pid', authMiddleware, limits.polls(), async (req, res) => {
  const _u = castAuthed(req).user;
  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!await canSeePoll(_u.id, poll)) return res.status(403).json({ error: 'Forbidden' });
  if (poll.createdBy !== _u.id) return res.status(403).json({ error: 'Not your poll' });
  if (poll.closed) return res.status(400).json({ error: 'Closed poll cannot be edited' });
  if (poll.expiresAt !== null && poll.expiresAt !== undefined) {
    let expiresAt: number | null;
    try { expiresAt = parsePersistedEpochMillis(poll.expiresAt); } catch { expiresAt = null; }
    if (expiresAt === null || expiresAt <= Date.now()) {
      return res.status(400).json({ error: 'Expired poll cannot be edited' });
    }
  }

  const { question, options, duration, allowVoteChange } = req.body as {
    question?: unknown; options?: unknown; duration?: unknown; allowVoteChange?: unknown;
  };
  const updates: Record<string, unknown> = {};
  if (question !== undefined) {
    if (typeof question !== 'string' || !question.trim()) return res.status(400).json({ error: 'Question must be a non-empty string' });
    updates.question = question.trim().slice(0, 300);
  }
  if (options !== undefined) {
    if (!Array.isArray(options) || options.length < 2 || options.length > 10)
      return res.status(400).json({ error: 'Need 2-10 options' });
    if (!options.every(o => typeof o === 'string' && o.trim().length > 0)) {
      return res.status(400).json({ error: 'Poll options must be non-empty strings' });
    }
    updates.options = options.map((o, i) => ({ id: String(i), text: o.trim().slice(0, 100), votes: [] as string[] }));
  }
  if (duration !== undefined) {
    const durationMinutes = parseNonNegativeSafeIntValue(duration, 0);
    if (durationMinutes === null) return res.status(400).json({ error: 'duration must be a non-negative safe integer' });
    const now = Date.now();
    const expiresAt = durationMinutes ? now + durationMinutes * 60 * 1000 : null;
    if (expiresAt !== null && !Number.isSafeInteger(expiresAt)) {
      return res.status(400).json({ error: 'duration produces an unsafe expiration timestamp' });
    }
    updates.expiresAt = expiresAt;
  }
  if (allowVoteChange !== undefined) {
    if (typeof allowVoteChange !== 'boolean') return res.status(400).json({ error: 'allowVoteChange must be a boolean' });
    updates.allowVoteChange = allowVoteChange;
  }

  // AutoMod protects poll edits as it protects message edits: the text the
  // poll will show is checked before anything changes or is broadcast.
  if (updates.question !== undefined || updates.options !== undefined) {
    const member = await Members.findOne(_u.id, poll.serverId);
    if (!member) return res.status(403).json({ error: 'Forbidden' });
    let refusal: { reasons: string[] } | null;
    try {
      refusal = await checkEditedContent({
        userId: _u.id,
        serverId: poll.serverId,
        channelId: poll.channelId,
        content: pollText(
          (updates.question as string | undefined) ?? poll.question,
          (updates.options as Array<{ text: string }> | undefined) ?? poll.options,
        ),
        memberRoles: (member as { roles?: unknown }).roles,
        displayName: () => displayNameOf(_u.id, member as { nickname?: unknown }),
      }, ioOf(req));
    } catch (err) {
      logger.warn({ event: 'automod.poll_edit.failed', serverId: poll.serverId, pollId: poll._id, err },
        '[automod] poll edit enforcement failed');
      return res.status(503).json({ error: 'Moderation unavailable', code: 'AUTOMOD_UNAVAILABLE' });
    }
    if (refusal) {
      return res.status(422).json({ error: refusal.reasons.join(', ') || 'Anket AutoMod tarafından engellendi.', code: 'AUTOMOD_BLOCKED' });
    }
  }

  const atomic = await Polls.updateEditableAtomic(poll._id, updates, options !== undefined);
  if (atomic) {
    if (atomic.status !== 'ok') return mutationError(res, atomic.status);
    emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
    return res.json(pollForViewer(atomic.poll, _u.id));
  }

  if (options !== undefined) {
    const totalVotes = poll.options.reduce((sum, o) => sum + (o.votes?.length || 0), 0);
    if (totalVotes > 0) return res.status(409).json({ error: 'Cannot change options after votes have been cast' });
  }
  await Polls.update(poll._id, updates);
  const updated = await Polls.findById(poll._id);
  // The poll may be deleted concurrently between the write and the refresh read.
  // Honour the nullable repository contract instead of fabricating a stale payload.
  if (!updated) return res.status(404).json({ error: 'Poll not found' });
  emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
  res.json(pollForViewer(updated, _u.id));
});

// DELETE /api/polls/:pid/vote — Oyu geri al
/**
 * @openapi
 * /polls/{pid}/vote:
 *   delete:
 *     tags: [Polls]
 *     summary: Oyu geri al
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Oy geri alındı }
 */
router.delete('/:pid/vote', authMiddleware, limits.polls(), async (req, res) => {
  const _u = castAuthed(req).user;
  const pollId = String(req.params.pid ?? '');
  const poll = await Polls.findById(pollId);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!await canSeePoll(_u.id, poll)) return res.status(403).json({ error: 'Forbidden' });

  const atomic = await Polls.mutateVoteAtomic(pollId, _u.id, [], 'remove');
  if (atomic) {
    if (atomic.status !== 'ok') return mutationError(res, atomic.status);
    emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
    return res.json(pollForViewer(atomic.poll, _u.id));
  }

  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });
  if (poll.expiresAt !== null && poll.expiresAt !== undefined) {
    let expiresAt: number | null;
    try { expiresAt = parsePersistedEpochMillis(poll.expiresAt); } catch { expiresAt = null; }
    if (expiresAt === null || expiresAt <= Date.now()) return res.status(400).json({ error: 'Poll expired' });
  }
  if (!poll.allowVoteChange) return res.status(403).json({ error: 'Vote change not allowed for this poll' });
  for (const opt of poll.options) opt.votes = opt.votes.filter((v: string) => v !== _u.id);
  await Polls.update(poll._id, { options: poll.options });
  const updated = await Polls.findById(poll._id);
  // The poll may be deleted concurrently between the write and the refresh read.
  // Honour the nullable repository contract instead of fabricating a stale payload.
  if (!updated) return res.status(404).json({ error: 'Poll not found' });
  emitPollInvalidation(req, poll.channelId, 'poll:updated', poll._id);
  res.json(pollForViewer(updated, _u.id));
});

// DELETE /api/polls/:pid — Anketi sil (sadece oluşturan veya admin)
/**
 * @openapi
 * /polls/{pid}:
 *   delete:
 *     tags: [Polls]
 *     summary: Anketi sil
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Anket silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/:pid', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (!await canSeePoll(_u.id, poll)) return res.status(403).json({ error: 'Forbidden' });
  const perms = await channelPerms(_u.id, poll.serverId, poll.channelId);
  if (poll.createdBy !== _u.id && !hasPermission(perms, PERMS.MANAGE_MESSAGES)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  await Polls.delete(poll._id);
  emitPollInvalidation(req, poll.channelId, 'poll:deleted', poll._id);
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
