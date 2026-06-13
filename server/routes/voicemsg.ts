/**
 * @openapi
 * tags:
 *   - name: VoiceMsg
 *     description: VoiceMsg API endpoints

 *
 * /voicemsg:
 *   post:
 *     tags: [Messages]
 *     summary: Sesli mesaj yükle ve transkripsiyon başlat
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:      { type: string, format: binary, description: 'WebM/OGG ses dosyası' }
 *               channelId: { type: string }
 *               duration:  { type: integer, description: 'Saniye cinsinden süre' }
 *     responses:
 *       201:
 *         description: Sesli mesaj yüklendi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 url:          { type: string }
 *                 duration:     { type: integer }
 *                 transcriptId: { type: string }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /voicemsg/{vmId}/transcript:
 *   get:
 *     tags: [Messages]
 *     summary: Sesli mesaj transkripsiyonunu getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: vmId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transkripsiyon metni
 *       202:
 *         description: Transkripsiyon henüz hazır değil
 *       404: { $ref: '#/components/responses/NotFound' }
 */

// server/routes/voicemsg.ts — Voice Messages + AI Transcription
// Sprint 73: CDN entegrasyonu — getStorageAdapter() ile local/S3/R2/MinIO/B2 desteği
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import FormData from 'form-data';
import { Members, Messages, VoiceMessages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import logger from '../lib/logger';
import { limits } from '../middleware/rateLimit';
import { getStorageAdapter } from '../lib/storageAdapter';

// ── AI TRANSKRİPSİYON ─────────────────────────────────────────
async function transcribeAudio(filePath: string): Promise<string | null> {
  const GROQ_KEY   = process.env.GROQ_API_KEY;
  const OPENAI_KEY = process.env.OPENAI_API_KEY;

  if (!GROQ_KEY && !OPENAI_KEY) return null;

  const fileBuffer = fs.readFileSync(filePath);
  const fileName   = path.basename(filePath);

  const form = new FormData();
  form.append('file', fileBuffer, { filename: fileName, contentType: 'audio/webm' });
  form.append('model', GROQ_KEY ? 'whisper-large-v3-turbo' : 'whisper-1');
  form.append('response_format', 'text');

  const apiUrl = GROQ_KEY
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const apiKey = GROQ_KEY || OPENAI_KEY;

  try {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
      body: form as any,
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) {
      logger.warn({ status: r.status, event: 'transcription.api.http_error' }, '[Transcription] API hata');
      return null;
    }
    const text = (await r.text()).trim();
    return text || null;
  } catch (_err) { const err = _err as Error;
    logger.warn({ err, event: 'transcription.error' }, '[Transcription] Hata');
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

router.post('/', authMiddleware, limits.upload(), upload.single('audio'), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  const { channelId, serverId, duration } = req.body as Record<string, string>;
  if (!channelId || !serverId) return res.status(400).json({ error: 'channelId and serverId required' });
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  // CDN'e yükle (local modda sadece /uploads/<filename> döner)
  const store    = getStorageAdapter();
  const cdnKey   = `uploads/${req.file.filename}`;
  const result   = await store.uploadFile(req.file.path, cdnKey, { deleteLocal: false });
  const fileUrl  = result.url;

  const vm = await VoiceMessages.insert({
    _id: uuidv4(), channelId, serverId,
    userId: _u.id, displayName: _u.displayName,
    avatarColor: _u.avatarColor || '#2d9cdb',
    fileUrl, duration: parseInt(duration) || 0, createdAt: Date.now(),
  });

  const msg = await Messages.create({
    _id: uuidv4(), channelId, serverId,
    userId: _u.id, username: _u.username,
    displayName: _u.displayName, avatarColor: _u.avatarColor || '#2d9cdb',
    content: '', type: 'voice_message',
    fileUrl, fileName: req.file.filename, fileType: 'audio/webm',
    reactions: {}, createdAt: Date.now(),
  });

  res.json({ ok: true, msg, vmId: vm._id });

  setImmediate(async () => {
    // Transkripsiyon için dosya hâlâ diskte (deleteLocal: false)
    // Remote provider'da yükleme sonrası yerel kopyayı temizle
    if (result.provider !== 'local') {
      fs.unlink(req.file!.path, () => {});
    }

    try {
      const transcript = await transcribeAudio(req.file!.path);
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
    } catch (_err) { const err = _err as Error;
      logger.warn({ err, event: 'transcription.background.error' }, '[Transcription] Arka plan hatası');
    }
  });
});

router.get('/:vmId/transcript', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const vm = await VoiceMessages.findOne({ _id: String(req.params.vmId ?? '') });
  if (!vm) return res.status(404).json({ error: 'Voice message not found' });
  const member = await Members.findOne(_u.id, vm.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!vm.transcript) return res.json({ transcript: null, status: 'pending' });
  res.json({ transcript: vm.transcript, status: 'done' });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
