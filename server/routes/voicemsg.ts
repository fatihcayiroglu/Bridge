// server/routes/voicemsg.js — Voice Messages + AI Transcription
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { Members, Messages, VoiceMessages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// ── AI TRANSKRİPSİYON ─────────────────────────────────────────
async function transcribeAudio(filePath) {
  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;

  if (!GROQ_KEY && !OPENAI_KEY) return null;

  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = path.basename(filePath);

  const form = new (require('form-data'))();
  form.append('file', fileBuffer, { filename: fileName, contentType: 'audio/webm' });
  form.append('model', GROQ_KEY ? 'whisper-large-v3-turbo' : 'whisper-1');
  form.append('response_format', 'text');

  const apiUrl = GROQ_KEY
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const apiKey = GROQ_KEY || OPENAI_KEY;

  try {
    const fetch = globalThis.fetch;
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
      body: form,
    });
    if (!r.ok) {
      console.warn(`[Transcription] API hata ${r.status}`);
      return null;
    }
    const text = (await r.text()).trim();
    return text || null;
  } catch (err) {
    console.warn('[Transcription] Hata:', err.message);
    return null;
  }
}

const UPLOAD_DIR = path.join(__dirname, '../../uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `vm_${Date.now()}_${uuidv4().slice(0, 8)}.webm`),
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB max

router.post('/', authMiddleware, limits.upload(), upload.single('audio'), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  const { channelId, serverId, duration } = req.body;
  if (!channelId || !serverId) return res.status(400).json({ error: 'channelId and serverId required' });
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const fileUrl = `/uploads/${req.file.filename}`;
  const vm = await VoiceMessages.insert({
    _id: uuidv4(), channelId, serverId,
    userId: _u.id, displayName: _u.displayName,
    avatarColor: _u.avatarColor || '#5865f2',
    fileUrl, duration: parseInt(duration) || 0, createdAt: Date.now(),
  });

  const msg = await Messages.create({
    _id: uuidv4(), channelId, serverId,
    userId: _u.id, username: _u.username,
    displayName: _u.displayName, avatarColor: _u.avatarColor || '#5865f2',
    content: '', type: 'voice_message',
    fileUrl, fileName: req.file.filename, fileType: 'audio/webm',
    reactions: {}, createdAt: Date.now(),
  });

  res.json({ ok: true, msg, vmId: vm._id });

  setImmediate(async () => {
    try {
      const transcript = await transcribeAudio(req.file.path);
      if (transcript) {
        await VoiceMessages.update({ _id: vm._id }, { $set: { transcript } });
        await Messages.update(msg._id, { transcript });
        const io = req.app.get('io'); if (io) {
          io.to(channelId).emit('message:transcript', {
            messageId: msg._id,
            transcript,
          });
        }
      }
    } catch (err) {
      console.warn('[Transcription] Arka plan hatası:', err.message);
    }
  });
}));

router.get('/:vmId/transcript', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const vm = await VoiceMessages.findOne({ _id: req.params.vmId });
  if (!vm) return res.status(404).json({ error: 'Voice message not found' });
  const member = await Members.findOne(_u.id, vm.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!vm.transcript) return res.json({ transcript: null, status: 'pending' });
  res.json({ transcript: vm.transcript, status: 'done' });
}));

module.exports = router;
export {};
