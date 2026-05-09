// server/routes/polls.js
const express = require('express');
const router  = express.Router();
const { Polls, Channels, Members } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit');

// POST /api/channels/:cid/polls
router.post('/:cid/polls', authMiddleware, limits.polls(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { question, options, multiSelect = false, duration } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'Question required' });
  if (!Array.isArray(options) || options.length < 2 || options.length > 10)
    return res.status(400).json({ error: 'Need 2-10 options' });

  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await Members.findOne(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const expiresAt = duration ? Date.now() + duration * 60 * 1000 : null;
  const poll = await Polls.insert({
    channelId:   req.params.cid,
    serverId:    channel.serverId,
    createdBy:   _u.id,
    question:    question.trim().slice(0, 300),
    options:     options.map((o, i) => ({ id: String(i), text: String(o).trim().slice(0, 100), votes: [] })),
    multiSelect: !!multiSelect,
    expiresAt,
    closed:      false,
  });
  res.json(poll);
}));

// GET /api/channels/:cid/polls
router.get('/:cid/polls', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await Members.findOne(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const polls = await Polls.findByChannel(req.params.cid);
  res.json(polls);
}));

// POST /api/polls/:pid/vote
router.post('/:pid/vote', authMiddleware, limits.polls(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { optionIds } = req.body;
  if (!Array.isArray(optionIds) || !optionIds.length) return res.status(400).json({ error: 'optionIds required' });

  const poll = await Polls.findById(req.params.pid);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.closed) return res.status(400).json({ error: 'Poll is closed' });
  if (poll.expiresAt && Date.now() > poll.expiresAt) return res.status(400).json({ error: 'Poll expired' });

  const member = await Members.findOne(_u.id, poll.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!poll.multiSelect && optionIds.length > 1) return res.status(400).json({ error: 'Single choice only' });

  for (const opt of poll.options) opt.votes = opt.votes.filter(v => v !== _u.id);
  for (const oid of optionIds) {
    const opt = poll.options.find(o => o.id === String(oid));
    if (opt && !opt.votes.includes(_u.id)) opt.votes.push(_u.id);
  }

  await Polls.update(poll._id, { options: poll.options });
  const updated = await Polls.findById(poll._id);
  res.json(updated);
}));

// POST /api/polls/:pid/close
router.post('/:pid/close', authMiddleware, limits.polls(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const poll = await Polls.findById(req.params.pid);
  if (!poll) return res.status(404).json({ error: 'Poll not found' });
  if (poll.createdBy !== _u.id) return res.status(403).json({ error: 'Not your poll' });
  await Polls.update(poll._id, { closed: true });
  res.json({ ok: true });
}));

module.exports = router;
export {};
