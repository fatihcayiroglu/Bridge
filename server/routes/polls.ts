// server/routes/polls.ts
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
import { Polls, Channels, Members } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';

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
 *               duration: { type: integer, description: 'Süre (saat)' }
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
router.post('/:cid/polls', authMiddleware, limits.polls(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { question, options, multiSelect = false, duration } = req.body as { question?: string; options?: unknown; multiSelect?: boolean; duration?: unknown };
  if (!question?.trim()) return res.status(400).json({ error: 'Question required' });
  if (!Array.isArray(options) || options.length < 2 || options.length > 10)
    return res.status(400).json({ error: 'Need 2-10 options' });

  const channel = await Channels.findById(String(req.params.cid ?? ''));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await Members.findOne(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const durationMinutes = Number(duration) || 0;
  const expiresAt = durationMinutes ? Date.now() + durationMinutes * 60 * 1000 : null;
  const poll = await Polls.insert({
    channelId:   String(req.params.cid ?? ''),
    serverId:    channel.serverId,
    createdBy:   _u.id,
    question:    question.trim().slice(0, 300),
    options:     options.map((o, i) => ({ id: String(i), text: String(o).trim().slice(0, 100), votes: [] })),
    multiSelect: !!multiSelect,
    expiresAt,
    closed:      false,
  });
  res.json(poll);
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
  const channel = await Channels.findById(String(req.params.cid ?? ''));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await Members.findOne(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const polls = await Polls.findByChannel(String(req.params.cid ?? ''));
  res.json(polls);
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
  if (!Array.isArray(optionIds) || !optionIds.length) return res.status(400).json({ error: 'optionIds required' });

  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });
  if (poll.expiresAt && Date.now() > poll.expiresAt) return res.status(400).json({ error: 'Poll expired' });

  const member = await Members.findOne(_u.id, poll.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!poll.multiSelect && optionIds.length > 1) return res.status(400).json({ error: 'Single choice only' });

  const requestedOptionIds = optionIds.map(oid => String(oid));
  const requestedOptions = requestedOptionIds.map(oid => poll.options.find(o => o.id === oid));
  if (requestedOptions.some(opt => !opt)) return res.status(400).json({ error: 'Invalid optionId' });

  if (poll.multiSelect) {
    for (const opt of requestedOptions) {
      if (!opt) continue;
      if (opt.votes.includes(_u.id)) opt.votes = opt.votes.filter(v => v !== _u.id);
      else opt.votes.push(_u.id);
    }
  } else {
    const selected = requestedOptions[0]!;
    const alreadySelected = selected.votes.includes(_u.id);
    for (const opt of poll.options) opt.votes = opt.votes.filter(v => v !== _u.id);
    if (!alreadySelected) selected.votes.push(_u.id);
  }

  await Polls.update(poll._id, { options: poll.options });
  const updated = await Polls.findById(poll._id);
  res.json(updated);
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
  if (poll.createdBy !== _u.id) return res.status(403).json({ error: 'Not your poll' });
  await Polls.update(poll._id, { closed: true });
  res.json({ ok: true });
});



// GET /api/polls/:pid — Tek anket
router.get('/:pid', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  const member = await Members.findOne(_u.id, poll.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  res.json(poll);
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
  if (poll.createdBy !== _u.id) return res.status(403).json({ error: 'Not your poll' });
  if (poll.closed) return res.status(400).json({ error: 'Closed poll cannot be edited' });

  const totalVotes = poll.options.reduce((s, o) => s + (o.votes?.length || 0), 0);

  const { question, options, duration, allowVoteChange } = req.body as { question?: unknown; options?: unknown; duration?: unknown; allowVoteChange?: unknown };
  const updates: Record<string, unknown> = {};

  if (question !== undefined) {
    if (!String(question).trim()) return res.status(400).json({ error: 'Question cannot be empty' });
    updates.question = String(question).trim().slice(0, 300);
  }

  if (options !== undefined) {
    if (totalVotes > 0) return res.status(409).json({ error: 'Cannot change options after votes have been cast' });
    if (!Array.isArray(options) || options.length < 2 || options.length > 10)
      return res.status(400).json({ error: 'Need 2-10 options' });
    updates.options = options.map((o, i) => ({
      id: String(i),
      text: String(o).trim().slice(0, 100),
      votes: [] as string[],
    }));
  }

  if (duration !== undefined) {
    updates.expiresAt = duration ? Date.now() + Number(duration) * 60 * 1000 : null;
  }

  if (allowVoteChange !== undefined) {
    updates.allowVoteChange = !!allowVoteChange;
  }

  await Polls.update(poll._id, updates);
  const updated = await Polls.findById(poll._id);
  res.json(updated);
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
  const poll = await Polls.findById(String(req.params.pid ?? ''));
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });
  if (poll.expiresAt && Date.now() > poll.expiresAt) return res.status(400).json({ error: 'Poll expired' });
  if (!poll.allowVoteChange) return res.status(403).json({ error: 'Vote change not allowed for this poll' });

  const member = await Members.findOne(_u.id, poll.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  // Remove user from all options
  for (const opt of poll.options) {
    opt.votes = opt.votes.filter((v: string) => v !== _u.id);
  }
  await Polls.update(poll._id, { options: poll.options });
  const updated = await Polls.findById(poll._id);
  res.json(updated);
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

  const member = await Members.findOne(_u.id, poll.serverId);
  const isAdmin = member?.roles?.includes('admin') || member?.isOwner;
  if (poll.createdBy !== _u.id && !isAdmin) return res.status(403).json({ error: 'Forbidden' });

  await Polls.delete(poll._id);
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
